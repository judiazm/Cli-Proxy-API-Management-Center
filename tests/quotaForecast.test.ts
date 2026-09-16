import { describe, expect, test } from 'bun:test';
import {
  FORECAST_MIN_ELAPSED_MS,
  buildClaudeQuotaForecast,
  buildCodexQuotaForecast,
  buildForecastUsageMetrics,
  firstUsageInstantMs,
  startOfLocalWeek,
} from '@/features/quotaForecast/forecast';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import type { UsageMetrics, UsageSummaryResponse } from '@/services/api';

const HOUR_MS = 60 * 60_000;
const NOW = Date.UTC(2026, 8, 14, 16);

const quota = (usedPercent: number, resetAtMs = NOW + 6 * 24 * HOUR_MS): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent,
      resetLabel: 'Sep 20',
      resetAtMs,
      periodHours: 168,
    },
  ],
});

describe('buildCodexQuotaForecast', () => {
  test('estimates runout before reset from the reported weekly cycle', () => {
    const result = buildCodexQuotaForecast(quota(50, NOW + 5 * 24 * HOUR_MS), NOW);
    expect(result.confidence).toBe('estimated');
    expect(result.outcome).toBe('before-reset');
    expect(result.exhaustAtMs).toBe(NOW + 2 * 24 * HOUR_MS);
  });

  test('reports that current pace lasts through reset', () => {
    const result = buildCodexQuotaForecast(quota(10, NOW + 4 * 24 * HOUR_MS), NOW);
    expect(result.outcome).toBe('lasts-to-reset');
    expect(result.exhaustAtMs).toBeGreaterThan(result.resetAtMs ?? 0);
  });

  test('keeps a sparse new cycle unknown', () => {
    const resetAtMs = NOW + 168 * HOUR_MS - FORECAST_MIN_ELAPSED_MS / 2;
    expect(buildCodexQuotaForecast(quota(2, resetAtMs), NOW).reason).toBe('sparse-window');
  });

  test('keeps zero consumption unknown', () => {
    expect(buildCodexQuotaForecast(quota(0), NOW).reason).toBe('no-consumption');
  });

  test('rejects a stale window', () => {
    expect(buildCodexQuotaForecast(quota(40, NOW - 1), NOW).reason).toBe('stale-window');
  });

  test('rejects a decreasing or otherwise invalid percentage', () => {
    expect(buildCodexQuotaForecast(quota(-1), NOW).reason).toBe('invalid-reading');
  });

  test('treats provider-reported exhaustion as reported, not estimated', () => {
    const result = buildCodexQuotaForecast(quota(100), NOW);
    expect(result.confidence).toBe('reported');
    expect(result.outcome).toBe('exhausted');
  });
});

const claudeQuota = (
  usedPercent: number,
  resetAtMs = NOW + 6 * 24 * HOUR_MS
): ClaudeQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'seven-day-opus',
      label: '7-day Opus limit',
      usedPercent: 90,
      resetLabel: 'Sep 20',
      resetAtMs,
      periodHours: 168,
    },
    {
      id: 'seven-day',
      label: '7-day limit',
      usedPercent,
      resetLabel: 'Sep 20',
      resetAtMs,
      periodHours: 168,
    },
  ],
});

describe('buildClaudeQuotaForecast', () => {
  test('uses the account-wide seven-day window instead of a model-specific limit', () => {
    const result = buildClaudeQuotaForecast(claudeQuota(10, NOW + 4 * 24 * HOUR_MS), NOW);
    expect(result.usedPercent).toBe(10);
    expect(result.outcome).toBe('lasts-to-reset');
  });

  test('reports a missing account-wide window when Claude only returns scoped limits', () => {
    const quota = claudeQuota(10);
    quota.windows = quota.windows.filter((window) => window.id !== 'seven-day');
    expect(buildClaudeQuotaForecast(quota, NOW).reason).toBe('weekly-window-missing');
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

const summary = (rows: Array<{ authId: string; tokens: number }>): UsageSummaryResponse => ({
  from: new Date(NOW - 7 * 24 * HOUR_MS).toISOString(),
  to: new Date(NOW).toISOString(),
  tz: 'UTC',
  group_by: ['auth_id'],
  totals: emptyMetrics(),
  rows: rows.map(({ authId, tokens }) => ({
    ...emptyMetrics(),
    keys: { auth_id: authId },
    total_tokens: tokens,
    first_at: new Date(NOW - HOUR_MS).toISOString(),
    last_at: new Date(NOW).toISOString(),
  })),
});

describe('buildForecastUsageMetrics', () => {
  test('keeps token history separate and uses the observed history length for daily pace', () => {
    const metrics = buildForecastUsageMetrics(
      ['a.json'],
      summary([{ authId: 'a.json', tokens: 1200 }]),
      summary([{ authId: 'a.json', tokens: 2400 }]),
      2 * 24 * HOUR_MS
    ).get('a.json');
    expect(metrics).toEqual({ currentWeekTokens: 1200, recentTokens: 2400, dailyTokens: 1200 });
  });

  test('does not extrapolate a daily pace from less than 30 minutes', () => {
    const metrics = buildForecastUsageMetrics(
      ['a.json'],
      null,
      summary([{ authId: 'a.json', tokens: 100 }]),
      FORECAST_MIN_ELAPSED_MS - 1
    ).get('a.json');
    expect(metrics?.dailyTokens).toBeNull();
  });
});

test('firstUsageInstantMs finds the oldest matched account row', () => {
  const result = firstUsageInstantMs(
    summary([
      { authId: 'a.json', tokens: 100 },
      { authId: 'b.json', tokens: 200 },
    ])
  );
  expect(result).toBe(NOW - HOUR_MS);
});

test('startOfLocalWeek returns local Monday at midnight', () => {
  const result = new Date(startOfLocalWeek(new Date(2026, 8, 16, 12).getTime()));
  expect(result.getDay()).toBe(1);
  expect(result.getHours()).toBe(0);
  expect(result.getMinutes()).toBe(0);
});
