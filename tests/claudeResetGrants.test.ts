import {
  describeResetGrantState,
  selectResetGrant,
} from '../src/features/quota/providers/claude/selectResetGrant';

import { afterEach, describe, expect, test } from 'bun:test';
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
});

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
    expect(call.header?.['User-Agent']).toBe('claude-cli/2.1.280 (external, cli)');
  }
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

test('all grant messages and confirmation are translated in four locales', async () => {
  const locales = await Promise.all(
    ['en', 'zh-CN', 'zh-TW', 'ru'].map(
      async (locale) => (await Bun.file(`src/i18n/locales/${locale}.json`).json()).claude_reset
    )
  );
  for (const locale of locales) {
    expect(Object.keys(locale).sort()).toEqual(Object.keys(locales[0]).sort());
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

test('card selection prefers usable recommendation and has deterministic fallback', () => {
  const base = status();
  const a = { ...base.grants[0], id: 'a' };
  const b = { ...a, id: 'b' };
  const multiple = { ...base, grants: [b, a], nextGrantId: 'b' };
  expect(selectResetGrant(multiple, 0)?.id).toBe('b');
  expect(selectResetGrant({ ...multiple, nextGrantId: null }, 0)?.id).toBe('a');
  expect(selectResetGrant({ ...multiple, grants: [a, { ...b, paused: true }] }, 0)?.id).toBe('a');
  expect(selectResetGrant({ ...multiple, eligible: false }, 0)).toBeUndefined();
  expect(selectResetGrant({ ...multiple, atLimit: false }, 0)).toBeUndefined();
  expect(
    selectResetGrant({ ...multiple, cooldownUntil: new Date(1000).toISOString() }, 0)
  ).toBeUndefined();
  for (const changed of [
    { resetsLeft: 0 },
    { usableNow: false },
    { paused: true },
    { startsAt: new Date(1000).toISOString() },
    { endsAt: new Date(0).toISOString() },
  ]) {
    expect(selectResetGrant({ ...base, grants: [{ ...a, ...changed }] }, 0)).toBeUndefined();
  }
});

test('Claude reset grants are wired into the fork row with masked confirmation names', async () => {
  const row = await Bun.file('src/features/quota/components/QuotaCredentialRow.tsx').text();
  const hook = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
  expect(row).toContain("entry.type === 'claude' && status === 'success'");
  expect(row).toContain("t('claude_reset.remaining')");
  expect(row).toContain('claudeReset.count');
  expect(row).toContain('disabled={claudeReset.blocked}');
  expect(row).toContain('onClick={claudeReset.confirm}');
  expect(row).toContain('resetting || claudeReset.busy');
  expect(row).toContain('displayCredentialLabel(getQuotaDisplayName(file), file.note, showEmails)');
  expect(row).toContain('onRefresh,\n    displayName');
  expect(hook).toContain('name: displayName');
  expect(hook).toContain('showConfirmation({');
  expect(hook).toContain("pending ? 'claude_reset.retry_confirm'");
  expect(hook).not.toContain('<Modal');
  expect(hook).not.toContain('status.grants.map');
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
  const other = await readClaudeResetGrants('a').catch((caught: unknown) => caught);
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
