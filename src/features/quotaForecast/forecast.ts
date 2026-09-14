import type { CodexQuotaState, CodexQuotaWindow } from '@/types';
import type { UsageSummaryResponse } from '@/services/api';

export const FORECAST_MIN_ELAPSED_MS = 30 * 60_000;
export const WEEK_MS = 7 * 24 * 60 * 60_000;

export type ForecastConfidence = 'reported' | 'estimated' | 'unknown';
export type ForecastOutcome = 'exhausted' | 'before-reset' | 'lasts-to-reset' | 'unknown';

export interface CodexQuotaForecast {
  confidence: ForecastConfidence;
  outcome: ForecastOutcome;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  exhaustAtMs: number | null;
  reason:
    | 'none'
    | 'quota-not-loaded'
    | 'weekly-window-missing'
    | 'stale-window'
    | 'sparse-window'
    | 'no-consumption'
    | 'invalid-reading';
}

export interface ForecastUsageMetric {
  currentWeekTokens: number;
  recentTokens: number;
  dailyTokens: number | null;
}

const unknownForecast = (
  reason: CodexQuotaForecast['reason'],
  window?: CodexQuotaWindow
): CodexQuotaForecast => ({
  confidence: 'unknown',
  outcome: 'unknown',
  usedPercent: window?.usedPercent ?? null,
  remainingPercent:
    window?.usedPercent === null || window?.usedPercent === undefined
      ? null
      : Math.max(0, 100 - window.usedPercent),
  resetAtMs: window?.resetAtMs ?? null,
  exhaustAtMs: null,
  reason,
});

/** The account-wide weekly window. Model-specific and code-review windows are separate limits. */
export const findCodexWeeklyWindow = (
  quota: CodexQuotaState | undefined
): CodexQuotaWindow | null => {
  if (!quota || quota.status !== 'success') return null;
  return (
    quota.windows.find((window) => window.id === 'weekly') ??
    quota.windows.find(
      (window) => window.periodHours === 168 && window.labelKey === 'codex_quota.secondary_window'
    ) ??
    null
  );
};

export const firstUsageInstantMs = (summary: UsageSummaryResponse | null): number | null => {
  let firstMs = Infinity;
  for (const row of summary?.rows ?? []) {
    const parsed = Date.parse(row.first_at);
    if (!Number.isNaN(parsed)) firstMs = Math.min(firstMs, parsed);
  }
  return Number.isFinite(firstMs) ? firstMs : null;
};

/**
 * Estimate runout from the provider's own weekly percentage and elapsed cycle time.
 * Token history remains context only because provider quota units are not a token limit.
 */
export const buildCodexQuotaForecast = (
  quota: CodexQuotaState | undefined,
  nowMs: number
): CodexQuotaForecast => {
  if (!quota || quota.status !== 'success') return unknownForecast('quota-not-loaded');
  const window = findCodexWeeklyWindow(quota);
  if (!window) return unknownForecast('weekly-window-missing');

  const used = window.usedPercent;
  const resetAtMs = window.resetAtMs;
  const periodHours = window.periodHours;
  if (
    used === null ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    typeof resetAtMs !== 'number' ||
    !Number.isFinite(resetAtMs) ||
    typeof periodHours !== 'number' ||
    !Number.isFinite(periodHours) ||
    periodHours <= 0
  ) {
    return unknownForecast('invalid-reading', window);
  }
  if (resetAtMs <= nowMs) return unknownForecast('stale-window', window);

  const cycleStartMs = resetAtMs - periodHours * 60 * 60_000;
  const elapsedMs = nowMs - cycleStartMs;
  if (elapsedMs < FORECAST_MIN_ELAPSED_MS) {
    return unknownForecast('sparse-window', window);
  }
  if (used < 1) return unknownForecast('no-consumption', window);

  const remainingPercent = Math.max(0, 100 - used);
  if (remainingPercent === 0) {
    return {
      confidence: 'reported',
      outcome: 'exhausted',
      usedPercent: used,
      remainingPercent,
      resetAtMs,
      exhaustAtMs: nowMs,
      reason: 'none',
    };
  }

  const exhaustAtMs = nowMs + (elapsedMs * remainingPercent) / used;
  return {
    confidence: 'estimated',
    outcome: exhaustAtMs < resetAtMs ? 'before-reset' : 'lasts-to-reset',
    usedPercent: used,
    remainingPercent,
    resetAtMs,
    exhaustAtMs,
    reason: 'none',
  };
};

const tokensByAuthId = (summary: UsageSummaryResponse | null): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const row of summary?.rows ?? []) {
    const authId = row.keys.auth_id;
    if (!authId) continue;
    totals.set(authId, (totals.get(authId) ?? 0) + Math.max(0, row.total_tokens));
  }
  return totals;
};

export const buildForecastUsageMetrics = (
  authIds: readonly string[],
  currentWeek: UsageSummaryResponse | null,
  recent: UsageSummaryResponse | null,
  observedRecentMs: number
): Map<string, ForecastUsageMetric> => {
  const weekByAuth = tokensByAuthId(currentWeek);
  const recentByAuth = tokensByAuthId(recent);
  const observedDays =
    observedRecentMs >= FORECAST_MIN_ELAPSED_MS ? observedRecentMs / 86_400_000 : 0;
  return new Map(
    authIds.map((authId) => {
      const recentTokens = recentByAuth.get(authId) ?? 0;
      return [
        authId,
        {
          currentWeekTokens: weekByAuth.get(authId) ?? 0,
          recentTokens,
          dailyTokens: observedDays > 0 ? recentTokens / observedDays : null,
        },
      ];
    })
  );
};

export const startOfLocalWeek = (nowMs: number): number => {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date.getTime();
};
