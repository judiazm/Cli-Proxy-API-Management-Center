import { describe, expect, test } from 'bun:test';
import {
  FORECAST_MAX_AGE_MS,
  FORECAST_MIN_ELAPSED_MS,
  buildClaudeQuotaForecast,
  buildCodexQuotaForecast,
  buildForecastUsageMetrics,
  firstUsageInstantMs,
  isQuotaAtRisk,
  startOfLocalWeek,
  type ForecastHistoryContext,
} from '@/features/quotaForecast/forecast';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import type { QuotaObservation, UsageMetrics, UsageSummaryResponse } from '@/services/api';

test('risk summary includes exhausted accounts and does not treat unknown accounts as safe', () => {
  expect(isQuotaAtRisk({ outcome: 'exhausted' })).toBe(true);
  expect(isQuotaAtRisk({ outcome: 'before-reset' })).toBe(true);
  expect(isQuotaAtRisk({ outcome: 'lasts-to-reset' })).toBe(false);
  expect(isQuotaAtRisk({ outcome: 'unknown' })).toBe(false);
});

const HOUR_MS = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 14, 16);
const RESET = NOW + 5 * 24 * HOUR_MS;
const quota = (usedPercent = 50, resetAtMs = RESET): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent,
      resetLabel: '',
      resetAtMs,
      periodHours: 168,
    },
  ],
});
const observation = (
  used: number,
  time = NOW,
  changes: Partial<QuotaObservation> = {}
): QuotaObservation => ({
  id: time,
  provider: 'codex',
  auth_id: 'a.json',
  auth_index: 'identity-a',
  window_id: 'weekly',
  observed_at_ms: time,
  used_percent: used,
  reset_at_ms: RESET,
  period_hours: 168,
  source: 'passive-response',
  ...changes,
});
const context = (
  rows: QuotaObservation[] = [
    observation(40, NOW - HOUR_MS),
    observation(45, NOW - HOUR_MS / 2),
    observation(50),
  ]
): ForecastHistoryContext => ({
  authId: 'a.json',
  authIndex: 'identity-a',
  history: { rows, truncated: false },
  state: 'ready',
});

describe('observed weekly quota forecast', () => {
  test('uses measured quota growth rather than assuming use began at the cycle start', () => {
    const result = buildCodexQuotaForecast(quota(), NOW, context());
    expect(result.confidence).toBe('estimated');
    expect(result.quality).toBe('low');
    expect(result.outcome).toBe('before-reset');
    expect(result.exhaustAtMs).toBe(NOW + 5 * HOUR_MS);
    expect(result.ratePercentPerDay).toBe(240);
    expect(result.sampleCount).toBe(3);
    expect(result.sampleSpanMs).toBe(HOUR_MS);
    expect(result.observedAtMs).toBe(NOW);
  });

  test('a low observed rate can last through reset', () => {
    const rows = [
      observation(8, NOW - 24 * HOUR_MS),
      observation(9, NOW - 12 * HOUR_MS),
      observation(10),
    ];
    expect(buildCodexQuotaForecast(quota(10), NOW, context(rows)).outcome).toBe('lasts-to-reset');
  });

  test('labels longer consistent coverage as moderate, never a calibrated probability', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      observation(20 + i * 2, NOW - (6 - i) * HOUR_MS)
    );
    const result = buildCodexQuotaForecast(quota(32), NOW, context(rows));
    expect(result.quality).toBe('moderate');
  });

  test('flat intervals and bursts retain low confidence', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      observation(i === 6 ? 50 : 20, NOW - (6 - i) * HOUR_MS)
    );
    expect(buildCodexQuotaForecast(quota(), NOW, context(rows)).quality).toBe('low');
  });

  test('unknown states preserve history absence, errors, disabled storage and truncation', () => {
    expect(buildCodexQuotaForecast(quota(), NOW).reason).toBe('history-building');
    for (const state of ['disabled', 'error'] as const) {
      expect(buildCodexQuotaForecast(quota(), NOW, { ...context(), state }).reason).toBe(
        'history-unavailable'
      );
    }
    const truncated = context();
    truncated.history!.truncated = true;
    expect(buildCodexQuotaForecast(quota(), NOW, truncated).reason).toBe('history-truncated');
  });

  test('lossy or unavailable store diagnostics pause estimates', () => {
    expect(
      buildCodexQuotaForecast(quota(), NOW, { ...context(), diagnostics: 'losses' }).reason
    ).toBe('store-losses');
    expect(
      buildCodexQuotaForecast(quota(), NOW, { ...context(), diagnostics: 'unavailable' }).reason
    ).toBe('history-unavailable');
  });

  test('imported readings remain usable but do not gain moderate confidence', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      observation(20 + i * 2, NOW - (6 - i) * HOUR_MS, { source: 'reset-first-log' })
    );
    const result = buildCodexQuotaForecast(quota(32), NOW, context(rows));
    expect(result.confidence).toBe('estimated');
    expect(result.quality).toBe('low');
    expect(result.includesImportedReadings).toBe(true);
  });

  test('one or two observations, short spans and duplicate instants do not form a forecast', () => {
    for (const rows of [
      [observation(50)],
      [observation(40, NOW - HOUR_MS), observation(50)],
      [observation(40, NOW - 10 * 60_000), observation(45, NOW - 5 * 60_000), observation(50)],
      [observation(40, NOW - HOUR_MS), observation(41, NOW - HOUR_MS), observation(50)],
    ])
      expect(buildCodexQuotaForecast(quota(), NOW, context(rows)).reason).toBe('history-building');
  });

  test('fresh reported exhaustion precedes early-cycle and history-sparsity gates', () => {
    const reset = NOW + 168 * HOUR_MS - FORECAST_MIN_ELAPSED_MS / 2;
    const result = buildCodexQuotaForecast(
      quota(100, reset),
      NOW,
      context([observation(100, NOW, { reset_at_ms: reset })])
    );
    expect(result.outcome).toBe('exhausted');
    expect(result.confidence).toBe('reported');
    expect(result.sampleCount).toBe(1);
  });

  test('exhaustion still requires fresh history and complete diagnostics', () => {
    expect(
      buildCodexQuotaForecast(
        quota(100),
        NOW,
        context([observation(100, NOW - FORECAST_MAX_AGE_MS - 1)])
      ).reason
    ).toBe('stale-reading');
    expect(buildCodexQuotaForecast(quota(100), NOW, { ...context(), state: 'error' }).outcome).toBe(
      'unknown'
    );
  });

  test('stale observations stop forecasting as the UI clock advances', () => {
    const result = buildCodexQuotaForecast(quota(), NOW + FORECAST_MAX_AGE_MS + 1, context());
    expect(result.reason).toBe('stale-reading');
    expect(result.ageMs).toBe(FORECAST_MAX_AGE_MS + 1);
  });

  test('an expired provider reset remains unknown', () => {
    expect(buildCodexQuotaForecast(quota(40, NOW - 1), NOW, context()).reason).toBe('stale-window');
  });

  test('invalid percentages, future observations and invalid periods are unknown', () => {
    expect(buildCodexQuotaForecast(quota(-1), NOW, context()).reason).toBe('invalid-reading');
    for (const changes of [
      { used_percent: NaN },
      { used_percent: 101 },
      { observed_at_ms: NOW + 60_001 },
      { period_hours: 5 },
    ]) {
      expect(
        buildCodexQuotaForecast(quota(), NOW, context([observation(50, NOW, changes)])).reason
      ).toBe('invalid-reading');
    }
    expect(buildCodexQuotaForecast(quota(-1), NOW, context()).remainingPercent).toBeNull();
  });

  test('no consumption and no measurable growth remain explicit unknown states', () => {
    expect(buildCodexQuotaForecast(quota(0), NOW, context([observation(0)])).reason).toBe(
      'no-consumption'
    );
    expect(
      buildCodexQuotaForecast(
        quota(),
        NOW,
        context([
          observation(50, NOW - HOUR_MS),
          observation(50, NOW - HOUR_MS / 2),
          observation(50),
        ])
      ).reason
    ).toBe('no-growth');
  });

  test('reset timestamps and material decreases split history without converting a drop into consumption', () => {
    const old = observation(90, NOW - 2 * HOUR_MS, { reset_at_ms: RESET - 7 * 24 * HOUR_MS });
    // A genuine prior-cycle observation precedes its reset.
    old.observed_at_ms = RESET - 7 * 24 * HOUR_MS - HOUR_MS;
    const next = [
      observation(10, NOW - HOUR_MS),
      observation(15, NOW - HOUR_MS / 2),
      observation(20),
    ];
    const result = buildCodexQuotaForecast(quota(20), NOW, context([old, ...next]));
    expect(result.resetDetected).toBe(true);
    expect(result.sampleCount).toBe(3);
    expect(result.ratePercentPerDay).toBe(240);
    const corrected = [
      observation(50, NOW - HOUR_MS),
      observation(45, NOW - HOUR_MS / 2),
      observation(46),
    ];
    expect(buildCodexQuotaForecast(quota(46), NOW, context(corrected)).reason).toBe(
      'reset-detected'
    );
  });

  test('a newer provider reset needs new recorded history', () => {
    expect(
      buildCodexQuotaForecast(quota(10, RESET + 7 * 24 * HOUR_MS), NOW, context()).reason
    ).toBe('reset-detected');
  });

  test('limits sampling to 24 hours and sorts out-of-order observations', () => {
    const rows = [
      observation(50),
      observation(5, NOW - 48 * HOUR_MS),
      observation(45, NOW - HOUR_MS / 2),
      observation(40, NOW - HOUR_MS),
    ];
    expect(buildCodexQuotaForecast(quota(), NOW, context(rows)).sampleCount).toBe(3);
  });

  test('provider, credential identity, and weekly window cannot contaminate each other', () => {
    const noisy = context();
    noisy.history!.rows.push(
      observation(99, NOW, { auth_index: 'replaced' }),
      observation(99, NOW, { window_id: 'five-hour' }),
      observation(99, NOW, { auth_id: 'b.json' }),
      observation(99, NOW, { provider: 'claude' })
    );
    expect(buildCodexQuotaForecast(quota(), NOW, noisy).usedPercent).toBe(50);
  });
});

describe('Claude weekly forecast', () => {
  const claudeQuota = (): ClaudeQuotaState => ({
    status: 'success',
    windows: [
      {
        id: 'seven-day-opus',
        label: 'Opus limit',
        usedPercent: 90,
        resetLabel: '',
        resetAtMs: RESET,
        periodHours: 168,
      },
      {
        id: 'seven-day',
        label: 'Weekly limit',
        usedPercent: 50,
        resetLabel: '',
        resetAtMs: RESET,
        periodHours: 168,
      },
    ],
  });
  test('uses the account-wide seven-day window and Claude observations', () => {
    const data = context();
    data.history!.rows = data.history!.rows.map((row) => ({
      ...row,
      provider: 'claude',
      window_id: 'seven-day',
    }));
    const result = buildClaudeQuotaForecast(claudeQuota(), NOW, data);
    expect(result.usedPercent).toBe(50);
    expect(result.outcome).toBe('before-reset');
  });
  test('does not substitute a model-scoped limit', () => {
    const quota = claudeQuota();
    quota.windows = quota.windows.filter((window) => window.id !== 'seven-day');
    expect(buildClaudeQuotaForecast(quota, NOW, context()).reason).toBe('weekly-window-missing');
  });
});

const emptyMetrics = (): UsageMetrics => ({
  requests: 0,
  failed: 0,
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cached_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  latency_ms_avg: 0,
  latency_ms_p95: null,
  ttft_ms_avg: 0,
});
const summary = (
  rows: Array<{ authId: string; tokens: number; first?: number }>
): UsageSummaryResponse => ({
  from: new Date(NOW - 7 * 24 * HOUR_MS).toISOString(),
  to: new Date(NOW).toISOString(),
  tz: 'UTC',
  group_by: ['auth_id'],
  totals: emptyMetrics(),
  rows: rows.map(({ authId, tokens, first = NOW - HOUR_MS }) => ({
    ...emptyMetrics(),
    keys: { auth_id: authId },
    requests: 10,
    failed: 2,
    total_tokens: tokens,
    first_at: new Date(first).toISOString(),
    last_at: new Date(NOW).toISOString(),
  })),
});

describe('recorded token context', () => {
  test('uses each account observation span and exposes requests and failures separately', () => {
    const recent = summary([
      { authId: 'a.json', tokens: 2400, first: NOW - 48 * HOUR_MS },
      { authId: 'b.json', tokens: 2400, first: NOW - HOUR_MS },
    ]);
    const metrics = buildForecastUsageMetrics(
      ['a.json', 'b.json'],
      summary([{ authId: 'a.json', tokens: 1200 }]),
      recent
    );
    expect(metrics.get('a.json')?.dailyTokens).toBe(1200);
    expect(metrics.get('b.json')?.dailyTokens).toBe(57600);
    expect(metrics.get('a.json')?.recentRequests).toBe(10);
    expect(metrics.get('a.json')?.recentFailed).toBe(2);
  });
  test('unavailable summaries are unknown instead of zero', () => {
    const value = buildForecastUsageMetrics(['a.json'], null, null).get('a.json');
    expect(value?.currentWeekTokens).toBeNull();
    expect(value?.recentTokens).toBeNull();
    expect(value?.dailyTokens).toBeNull();
    expect(value?.recentRequests).toBeNull();
  });
  test('a successful empty summary is zero use, with no observed daily pace', () => {
    const value = buildForecastUsageMetrics(['a.json'], summary([]), summary([])).get('a.json');
    expect(value?.currentWeekTokens).toBe(0);
    expect(value?.recentTokens).toBe(0);
    expect(value?.dailyTokens).toBeNull();
  });
  test('does not extrapolate a daily pace from less than 30 minutes', () => {
    const recent = summary([
      { authId: 'a.json', tokens: 100, first: NOW - FORECAST_MIN_ELAPSED_MS + 1 },
    ]);
    expect(
      buildForecastUsageMetrics(['a.json'], null, recent).get('a.json')?.dailyTokens
    ).toBeNull();
  });
  test('clamps observation coverage to the queried range', () => {
    const recent = summary([{ authId: 'a.json', tokens: 700, first: NOW - 10 * 24 * HOUR_MS }]);
    expect(buildForecastUsageMetrics(['a.json'], null, recent).get('a.json')?.dailyTokens).toBe(
      100
    );
  });
});
test('firstUsageInstantMs finds the oldest matched account row', () => {
  expect(firstUsageInstantMs(summary([{ authId: 'a.json', tokens: 100 }]))).toBe(NOW - HOUR_MS);
});
test('startOfLocalWeek returns local Monday at midnight', () => {
  const result = new Date(startOfLocalWeek(new Date(2026, 8, 16, 12).getTime()));
  expect(result.getDay()).toBe(1);
  expect(result.getHours()).toBe(0);
  expect(result.getMinutes()).toBe(0);
});
