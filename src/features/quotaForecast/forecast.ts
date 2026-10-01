import type {
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  CodexQuotaState,
  CodexQuotaWindow,
} from '@/types';
import type { QuotaHistoryResponse, QuotaObservation, UsageSummaryResponse } from '@/services/api';

export const FORECAST_MIN_ELAPSED_MS = 30 * 60_000;
export const FORECAST_MAX_AGE_MS = 30 * 60_000;
export const FORECAST_RECENT_MS = 24 * 60 * 60_000;
export const FORECAST_MIN_SAMPLES = 3;
export const WEEK_MS = 7 * 24 * 60 * 60_000;
const RESET_TOLERANCE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type ForecastConfidence = 'reported' | 'estimated' | 'unknown';
export type ForecastOutcome = 'exhausted' | 'before-reset' | 'lasts-to-reset' | 'unknown';
export type ForecastProvider = 'claude' | 'codex';
export type ForecastQuotaState = ClaudeQuotaState | CodexQuotaState;
export type ForecastQuotaWindow = ClaudeQuotaWindow | CodexQuotaWindow;
export type ForecastHistoryState = 'loading' | 'ready' | 'disabled' | 'error';

export interface QuotaForecast {
  confidence: ForecastConfidence;
  quality: 'low' | 'moderate' | null;
  outcome: ForecastOutcome;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  exhaustAtMs: number | null;
  observedAtMs: number | null;
  ageMs: number | null;
  sampleCount: number;
  sampleSpanMs: number;
  ratePercentPerDay: number | null;
  resetDetected: boolean;
  includesImportedReadings: boolean;
  reason:
    | 'none'
    | 'quota-not-loaded'
    | 'weekly-window-missing'
    | 'stale-window'
    | 'stale-reading'
    | 'sparse-window'
    | 'no-consumption'
    | 'no-growth'
    | 'invalid-reading'
    | 'history-building'
    | 'history-truncated'
    | 'history-unavailable'
    | 'reset-detected'
    | 'store-losses';
}

export interface ForecastHistoryContext {
  authId: string;
  authIndex?: string | number | null;
  history: QuotaHistoryResponse | null;
  state: ForecastHistoryState;
  diagnostics?: 'healthy' | 'losses' | 'unavailable';
}

export interface ForecastUsageMetric {
  currentWeekTokens: number | null;
  recentTokens: number | null;
  dailyTokens: number | null;
  recentRequests: number | null;
  recentFailed: number | null;
  observedRecentMs: number | null;
}

const unknownForecast = (
  reason: QuotaForecast['reason'],
  window?: ForecastQuotaWindow,
  details: Partial<QuotaForecast> = {}
): QuotaForecast => {
  const used = window?.usedPercent;
  const validUsed = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100;
  const reset = window?.resetAtMs;
  return {
    confidence: 'unknown',
    quality: null,
    outcome: 'unknown',
    usedPercent: validUsed ? used : null,
    remainingPercent: validUsed ? 100 - used : null,
    resetAtMs: typeof reset === 'number' && Number.isFinite(reset) ? reset : null,
    exhaustAtMs: null,
    observedAtMs: null,
    ageMs: null,
    sampleCount: 0,
    sampleSpanMs: 0,
    ratePercentPerDay: null,
    resetDetected: false,
    includesImportedReadings: false,
    reason,
    ...details,
  };
};

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

/** Claude's account-wide seven-day window. Model-specific weekly windows are separate limits. */
export const findClaudeWeeklyWindow = (
  quota: ClaudeQuotaState | undefined
): ClaudeQuotaWindow | null => {
  if (!quota || quota.status !== 'success') return null;
  return quota.windows.find((window) => window.id === 'seven-day') ?? null;
};

export const firstUsageInstantMs = (summary: UsageSummaryResponse | null): number | null => {
  let firstMs = Infinity;
  for (const row of summary?.rows ?? []) {
    const parsed = Date.parse(row.first_at);
    if (Number.isFinite(parsed)) firstMs = Math.min(firstMs, parsed);
  }
  return Number.isFinite(firstMs) ? firstMs : null;
};

/** Accounts already exhausted remain at risk until their reported reset. */
export const isQuotaAtRisk = (forecast: Pick<QuotaForecast, 'outcome'>): boolean =>
  forecast.outcome === 'exhausted' || forecast.outcome === 'before-reset';

export const buildCodexQuotaForecast = (
  quota: CodexQuotaState | undefined,
  nowMs: number,
  context?: ForecastHistoryContext
): QuotaForecast => buildQuotaForecast('codex', quota, nowMs, context);

export const buildClaudeQuotaForecast = (
  quota: ClaudeQuotaState | undefined,
  nowMs: number,
  context?: ForecastHistoryContext
): QuotaForecast => buildQuotaForecast('claude', quota, nowMs, context);

const validObservation = (row: QuotaObservation, nowMs: number): boolean =>
  Number.isFinite(row.observed_at_ms) &&
  row.observed_at_ms > 0 &&
  row.observed_at_ms <= nowMs + 60_000 &&
  Number.isFinite(row.used_percent) &&
  row.used_percent >= 0 &&
  row.used_percent <= 100 &&
  Number.isFinite(row.reset_at_ms) &&
  row.reset_at_ms > row.observed_at_ms &&
  Number.isFinite(row.period_hours) &&
  row.period_hours === 168 &&
  row.reset_at_ms - row.period_hours * 60 * 60_000 <= row.observed_at_ms + RESET_TOLERANCE_MS;

/**
 * Estimate runout from changes in the provider's own weekly percentage, observed over time.
 * Token history remains context only because provider quota units are not a token limit.
 */
export const buildQuotaForecast = (
  provider: ForecastProvider,
  quota: ForecastQuotaState | undefined,
  nowMs: number,
  context?: ForecastHistoryContext
): QuotaForecast => {
  if (!quota || quota.status !== 'success') return unknownForecast('quota-not-loaded');
  const window =
    provider === 'claude'
      ? findClaudeWeeklyWindow(quota as ClaudeQuotaState)
      : findCodexWeeklyWindow(quota as CodexQuotaState);
  if (!window) return unknownForecast('weekly-window-missing');
  const used = window.usedPercent;
  const resetAtMs = window.resetAtMs;
  if (
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100 ||
    typeof resetAtMs !== 'number' ||
    !Number.isFinite(resetAtMs) ||
    window.periodHours !== 168 ||
    !Number.isFinite(nowMs)
  )
    return unknownForecast('invalid-reading', window);
  if (resetAtMs <= nowMs) return unknownForecast('stale-window', window);
  if (!context || context.state === 'loading') return unknownForecast('history-building', window);
  if (context.state !== 'ready' || !context.history) {
    return unknownForecast('history-unavailable', window);
  }
  if (context.history.truncated) return unknownForecast('history-truncated', window);
  if (context.diagnostics === 'unavailable') return unknownForecast('history-unavailable', window);
  if (context.diagnostics === 'losses') return unknownForecast('store-losses', window);

  const windowId = provider === 'claude' ? 'seven-day' : 'weekly';
  const authIndex = context.authIndex == null ? '' : String(context.authIndex).trim();
  const matching = context.history.rows
    .filter(
      (row) =>
        row.provider === provider &&
        row.auth_id === context.authId &&
        row.window_id === windowId &&
        (!authIndex || row.auth_index === authIndex)
    )
    .sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.id - right.id);
  if (matching.length === 0) return unknownForecast('history-building', window);
  if (matching.some((row) => !validObservation(row, nowMs))) {
    return unknownForecast('invalid-reading', window);
  }

  // Without an auth index, isolate the newest identity rather than mixing replaced credentials.
  const latestIdentity = matching[matching.length - 1].auth_index;
  const byInstant = new Map<number, QuotaObservation>();
  matching
    .filter((row) => row.auth_index === latestIdentity)
    .forEach((row) => {
      byInstant.set(row.observed_at_ms, row);
    });
  const observations = [...byInstant.values()];
  let segment: QuotaObservation[] = [];
  let resetDetected = false;
  for (const row of observations) {
    const previous = segment[segment.length - 1];
    if (
      previous &&
      (Math.abs(row.reset_at_ms - previous.reset_at_ms) > RESET_TOLERANCE_MS ||
        row.period_hours !== previous.period_hours ||
        row.used_percent < previous.used_percent - 1)
    ) {
      segment = [];
      resetDetected = true;
    }
    segment.push(row);
  }
  const latest = segment[segment.length - 1];
  if (Math.abs(latest.reset_at_ms - resetAtMs) > RESET_TOLERANCE_MS) {
    return unknownForecast('reset-detected', window, { resetDetected: true });
  }
  const recent = segment.filter(
    (row) => row.observed_at_ms >= latest.observed_at_ms - FORECAST_RECENT_MS
  );
  const first = recent[0];
  const ageMs = Math.max(0, nowMs - latest.observed_at_ms);
  const spanMs = latest.observed_at_ms - first.observed_at_ms;
  const details: Partial<QuotaForecast> = {
    usedPercent: latest.used_percent,
    remainingPercent: 100 - latest.used_percent,
    resetAtMs: latest.reset_at_ms,
    observedAtMs: latest.observed_at_ms,
    ageMs,
    sampleCount: recent.length,
    sampleSpanMs: spanMs,
    resetDetected,
    includesImportedReadings: recent.some(
      (row) => row.source !== 'passive-response' && row.source !== 'management-api-call'
    ),
  };
  const unknown = (reason: QuotaForecast['reason']) => unknownForecast(reason, window, details);
  if (ageMs > FORECAST_MAX_AGE_MS) return unknown('stale-reading');
  if (latest.reset_at_ms <= nowMs) return unknown('stale-window');
  if (latest.used_percent === 100) {
    return {
      ...unknown('none'),
      confidence: 'reported',
      outcome: 'exhausted',
      exhaustAtMs: latest.observed_at_ms,
    };
  }
  const cycleElapsedMs = latest.observed_at_ms - (latest.reset_at_ms - WEEK_MS);
  if (cycleElapsedMs < FORECAST_MIN_ELAPSED_MS) return unknown('sparse-window');
  if (latest.used_percent < 1) return unknown('no-consumption');
  if (recent.length < FORECAST_MIN_SAMPLES || spanMs < FORECAST_MIN_ELAPSED_MS) {
    return unknown(resetDetected ? 'reset-detected' : 'history-building');
  }
  const deltaPercent = latest.used_percent - first.used_percent;
  if (deltaPercent < 1) return unknown('no-growth');

  const ratePercentPerMs = deltaPercent / spanMs;
  const ratePercentPerDay = ratePercentPerMs * DAY_MS;
  const projectedMs = latest.observed_at_ms + (100 - latest.used_percent) / ratePercentPerMs;
  if (!Number.isFinite(projectedMs)) return unknown('invalid-reading');
  // Confidence describes observation coverage and rate stability, not a validated probability.
  const intervalRates = recent
    .slice(1)
    .map(
      (row, index) =>
        Math.max(0, row.used_percent - recent[index].used_percent) /
        (row.observed_at_ms - recent[index].observed_at_ms)
    );
  const stable = intervalRates.every(
    (rate) => rate >= ratePercentPerMs / 2 && rate <= ratePercentPerMs * 2
  );
  const covered =
    recent.length >= 6 &&
    spanMs >= 6 * 60 * 60_000 &&
    recent
      .slice(1)
      .every((row, index) => row.observed_at_ms - recent[index].observed_at_ms <= 3 * 60 * 60_000);
  return {
    ...unknown('none'),
    confidence: 'estimated',
    quality: covered && stable && !details.includesImportedReadings ? 'moderate' : 'low',
    outcome: projectedMs < latest.reset_at_ms ? 'before-reset' : 'lasts-to-reset',
    exhaustAtMs: Math.max(nowMs, projectedMs),
    ratePercentPerDay,
  };
};

/** Each account's pace spans its own first recorded request to the query end. */
export const buildForecastUsageMetrics = (
  authIds: readonly string[],
  currentWeek: UsageSummaryResponse | null,
  recent: UsageSummaryResponse | null
): Map<string, ForecastUsageMetric> => {
  const byAuth = (summary: UsageSummaryResponse | null) => {
    const totals = new Map<
      string,
      { tokens: number; requests: number; failed: number; firstMs: number }
    >();
    for (const row of summary?.rows ?? []) {
      const authId = row.keys.auth_id;
      if (!authId) continue;
      const value = totals.get(authId) ?? { tokens: 0, requests: 0, failed: 0, firstMs: Infinity };
      value.tokens += Math.max(0, row.total_tokens);
      value.requests += Math.max(0, row.requests);
      value.failed += Math.max(0, row.failed);
      const firstMs = Date.parse(row.first_at);
      if (Number.isFinite(firstMs)) value.firstMs = Math.min(value.firstMs, firstMs);
      totals.set(authId, value);
    }
    return totals;
  };
  const weekByAuth = byAuth(currentWeek);
  const recentByAuth = byAuth(recent);
  const fromMs = Date.parse(recent?.from ?? '');
  const toMs = Date.parse(recent?.to ?? '');
  return new Map(
    authIds.map((authId) => {
      const value = recentByAuth.get(authId);
      const spanMs =
        value && Number.isFinite(value.firstMs) && Number.isFinite(fromMs) && Number.isFinite(toMs)
          ? Math.max(0, toMs - Math.max(fromMs, value.firstMs))
          : null;
      return [
        authId,
        {
          currentWeekTokens: currentWeek ? (weekByAuth.get(authId)?.tokens ?? 0) : null,
          recentTokens: recent ? (value?.tokens ?? 0) : null,
          dailyTokens:
            spanMs !== null && spanMs >= FORECAST_MIN_ELAPSED_MS
              ? (value?.tokens ?? 0) / (spanMs / DAY_MS)
              : null,
          recentRequests: recent ? (value?.requests ?? 0) : null,
          recentFailed: recent ? (value?.failed ?? 0) : null,
          observedRecentMs: spanMs,
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
