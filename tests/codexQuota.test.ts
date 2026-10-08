import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  CODEX_CONFIG,
  buildCodexQuotaWindows,
  normalizeCodexAccountCredits,
  parseCodexResetOutcome,
} from '@/features/quota/providers/codex/data';
import type { CodexQuotaState, CodexUsagePayload } from '@/types';
import { apiCallApi, authFilesApi, type ApiCallRequest, type ApiCallResult } from '@/services/api';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_SUBSCRIPTION_URL,
  CODEX_USAGE_URL,
  normalizeCodexResetCreditsPayload,
  parseCodexUsagePayload,
} from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const originalApiCallRequest = apiCallApi.request;
const originalResetCooldown = authFilesApi.resetCooldown;

const result = (statusCode: number, body: unknown = null): ApiCallResult => ({
  statusCode,
  header: {},
  bodyText: body === null ? '' : JSON.stringify(body),
  body,
});

const CURRENT_CODEX_USAGE_PAYLOAD: CodexUsagePayload = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 1,
      limit_window_seconds: 604800,
      reset_after_seconds: 601888,
      reset_at: 1785902974,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 602111,
          reset_at: 1785903197,
        },
        secondary_window: null,
      },
    },
  ],
  rate_limit_reset_credits: {
    available_count: 1,
    applicable_available_count: 0,
  },
};

afterEach(() => {
  apiCallApi.request = originalApiCallRequest;
  authFilesApi.resetCooldown = originalResetCooldown;
});

describe('Codex current usage payload', () => {
  test('parses the proxied JSON body and classifies both primary weekly windows', () => {
    const payload = parseCodexUsagePayload(JSON.stringify(CURRENT_CODEX_USAGE_PAYLOAD));
    expect(payload).not.toBeNull();

    const windows = buildCodexQuotaWindows(payload!, t);

    expect(windows.map(({ id }) => id)).toEqual(['weekly', 'gpt-5-3-codex-spark-weekly-0']);
    expect(windows.map(({ labelKey }) => labelKey)).toEqual([
      'codex_quota.secondary_window',
      'codex_quota.additional_secondary_window',
    ]);
    expect(windows.map(({ usedPercent }) => usedPercent)).toEqual([1, 0]);
    expect(windows[1]?.labelParams).toEqual({ name: 'GPT-5.3-Codex-Spark' });
  });

  test('shows reset support when total credits remain but none currently apply', () => {
    const summary = normalizeCodexResetCreditsPayload(
      CURRENT_CODEX_USAGE_PAYLOAD.rate_limit_reset_credits
    );

    expect(summary.invalidPayload).toBeFalse();
    expect(summary.availableCount).toBe(1);
    expect(summary.applicableAvailableCount).toBe(0);

    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: summary.availableCount,
      rateLimitResetCreditsApplicableAvailableCount: summary.applicableAvailableCount,
    };
    expect(CODEX_CONFIG.canResetQuota?.(quota)).toBeTrue();
  });

  test('keeps reset support for legacy payloads without applicable count', () => {
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: 1,
    };

    expect(CODEX_CONFIG.canResetQuota?.(quota)).toBeTrue();
  });
});

describe('Codex account credits', () => {
  test('normalizes remaining balance without confusing it with manual resets', () => {
    expect(
      normalizeCodexAccountCredits({ has_credits: false, unlimited: false, balance: '0' })
    ).toEqual({ balance: '0', unlimited: false });
    expect(
      normalizeCodexAccountCredits({ has_credits: true, unlimited: false, balance: ' 12.50 ' })
    ).toEqual({ balance: '12.50', unlimited: false });
    expect(normalizeCodexAccountCredits({ unlimited: true, balance: null })).toEqual({
      balance: null,
      unlimited: true,
    });
    expect(normalizeCodexAccountCredits(null)).toEqual({ balance: null, unlimited: false });
    expect(normalizeCodexAccountCredits({ balance: 'not available' })).toEqual({
      balance: null,
      unlimited: false,
    });
    expect(normalizeCodexAccountCredits({ balance: -1 })).toEqual({
      balance: null,
      unlimited: false,
    });
  });

  test('reads credits from the existing usage request and forwards them into quota state', async () => {
    const requests: ApiCallRequest[] = [];
    apiCallApi.request = async (payload) => {
      requests.push(payload);
      if (payload.url === CODEX_USAGE_URL) {
        return result(200, {
          ...CURRENT_CODEX_USAGE_PAYLOAD,
          credits: { has_credits: true, unlimited: false, balance: '8.75' },
        });
      }
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
        return result(200, { available_count: 1, credits: [] });
      }
      throw new Error(`Unexpected URL: ${payload.url}`);
    };

    const data = await CODEX_CONFIG.fetchQuota(
      { name: 'codex.json', type: 'codex', auth_index: 'codex:1' },
      t
    );
    const state = CODEX_CONFIG.buildSuccessState(data);
    expect(state.creditBalance).toBe('8.75');
    expect(state.creditsUnlimited).toBeFalse();
    expect(state.rateLimitResetCreditsAvailableCount).toBe(1);
    expect(requests.filter((request) => request.url === CODEX_USAGE_URL)).toHaveLength(1);
  });
});

describe('Codex live subscription renewal', () => {
  test('prefers the live active_until and sends the encoded account ID', async () => {
    const requests: ApiCallRequest[] = [];
    apiCallApi.request = async (payload) => {
      requests.push(payload);
      if (payload.url === CODEX_USAGE_URL) return result(200, CURRENT_CODEX_USAGE_PAYLOAD);
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
        return result(200, { available_count: 0, credits: [] });
      }
      if (payload.url.startsWith(CODEX_SUBSCRIPTION_URL)) {
        return result(200, { active_until: '2026-10-03T13:27:01Z' });
      }
      throw new Error(`Unexpected URL: ${payload.url}`);
    };

    const quota = await CODEX_CONFIG.fetchQuota(
      {
        name: 'codex.json',
        type: 'codex',
        auth_index: 'codex:1',
        metadata: { chatgpt_account_id: 'account/id + space' },
        chatgpt_subscription_active_until: '2026-09-03T13:27:01Z',
      },
      t
    );

    expect(quota.subscriptionActiveUntil).toBe('2026-10-03T13:27:01Z');
    const subscriptionRequest = requests.find((request) =>
      request.url.startsWith(CODEX_SUBSCRIPTION_URL)
    );
    expect(subscriptionRequest?.url).toBe(
      `${CODEX_SUBSCRIPTION_URL}?account_id=account%2Fid%20%2B%20space`
    );
    expect(subscriptionRequest?.authIndex).toBe('codex:1');
    expect(subscriptionRequest?.header?.Authorization).toBe('Bearer $TOKEN$');
    expect(subscriptionRequest?.header?.['Chatgpt-Account-Id']).toBe('account/id + space');
  });

  test('falls back to the credential date when the subscription probe fails', async () => {
    apiCallApi.request = async (payload) => {
      if (payload.url === CODEX_USAGE_URL) return result(200, CURRENT_CODEX_USAGE_PAYLOAD);
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
        return result(200, { available_count: 0, credits: [] });
      }
      if (payload.url.startsWith(CODEX_SUBSCRIPTION_URL)) {
        return result(503, { error: 'temporarily unavailable' });
      }
      throw new Error(`Unexpected URL: ${payload.url}`);
    };

    const quota = await CODEX_CONFIG.fetchQuota(
      {
        name: 'codex.json',
        type: 'codex',
        auth_index: 'codex:2',
        chatgpt_account_id: 'account-2',
        chatgpt_subscription_active_until: '2026-09-03T13:27:01Z',
      },
      t
    );

    expect(quota.subscriptionActiveUntil).toBe('2026-09-03T13:27:01Z');
  });
});

describe('Codex reset consume outcomes', () => {
  const file = { name: 'codex.json', type: 'codex', auth_index: 'codex:1' };
  const mockConsume = (consumeBody: unknown) => {
    const urls: string[] = [];
    authFilesApi.resetCooldown = async (authIndex) => ({
      status: 'ok',
      auth_index: authIndex,
      models: [],
    });
    apiCallApi.request = async (payload) => {
      urls.push(payload.url);
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
        return result(200, consumeBody);
      }
      if (payload.url === CODEX_USAGE_URL) return result(200, CURRENT_CODEX_USAGE_PAYLOAD);
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
        return result(200, { available_count: 1, credits: [] });
      }
      if (payload.url.startsWith(CODEX_SUBSCRIPTION_URL)) return result(200, {});
      throw new Error(`Unexpected URL: ${payload.url}`);
    };
    return urls;
  };

  test('only reset and already_redeemed count as success and refresh the quota', async () => {
    for (const code of ['reset', 'already_redeemed']) {
      const urls = mockConsume({ code, windows_reset: 2 });
      const data = await CODEX_CONFIG.resetQuota!(file, t);
      expect(data.windows.length).toBeGreaterThan(0);
      expect(urls).toContain(CODEX_USAGE_URL);
    }
  });

  test('a 200 that did not spend a reset is reported, not shown as success', async () => {
    for (const [body, key] of [
      [
        { code: 'nothing_to_reset', windows_reset: 0 },
        'codex_quota.reset_outcome_nothing_to_reset',
      ],
      [{ code: 'no_credit' }, 'codex_quota.reset_outcome_no_credit'],
      [{ status: 'ok' }, 'codex_quota.reset_outcome_unknown'],
      [null, 'codex_quota.reset_outcome_unknown'],
    ] as const) {
      const urls = mockConsume(body);
      await expect(CODEX_CONFIG.resetQuota!(file, t)).rejects.toThrow(key);
      expect(urls).toEqual([CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL]);
    }
  });

  test('parses string and object bodies and rejects unknown codes', () => {
    expect(parseCodexResetOutcome('{"code":"reset","windows_reset":2}')).toBe('reset');
    expect(parseCodexResetOutcome({ code: 'nothing_to_reset' })).toBe('nothing_to_reset');
    expect(parseCodexResetOutcome({ code: 'RESET' })).toBeNull();
    expect(parseCodexResetOutcome('not json')).toBeNull();
    expect(parseCodexResetOutcome([])).toBeNull();
  });

  test('every outcome message exists in all four locales', async () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const codex = (await Bun.file(`src/i18n/locales/${locale}.json`).json()).codex_quota;
      for (const key of ['nothing_to_reset', 'no_credit', 'unknown']) {
        expect(typeof codex[`reset_outcome_${key}`]).toBe('string');
      }
    }
  });
});
