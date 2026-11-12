import {
  describeResetGrantState,
  selectResetGrant,
} from '../src/features/quota/providers/claude/selectResetGrant';
import {
  canChooseResetGrant,
  resetGrantKind,
} from '../src/features/quota/providers/claude/resetGrantChoice';

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  claudeReadThrottledUntil,
  newestClaudeCliUserAgent,
  noteClaudeReadThrottle,
  resetClaudeClientState,
} from '../src/services/api/claudeClient';
import { usageStoreApi } from '../src/services/api/usageStore';
import type { AxiosInstance } from 'axios';
import { apiClient } from '../src/services/api/client';
import { authFilesApi } from '../src/services/api/authFiles';
import {
  anthropicResetGrantBlocker,
  claimClaudeResetGrant,
  claimClaudeResetGrantDetailed,
  parseAnthropicResetGrantStatus,
  readClaudeOrganization,
  readClaudeResetGrants,
  AnthropicResetGrantError,
  AnthropicResetGrantUnknownOutcome,
  ANTHROPIC_RESET_RESULTS,
  ANTHROPIC_RESET_REQUEST_ID_RE,
  type AnthropicResetSettledCode,
} from '../src/services/api/claudeResetGrants';
import { apiCallApi, type ApiCallRequest } from '../src/services/api/apiCall';
import {
  createResetGrantOperations,
  createResetRequestId,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
  RETRY_WINDOW_MS,
  STATUS_FRESH_MS,
} from '../src/features/quota/providers/claude/resetGrantOperations';

const organization = '11111111-2222-3333-4444-555555555555';
const grant = { id: 'test-grant', resets_total: 2, resets_left: 2, usable_now: true };
const block = { eligible: true, at_limit: true, grants: [grant] };
const status = () => parseAnthropicResetGrantStatus(block)!;
const originalRequest = apiCallApi.request;
afterEach(() => {
  apiCallApi.request = originalRequest;
  resetClaudeClientState();
});
const seenAgents = (...agents: string[]) =>
  spyOn(usageStoreApi, 'getRequests').mockResolvedValue({
    rows: agents.map((user_agent) => ({ user_agent })),
    next_before: null,
  } as never);

describe('Claude reset grant fail-closed parsing', () => {
  test('valid block and refusing defaults', () => {
    expect(status().grants[0].useRequiresLimit).toBe(true);
    expect(anthropicResetGrantBlocker(status(), grant.id)).toBeNull();
    expect(anthropicResetGrantBlocker({ ...status(), atLimit: false }, grant.id)).toBe(
      'not_limited'
    );
    expect(anthropicResetGrantBlocker({ ...status(), eligible: false }, grant.id)).toBe(
      'ineligible'
    );
    const missing = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...grant, usable_now: undefined }],
    })!;
    expect(anthropicResetGrantBlocker(missing, grant.id)).toBe('not_usable');
  });
  test('rejects malformed blocks and grants', () => {
    for (const value of [
      undefined,
      {},
      { ...block, eligible: 1 },
      { ...block, grants: {} },
      { ...block, grants: [grant, grant] },
      { ...block, cooldown_until: 'bad' },
    ]) {
      expect(parseAnthropicResetGrantStatus(value)).toBeNull();
    }
    for (const fields of [
      { id: '../bad' },
      { resets_left: -1 },
      { resets_left: 3 },
      { resets_total: 1.5 },
      { paused: 'false' },
      { starts_at: 'bad' },
      { clears: {} },
    ]) {
      expect(
        parseAnthropicResetGrantStatus({ ...block, grants: [{ ...grant, ...fields }] })
      ).toBeNull();
    }
  });
});

test('exact proxied GET/profile/claim contract, no provider token in frontend', async () => {
  const agents = seenAgents('claude-cli/2.1.301 (external, cli)');
  const calls: ApiCallRequest[] = [];
  apiCallApi.request = async (request) => {
    calls.push(request);
    const body =
      request.method === 'POST'
        ? { result: 'reset' }
        : request.url.endsWith('profile')
          ? { organization: { uuid: organization } }
          : { cedar_ember: block };
    return { statusCode: 200, body, bodyText: '', header: {} };
  };
  await readClaudeResetGrants('index');
  expect(await readClaudeOrganization('index')).toBe(organization);
  expect(await claimClaudeResetGrant('index', organization, grant.id, 'request-1')).toBe('reset');
  expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1');
  expect(calls[1].url).toBe('https://api.anthropic.com/api/oauth/profile');
  expect(calls[2].url).toBe(
    `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`
  );
  expect(JSON.parse(calls[2].data!)).toEqual({
    program: 'cedar_ember',
    grant_id: grant.id,
    request_id: 'request-1',
  });
  for (const call of calls) {
    expect(call.authIndex).toBe('index');
    expect(call.header?.Authorization).toBe('Bearer $TOKEN$');
    expect(call.header?.['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(call.header?.['User-Agent']).toBe('claude-cli/2.1.301 (external, cli)');
  }
  agents.mockRestore();
});

test('claim terminal mappings and ambiguous outcomes', async () => {
  for (const result of ANTHROPIC_RESET_RESULTS) {
    apiCallApi.request = async () => ({
      statusCode: 200,
      body: { result },
      bodyText: '',
      header: {},
    });
    expect(await claimClaudeResetGrant('a', organization, grant.id, 'r')).toBe(result);
  }
  for (const [statusCode, code] of [
    [401, 'auth_error'],
    [403, 'auth_error'],
    [429, 'rate_limited'],
  ] as const) {
    apiCallApi.request = async () => ({ statusCode, body: null, bodyText: '', header: {} });
    expect(await claimClaudeResetGrant('a', organization, grant.id, 'r')).toBe(code);
  }
  for (const statusCode of [200, 400, 500]) {
    apiCallApi.request = async () => ({
      statusCode,
      body: { result: 'unexpected' },
      bodyText: '',
      header: {},
    });
    await expect(claimClaudeResetGrant('a', organization, grant.id, 'r')).rejects.toBeInstanceOf(
      AnthropicResetGrantUnknownOutcome
    );
  }
  apiCallApi.request = async () => {
    throw new Error('private upstream detail');
  };
  await expect(claimClaudeResetGrant('a', organization, grant.id, 'r')).rejects.toThrow(
    'outcome is unknown'
  );
});

async function withGlobalCrypto(source: unknown, run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: source });
    await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

function mockDefaultResetRequests(result: 'reset' | 'unknown' = 'reset') {
  const calls: ApiCallRequest[] = [];
  const fullBlock = {
    ...block,
    ineligible_reason: null,
    next_grant_id: grant.id,
    weekly_resets_at: null,
    cooldown_until: null,
    grants: [
      {
        ...grant,
        label: 'Test grant',
        resets_total: 1,
        resets_left: 1,
        starts_at: '2000-01-01T00:00:00Z',
        ends_at: '2099-01-01T00:00:00Z',
        clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
        paused: false,
        use_requires_limit: false,
        percent_used: { five_hour: 0, seven_day: 100, seven_day_overage_included: 0 },
        blocking: [],
        arm: null,
      },
    ],
  };
  apiCallApi.request = async (request) => {
    calls.push(request);
    const body =
      request.method === 'POST'
        ? { result }
        : request.url.endsWith('/profile')
          ? {
              account: { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
              organization: { uuid: organization },
            }
          : { cedar_ember: fullBlock };
    return { statusCode: 200, body, bodyText: '', header: {} };
  };
  return calls;
}

describe('Claude reset grant default request ID integration', () => {
  test('HTTP crypto without randomUUID still dispatches a valid reset claim', async () => {
    using cooldown = spyOn(apiClient, 'post').mockResolvedValue({
      status: 'ok',
      auth_index: 'index',
    });
    const calls = mockDefaultResetRequests();
    let randomCalls = 0;
    await withGlobalCrypto(
      {
        getRandomValues(bytes: Uint8Array) {
          randomCalls++;
          bytes.fill(10);
          return bytes;
        },
      },
      async () => {
        const operations = createResetGrantOperations();
        expect(await operations.run('account', 'index', grant.id)).toEqual({
          code: 'reset',
          reason: null,
          unresolved: false,
          cooldownCleared: true,
        });
        expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
        expect(calls[0].url).toEndWith('/api/oauth/profile');
        expect(calls[1].url).toEndWith('/api/oauth/usage?cedar_ember=1&skip_spend=1');
        expect(calls[2].url).toBe(
          `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`
        );
        const payload = JSON.parse(calls[2].data!);
        expect(payload).toEqual({
          program: 'cedar_ember',
          grant_id: grant.id,
          request_id: '0a'.repeat(16),
        });
        expect(payload.request_id).toMatch(/^[0-9a-f]{32}$/);
        expect(payload.request_id).toMatch(ANTHROPIC_RESET_REQUEST_ID_RE);
        expect(operations.inspect('account')).toMatchObject({
          requestId: payload.request_id,
          code: 'reset',
        });
        expect(randomCalls).toBe(1);
        expect(cooldown).toHaveBeenCalledWith(
          '/routing/cooldown/reset',
          { auth_index: 'index' },
          { expectedConnectionRevision: apiClient.getConnectionRevision() }
        );
      }
    );
  });

  test('HTTP fallback reuses one secure request ID after an unknown claim outcome', async () => {
    const calls = mockDefaultResetRequests('unknown');
    let randomCalls = 0;
    await withGlobalCrypto(
      {
        getRandomValues(bytes: Uint8Array) {
          randomCalls++;
          bytes.fill(randomCalls);
          return bytes;
        },
      },
      async () => {
        const operations = createResetGrantOperations();
        await expect(operations.run('account', 'index', grant.id)).rejects.toBeInstanceOf(
          AnthropicResetGrantUnknownOutcome
        );
        const originalId = operations.inspect('account')?.requestId;
        expect(originalId).toMatch(/^[0-9a-f]{32}$/);
        await expect(operations.run('account', 'index', grant.id)).rejects.toBeInstanceOf(
          AnthropicResetGrantUnknownOutcome
        );
        const posts = calls.filter((call) => call.method === 'POST');
        expect(posts).toHaveLength(2);
        expect(posts.map((call) => JSON.parse(call.data!).request_id)).toEqual([
          originalId,
          originalId,
        ]);
        expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'POST']);
        expect(operations.inspect('account')?.code).toBeUndefined();
        expect(randomCalls).toBe(1);
      }
    );
  });

  test('missing secure randomness prevents spending and journaling without leaving busy state', async () => {
    const calls = mockDefaultResetRequests();
    await withGlobalCrypto({}, async () => {
      const operations = createResetGrantOperations();
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = operations.run('account', 'index', grant.id);
        await expect(result).rejects.toBeInstanceOf(ResetGrantPreflightError);
        await expect(result).rejects.toMatchObject({
          stage: 'request_id',
          reason: 'generation_failed',
        });
        expect(operations.inspect('account')).toBeUndefined();
      }
      expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    });
  });
});

function setup() {
  let revision = 1;
  let now = 100;
  let count = 0;
  const ids: string[] = [];
  const cleared: string[] = [];
  const deps = {
    revision: () => revision,
    now: () => now,
    requestId: () => `request-${++count}`,
    readStatus: async () => status(),
    readOrganization: async () => organization,
    claim: async (
      _auth: string,
      _org: string,
      _grant: string,
      id: string
    ): Promise<AnthropicResetSettledCode> => {
      ids.push(id);
      throw new AnthropicResetGrantUnknownOutcome();
    },
    clearCooldown: async (authIndex: string) => {
      cleared.push(authIndex);
      return true;
    },
  };
  return {
    deps,
    ids,
    cleared,
    nextSession: () => {
      revision++;
    },
    advance: () => {
      now += RETRY_WINDOW_MS;
    },
  };
}

test('confirmed Claude resets clear only the redeemed credential cooldown before returning', async () => {
  for (const code of ['reset', 'already_used'] as const) {
    const h = setup();
    h.deps.claim = async (_auth, _org, _grant, id) => {
      expect(h.cleared).toEqual([]);
      h.ids.push(id);
      return code;
    };
    const operations = createResetGrantOperations(h.deps);
    expect(await operations.run('account', 'credential-a', grant.id)).toEqual({
      code,
      reason: null,
      unresolved: false,
      cooldownCleared: true,
    });
    expect(h.cleared).toEqual(['credential-a']);
    expect(h.ids).toEqual(['request-1']);
    expect(operations.inspect('account')?.code).toBe(code);
  }
});

test('refused or unknown reset outcomes never clear routing cooldowns', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  expect(h.cleared).toEqual([]);
  for (const code of [...ANTHROPIC_RESET_RESULTS, 'auth_error', 'rate_limited'] as const) {
    if (code === 'reset' || code === 'already_used') continue;
    h.deps.claim = async () => code;
    await operations.run('account', 'a', grant.id);
    expect(h.cleared).toEqual([]);
  }
});

test('cooldown clear failures keep the reset settled and report manual recovery', async () => {
  for (const failure of ['network', 'status', 'credential']) {
    const h = setup();
    h.deps.claim = async (_auth, _org, _grant, id) => {
      h.ids.push(id);
      return 'reset';
    };
    h.deps.clearCooldown = async (authIndex) => {
      h.cleared.push(authIndex);
      if (failure === 'network') throw new Error('unavailable');
      return false;
    };
    const operations = createResetGrantOperations(h.deps);
    expect(await operations.run('account', 'a', grant.id)).toEqual({
      code: 'reset',
      reason: null,
      unresolved: false,
      cooldownCleared: false,
    });
    expect(operations.inspect('account')?.code).toBe('reset');
    expect(h.ids).toEqual(['request-1']);
    expect(h.cleared).toEqual(['a']);
  }
});

test('connection changes after a claim prevent cooldown clearing on the replacement connection', async () => {
  const h = setup();
  h.deps.claim = async () => {
    h.nextSession();
    return 'reset';
  };
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(h.cleared).toEqual([]);
  expect(operations.inspect('account')).toBeUndefined();
});

test('a connection change during cooldown clearing cannot report success for the new session', async () => {
  const h = setup();
  h.deps.claim = async () => 'reset';
  h.deps.clearCooldown = async () => {
    h.nextSession();
    return true;
  };
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(operations.inspect('account')).toBeUndefined();
});

test('unknown outcome retains request ID across retries; expiry blocks', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  expect(h.ids).toEqual(['request-1', 'request-1']);
  await expect(operations.run('account', 'a', 'other-grant')).rejects.toThrow('expired');
  h.advance();
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('expired');
  expect(h.ids).toHaveLength(2);
});

test('fresh spend rechecks eligibility and blocks concurrent clicks', async () => {
  const h = setup();
  h.deps.readStatus = async () => ({ ...status(), eligible: false });
  const operations = createResetGrantOperations(h.deps);
  const first = operations.run('account', 'a', grant.id);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('busy');
  await expect(first).rejects.toThrow('blocked');
  expect(h.ids).toHaveLength(0);
});

test('session change during profile read prevents POST and isolates journal', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.nextSession();
  expect(operations.inspect('account')).toBeUndefined();
  h.deps.readOrganization = async () => {
    h.nextSession();
    return organization;
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(h.ids).toHaveLength(1);
});

test('retry binds original organization', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.readOrganization = async () => 'aaaaaaaa-2222-3333-4444-555555555555';
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('identity');
  expect(h.ids).toHaveLength(1);
});

test('a retry refusal keeps the ambiguous original operation open', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.claim = async (_auth, _org, _grant, id) => {
    h.ids.push(id);
    return 'rate_limited';
  };
  expect(await operations.run('account', 'a', grant.id)).toEqual({
    code: 'rate_limited',
    reason: null,
    unresolved: true,
    cooldownCleared: false,
  });
  expect(operations.inspect('account')?.code).toBeUndefined();
  h.deps.claim = async (_auth, _org, _grant, id) => {
    h.ids.push(id);
    return 'already_used';
  };
  expect(await operations.run('account', 'a', grant.id)).toEqual({
    code: 'already_used',
    reason: null,
    unresolved: false,
    cooldownCleared: true,
  });
  expect(h.ids).toEqual(['request-1', 'request-1', 'request-1']);
  expect(h.cleared).toEqual(['a']);
});

test('a spent reset clears the gateway cooldown; a refusal or failed clear does not claim it', async () => {
  const h = setup();
  h.deps.claim = async () => 'reset';
  expect(await createResetGrantOperations(h.deps).run('account', 'a', grant.id)).toEqual({
    code: 'reset',
    reason: null,
    unresolved: false,
    cooldownCleared: true,
  });
  expect(h.cleared).toEqual(['a']);

  h.deps.claim = async () => 'not_limited';
  expect(await createResetGrantOperations(h.deps).run('account', 'a', grant.id)).toEqual({
    code: 'not_limited',
    reason: null,
    unresolved: false,
    cooldownCleared: false,
  });
  expect(h.cleared).toEqual(['a']);

  h.deps.claim = async () => 'reset';
  h.deps.clearCooldown = async () => {
    throw new Error('offline');
  };
  const operations = createResetGrantOperations(h.deps);
  expect(await operations.run('account', 'a', grant.id)).toEqual({
    code: 'reset',
    reason: null,
    unresolved: false,
    cooldownCleared: false,
  });
  expect(operations.inspect('account')?.code).toBe('reset');
});

test('no retry after the deadline expires during profile lookup', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow();
  h.deps.readOrganization = async () => {
    h.advance();
    return organization;
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('expired');
  expect(h.ids).toHaveLength(1);
});

test('date, pause, limit, balance, usability and cooldown gates refuse new spending', async () => {
  for (const fields of [
    { paused: true },
    { resetsLeft: 0 },
    { usableNow: false },
    { startsAt: '2099-01-01T00:00:00Z' },
    { endsAt: '1970-01-01T00:00:00Z' },
  ]) {
    const h = setup();
    h.deps.readStatus = async () => ({
      ...status(),
      grants: [{ ...status().grants[0], ...fields }],
    });
    await expect(createResetGrantOperations(h.deps).run('account', 'a', grant.id)).rejects.toThrow(
      'blocked'
    );
    expect(h.ids).toHaveLength(0);
  }
  for (const fields of [{ atLimit: false }, { cooldownUntil: '2099-01-01T00:00:00Z' }]) {
    const h = setup();
    h.deps.readStatus = async () => ({ ...status(), ...fields });
    await expect(createResetGrantOperations(h.deps).run('account', 'a', grant.id)).rejects.toThrow(
      'blocked'
    );
    expect(h.ids).toHaveLength(0);
  }
});

test('a stale claim answer cannot settle the replacement session operation', async () => {
  const h = setup();
  const operations = createResetGrantOperations(h.deps);
  h.deps.claim = async () => {
    h.nextSession();
    expect(operations.inspect('account')).toBeUndefined();
    return 'reset';
  };
  await expect(operations.run('account', 'a', grant.id)).rejects.toThrow('session');
  expect(operations.inspect('account')).toBeUndefined();
  expect(h.cleared).toEqual([]);
});

test('preflight read failures identify the stage without exposing upstream details', async () => {
  for (const stage of ['organization', 'status'] as const) {
    for (const failure of [new Error('SECRET'), new AnthropicResetGrantError('auth')]) {
      const h = setup();
      const fail = async (): Promise<never> => {
        throw failure;
      };
      if (stage === 'organization') h.deps.readOrganization = fail;
      else h.deps.readStatus = fail;
      const operations = createResetGrantOperations(h.deps);
      try {
        await operations.run('account', 'a', grant.id);
        throw new Error('Expected preflight failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ResetGrantPreflightError);
        expect((error as ResetGrantPreflightError).stage).toBe(stage);
        expect((error as Error).message).not.toContain('SECRET');
        expect(resetGrantFailureMessageKey(error)).toBe(`claude_reset.failure_${stage}`);
      }
      expect(h.ids).toHaveLength(0);
      expect(operations.inspect('account')).toBeUndefined();
    }
  }
  expect(resetGrantFailureMessageKey(new Error('SECRET'))).toBe('claude_reset.blocked');
});

test('request ID generation failure is diagnosed before journaling or dispatch', async () => {
  const h = setup();
  h.deps.requestId = () => {
    throw new Error('crypto unavailable');
  };
  const operations = createResetGrantOperations(h.deps);
  await expect(operations.run('account', 'a', grant.id)).rejects.toMatchObject({
    stage: 'request_id',
    reason: 'generation_failed',
  });
  expect(operations.inspect('account')).toBeUndefined();
  expect(h.ids).toHaveLength(0);
});

test('expiry and cooldown failures have distinct safe diagnostic codes', async () => {
  for (const [fields, reason] of [
    [{ startsAt: '2099-01-01T00:00:00Z' }, 'blocked_not_started'],
    [{ endsAt: '1970-01-01T00:00:00Z' }, 'blocked_grant_expired'],
    [{ paused: true }, 'blocked_paused'],
  ] as const) {
    const h = setup();
    h.deps.readStatus = async () => ({
      ...status(),
      grants: [{ ...status().grants[0], ...fields }],
    });
    await expect(
      createResetGrantOperations(h.deps).run('account', 'a', grant.id)
    ).rejects.toMatchObject({
      stage: 'eligibility',
      reason,
    });
    expect(h.ids).toHaveLength(0);
  }
  const h = setup();
  h.deps.readStatus = async () => ({ ...status(), cooldownUntil: '2099-01-01T00:00:00Z' });
  await expect(
    createResetGrantOperations(h.deps).run('account', 'a', grant.id)
  ).rejects.toMatchObject({
    stage: 'eligibility',
    reason: 'blocked_cooldown',
  });
  expect(h.ids).toHaveLength(0);
});

test('read authentication refusals retain a safe diagnostic code', async () => {
  for (const statusCode of [401, 403]) {
    apiCallApi.request = async () => ({ statusCode, header: {}, body: {}, bodyText: '' });
    await expect(readClaudeOrganization('a')).rejects.toMatchObject({ code: 'auth' });
    await expect(readClaudeResetGrants('a')).rejects.toMatchObject({ code: 'auth' });
  }
});

test('all grant messages and confirmation are translated in six locales', async () => {
  const locales = await Promise.all(
    ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'].map(
      async (locale) => (await Bun.file(`src/i18n/locales/${locale}.json`).json()).claude_reset
    )
  );
  for (const locale of locales) {
    expect(Object.keys(locale).sort()).toEqual(Object.keys(locales[0]).sort());
    for (const stage of ['organization', 'status', 'eligibility', 'request_id', 'operation']) {
      expect(locale[`failure_${stage}`]).toContain('{{code}}');
    }
    expect(locale.confirm_text).toContain('{{name}}');
    expect(locale.retry_confirm).toContain('{{name}}');
    expect(typeof locale.remaining).toBe('string');
    expect(locale.count).toContain('{{left}}');
    for (const key of [
      ...ANTHROPIC_RESET_RESULTS,
      'auth_error',
      'rate_limited',
      'unknown',
      'expired',
    ]) {
      expect(typeof locale[key]).toBe('string');
    }
  }
});

test('card requires an explicit usable grant without recommendation or fallback', () => {
  const base = status();
  const a = { ...base.grants[0], id: 'a' };
  const b = { ...a, id: 'b' };
  const multiple = { ...base, grants: [b, a], nextGrantId: 'b' };
  expect(selectResetGrant(multiple, 0)?.id).toBe('b');
  expect(selectResetGrant({ ...multiple, nextGrantId: null }, 0)?.id).toBe('a');
  expect(selectResetGrant({ ...multiple, grants: [a, { ...b, paused: true }] }, 0)).toBeUndefined();
  expect(selectResetGrant({ ...multiple, eligible: false }, 0)).toBeUndefined();
  expect(selectResetGrant({ ...multiple, atLimit: false }, 0)).toBeUndefined();
  expect(
    selectResetGrant({ ...multiple, cooldownUntil: new Date(1000).toISOString() }, 0)
  ).toBeUndefined();
  for (const id of ['a', 'b']) expect(canChooseResetGrant(multiple, undefined, id, 0)).toBe(true);
  for (const id of [undefined, 'missing', { type: 'click' }, '']) {
    expect(canChooseResetGrant(multiple, undefined, id, 0)).toBe(false);
  }
  for (const changed of [
    { resetsLeft: 0 },
    { usableNow: false },
    { paused: true },
    { startsAt: new Date(1000).toISOString() },
    { endsAt: new Date(0).toISOString() },
  ]) {
    expect(
      canChooseResetGrant({ ...base, grants: [{ ...a, ...changed }] }, undefined, 'a', 0)
    ).toBe(false);
  }
  for (const changed of [
    { eligible: false },
    { atLimit: false },
    { cooldownUntil: new Date(1000).toISOString() },
  ]) {
    expect(canChooseResetGrant({ ...multiple, ...changed }, undefined, 'a', 0)).toBe(false);
  }
  expect(canChooseResetGrant(null, undefined, 'a', 0)).toBe(false);
  expect(canChooseResetGrant(null, 'a', 'a', 0)).toBe(true);
  expect(canChooseResetGrant(multiple, 'a', 'b', 0)).toBe(false);
});

test('the fork row retains masked names and opens the grant dialog', async () => {
  const row = await Bun.file('src/features/quota/components/QuotaCredentialRow.tsx').text();
  const hook = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
  expect(row).toContain("entry.type === 'claude' && status === 'success'");
  expect(row).toContain("t('claude_reset.remaining')");
  expect(row).toContain('claudeReset.count');
  expect(row).toContain('disabled={claudeReset.blocked}');
  expect(row).toContain('onClick={claudeReset.openDialog}');
  expect(row).toContain('resetting || claudeReset.busy');
  expect(row).toContain('displayCredentialLabel(getQuotaDisplayName(file), file.note, showEmails)');
  expect(row).toContain('name={displayName}');
  expect(row).toContain('<ClaudeResetGrantDialog');
  expect(hook).not.toContain('showConfirmation');
  expect(hook).toContain("'claude_reset.read_throttled'");
  expect(hook).toContain('status ? { status, readAt: statusReadAt } : undefined');
});

test('card retains one dialog trigger with explicit selection and no second confirmation', async () => {
  const card = await Bun.file('src/features/quota/components/QuotaCard.tsx').text();
  const hook = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
  const dialog = await Bun.file(
    'src/features/quota/providers/claude/ClaudeResetGrantDialog.tsx'
  ).text();
  expect(card).toContain('quotaClasses.codexPlanValue}>{claudeReset.count');
  expect(card.match(/onClick=\{claudeReset.openDialog\}/g)).toHaveLength(1);
  expect(card).toContain('<ClaudeResetGrantDialog');
  expect(card).not.toContain('onRedeem=');
  expect(hook).not.toContain('showConfirmation');
  expect(hook).not.toContain('selectResetGrant(');
  expect(hook).toContain('setDialog({ key, selected: null })');
  expect(hook).toContain('if (!open || !selected || !canRedeemGrant(selected) || lock.current');
  expect(hook).toContain(
    "if (!current() || useAuthStore.getState().connectionStatus !== 'connected') return"
  );
  expect(dialog).toContain('<Modal');
  expect(dialog).toContain('closeDisabled={props.busy}');
  expect(dialog).toContain('!props.selected || !props.canRedeemGrant(props.selected)');
});

test('the row explains why no grant can be spent', () => {
  const base = status();
  const g = base.grants[0];
  expect(describeResetGrantState(base, 0)).toBeNull();
  expect(describeResetGrantState({ ...base, eligible: false, grants: [] }, 0)).toBe(
    'state_ineligible'
  );
  expect(describeResetGrantState({ ...base, grants: [] }, 0)).toBe('empty');
  expect(describeResetGrantState({ ...base, grants: [{ ...g, resetsLeft: 0 }] }, 0)).toBe(
    'state_spent'
  );
  expect(
    describeResetGrantState(
      { ...base, atLimit: false, grants: [{ ...g, useRequiresLimit: true }] },
      0
    )
  ).toBe('state_waiting_limit');
  expect(describeResetGrantState({ ...base, grants: [{ ...g, usableNow: false }] }, 0)).toBe(
    'unavailable'
  );
  expect(describeResetGrantState({ ...base, cooldownUntil: new Date(1000).toISOString() }, 0)).toBe(
    'cooldown'
  );
  expect(
    describeResetGrantState({ ...base, grants: [{ ...g, endsAt: new Date(0).toISOString() }] }, 1)
  ).toBe('empty');
});

test('a 429 status read is reported as throttled, not as a generic read error', async () => {
  apiCallApi.request = async () => ({ statusCode: 429, header: {}, bodyText: '', body: null });
  const error = await readClaudeResetGrants('a').catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AnthropicResetGrantError);
  expect((error as AnthropicResetGrantError).code).toBe('rate_limited');
  apiCallApi.request = async () => ({ statusCode: 500, header: {}, bodyText: '', body: null });
  // 'a' is now remembered as throttled, so another account shows the generic error.
  const other = await readClaudeResetGrants('b').catch((caught: unknown) => caught);
  expect((other as AnthropicResetGrantError).code).toBe('upstream');
});

test('a claim answer carries a bounded Anthropic reason', async () => {
  for (const [body, reason] of [
    [{ result: 'unavailable', reason: 'not_next_grant' }, 'not_next_grant'],
    [{ result: 'unavailable', reason: '<b>bad</b>' }, null],
    [{ result: 'reset' }, null],
  ] as const) {
    apiCallApi.request = async () => ({ statusCode: 200, body, bodyText: '', header: {} });
    expect(await claimClaudeResetGrantDetailed('a', organization, grant.id, 'r')).toEqual({
      code: body.result,
      reason,
    });
  }
  const h = setup();
  h.deps.claim = async () => ({ code: 'unavailable', reason: 'stamp_indeterminate' });
  expect(await createResetGrantOperations(h.deps).run('account', 'a', grant.id)).toEqual({
    code: 'unavailable',
    reason: 'stamp_indeterminate',
    unresolved: false,
    cooldownCleared: false,
  });
});

test('a fresh row status and a cached organization spare Anthropic reads before the claim', async () => {
  const h = setup();
  let statusReads = 0;
  let profileReads = 0;
  h.deps.readStatus = async () => {
    statusReads++;
    return status();
  };
  h.deps.readOrganization = async () => {
    profileReads++;
    return organization;
  };
  h.deps.claim = async () => 'not_limited';
  const operations = createResetGrantOperations(h.deps);
  const fresh = { status: status(), readAt: h.deps.now() - STATUS_FRESH_MS };
  await operations.run('account', 'a', grant.id, fresh);
  expect([statusReads, profileReads]).toEqual([0, 1]);
  const stale = { status: status(), readAt: h.deps.now() - STATUS_FRESH_MS - 1 };
  await operations.run('account', 'a', grant.id, stale);
  expect([statusReads, profileReads]).toEqual([1, 1]);
  // A fresh status that no longer allows spending is still refused before any POST.
  h.deps.claim = async () => {
    throw new Error('claim must not be sent');
  };
  const spent = { status: { ...status(), eligible: false }, readAt: h.deps.now() };
  await expect(operations.run('account', 'a', grant.id, spent)).rejects.toThrow('blocked');
  h.nextSession();
  h.deps.claim = async () => 'not_limited';
  await operations.run('account', 'a', grant.id, fresh);
  expect(profileReads).toBe(2);
});

test('a throttled read before the claim is reported as throttled and sends nothing', async () => {
  for (const read of ['readStatus', 'readOrganization'] as const) {
    const h = setup();
    let claims = 0;
    h.deps[read] = async () => {
      throw new AnthropicResetGrantError('rate_limited');
    };
    h.deps.claim = async () => {
      claims++;
      return 'reset';
    };
    await expect(createResetGrantOperations(h.deps).run('account', 'a', grant.id)).rejects.toThrow(
      'rate_limited'
    );
    expect(claims).toBe(0);
  }
});

test('request ids do not need randomUUID, which plain-HTTP pages lack', async () => {
  const insecure = {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab),
  } as unknown as Crypto;
  const id = createResetRequestId(insecure);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(id).toMatch(ANTHROPIC_RESET_REQUEST_ID_RE);
  const secure = { randomUUID: () => 'from-random-uuid' } as unknown as Crypto;
  expect(createResetRequestId(secure)).toBe('from-random-uuid');
});

test('a cooldown clear pinned to a revision is refused at dispatch after a switch', async () => {
  const instance = (apiClient as unknown as { instance: AxiosInstance }).instance;
  const adapter = instance.defaults.adapter;
  const sent: string[] = [];
  instance.defaults.adapter = async (config) => {
    sent.push(String(config.url));
    return {
      data: { status: 'ok', auth_index: 'a', models: [] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  try {
    const revision = apiClient.getConnectionRevision();
    await expect(authFilesApi.resetCooldown('a', revision + 1)).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(await authFilesApi.resetCooldown('a', revision)).toMatchObject({ status: 'ok' });
    expect(sent).toEqual(['/routing/cooldown/reset']);
  } finally {
    instance.defaults.adapter = adapter;
  }
});

test('the Claude Code version follows real clients within a plausible range', () => {
  expect(newestClaudeCliUserAgent([])).toBe('claude-cli/2.1.294 (external, cli)');
  expect(
    newestClaudeCliUserAgent([
      'claude-cli/2.1.290 (external, cli)',
      'claude-cli/2.1.301 (external, sdk-cli)',
      'claude-cli/2.2.0 (external, cli)',
      'claude-cli/3.0.1 (external, cli)',
      'claude-cli/2.1.900 (external, cli)',
      'python-requests/2.32',
    ])
  ).toBe('claude-cli/2.1.301 (external, cli)');
});

test('a usage-read 429 is remembered for its Retry-After and not asked again', async () => {
  seenAgents();
  let calls = 0;
  apiCallApi.request = async () => {
    calls++;
    return { statusCode: 429, body: {}, bodyText: '', header: { 'Retry-After': ['120'] } };
  };
  await expect(readClaudeResetGrants('throttled')).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(readClaudeResetGrants('throttled')).rejects.toMatchObject({ code: 'rate_limited' });
  expect(calls).toBe(1);
  const until = claudeReadThrottledUntil('throttled')!;
  expect(until - Date.now()).toBeGreaterThan(110_000);
  expect(claudeReadThrottledUntil('throttled', until + 1)).toBeNull();
  noteClaudeReadThrottle('default', {}, 0);
  expect(claudeReadThrottledUntil('default', 0)).toBe(5 * 60 * 1000);
  noteClaudeReadThrottle('capped', { 'retry-after': ['99999'] }, 0);
  expect(claudeReadThrottledUntil('capped', 0)).toBe(60 * 60 * 1000);
});

test('a claim pinned to its connection is not sent after a switch', async () => {
  seenAgents();
  const instance = (apiClient as unknown as { instance: AxiosInstance }).instance;
  const adapter = instance.defaults.adapter;
  const sent: string[] = [];
  instance.defaults.adapter = async (config) => {
    sent.push(String(config.url));
    return {
      data: { status_code: 200, body: { result: 'reset' } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  try {
    const revision = apiClient.getConnectionRevision();
    await expect(
      claimClaudeResetGrantDetailed('a', organization, grant.id, 'r', revision + 1)
    ).rejects.toThrow('session');
    expect(sent).toEqual([]);
    expect(await claimClaudeResetGrantDetailed('a', organization, grant.id, 'r', revision)).toEqual(
      {
        code: 'reset',
        reason: null,
      }
    );
    expect(sent).toEqual(['/requests/api-call']);
  } finally {
    instance.defaults.adapter = adapter;
  }
});

test('account reads map upstream 429 to a sanitized typed rate-limit failure', async () => {
  let calls = 0;
  apiCallApi.request = async () => {
    calls += 1;
    return { statusCode: 429, body: 'private upstream detail', bodyText: '', header: {} };
  };
  for (const [read, index] of [
    [readClaudeResetGrants, 'status-index'],
    [readClaudeOrganization, 'profile-index'],
  ] as const) {
    await expect(read(index)).rejects.toMatchObject({
      name: 'AnthropicResetGrantError',
      code: 'rate_limited',
      message: 'Anthropic reset-grant read failed (rate_limited)',
    });
  }
  expect(calls).toBe(2); // Neither read retries; each account records its own throttle.
});

describe('explicit reset kinds and model refill usage', () => {
  test('preserves type and weekly give-back without treating it as a full reset', () => {
    for (const type of ['weekly', 'session', 'full']) {
      const parsed = parseAnthropicResetGrantStatus({
        ...block,
        grants: [{ ...grant, type, gives_back_weekly: false }],
      })!;
      expect(resetGrantKind(parsed.grants[0])).toBe(type);
      expect(parsed.grants[0].givesBackWeekly).toBe(false);
    }
    const parsed = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...grant, type: 'full', gives_back_weekly: true }],
    })!;
    expect(resetGrantKind(parsed.grants[0])).toBe('fable');
    expect(resetGrantKind(status().grants[0])).toBe('unknown');
    expect(
      parseAnthropicResetGrantStatus({
        ...block,
        grants: [{ ...grant, gives_back_weekly: 'true' }],
      })
    ).toBeNull();
  });

  test('only known zero usage blocks a model refill, including future model windows', () => {
    for (const [percent_used, blocked] of [
      [{ seven_day_overage_included: 0 }, true],
      [{ seven_day: 0, future_model: 0 }, true],
      [{ seven_day: 0, future_model: 0.5 }, false],
      [{ seven_day: 0, future_model: null }, false],
      [{}, false],
      [undefined, false],
    ] as const) {
      const parsed = parseAnthropicResetGrantStatus({
        ...block,
        grants: [{ ...grant, gives_back_weekly: true, percent_used }],
      })!;
      expect(anthropicResetGrantBlocker(parsed, grant.id)).toBe(blocked ? 'no_usage' : null);
    }
    const weekly = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...grant, type: 'weekly', percent_used: { seven_day: 0 } }],
    })!;
    expect(anthropicResetGrantBlocker(weekly, grant.id)).toBeNull();
  });

  test.each(['weekly-choice', 'model-choice'])(
    'preflight and mock claim spend exactly %s even when another grant is recommended',
    async (chosen) => {
      const calls: ApiCallRequest[] = [];
      const grants = [
        { ...grant, id: 'weekly-choice', type: 'weekly' },
        {
          ...grant,
          id: 'model-choice',
          type: 'full',
          gives_back_weekly: true,
          percent_used: { seven_day_overage_included: 35 },
        },
      ];
      apiCallApi.request = async (request) => {
        calls.push(request);
        return {
          statusCode: 200,
          header: {},
          bodyText: '',
          body:
            request.method === 'POST'
              ? { result: 'reset' }
              : request.url.endsWith('profile')
                ? { organization: { uuid: organization } }
                : { cedar_ember: { ...block, next_grant_id: 'weekly-choice', grants } },
        };
      };
      const operations = createResetGrantOperations({
        ...setup().deps,
        readOrganization: readClaudeOrganization,
        readStatus: readClaudeResetGrants,
        claim: claimClaudeResetGrant,
      });
      expect(calls).toHaveLength(0);
      await operations.run('account', 'index', chosen);
      const posts = calls.filter((call) => call.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0].data!)).toEqual({
        program: 'cedar_ember',
        grant_id: chosen,
        request_id: 'request-1',
      });
    }
  );

  test('fresh preflight refuses a now-empty model refill before any claim', async () => {
    const h = setup();
    h.deps.readStatus = async () =>
      parseAnthropicResetGrantStatus({
        ...block,
        grants: [
          { ...grant, gives_back_weekly: true, percent_used: { seven_day_overage_included: 0 } },
        ],
      })!;
    await expect(
      createResetGrantOperations(h.deps).run('account', 'index', grant.id)
    ).rejects.toMatchObject({ stage: 'eligibility', reason: 'blocked_no_usage' });
    expect(h.ids).toEqual([]);
  });

  test('uncertain model refill retains type and retries the same grant/request after discovery loses it', async () => {
    const h = setup();
    const refill = parseAnthropicResetGrantStatus({
      ...block,
      grants: [{ ...grant, type: 'full', gives_back_weekly: true }],
    })!;
    h.deps.readStatus = async () => refill;
    const claims: string[][] = [];
    h.deps.claim = async (_auth, _org, selected, requestId) => {
      claims.push([selected, requestId]);
      throw new AnthropicResetGrantUnknownOutcome();
    };
    const operations = createResetGrantOperations(h.deps);
    await expect(operations.run('account', 'index', grant.id)).rejects.toThrow();
    const pending = operations.inspect('account')!;
    expect(resetGrantKind(pending.grant)).toBe('fable');
    h.deps.readStatus = async () => ({ ...status(), grants: [] });
    await expect(operations.run('account', 'index', 'another-grant')).rejects.toThrow();
    await expect(operations.run('account', 'index', grant.id)).rejects.toThrow();
    expect(claims).toEqual([
      [grant.id, 'request-1'],
      [grant.id, 'request-1'],
    ]);
  });
});
