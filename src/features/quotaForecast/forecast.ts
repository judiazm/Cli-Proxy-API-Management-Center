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
const HOUR_MS = 60 * 60_000;
/** Pace is the mean of the slopes over these trailing windows (short reacts, long steadies). */
export const FORECAST_PACE_WINDOWS_MS = [6 * HOUR_MS, 24 * HOUR_MS] as const;

export type ForecastConfidence = 'reported' | 'estimated' | 'unknown';
export type ForecastOutcome = 'exhausted' | 'before-reset' | 'lasts-to-reset' | 'unknown';
export type ForecastProvider = 'claude' | 'codex';
export type ForecastQuotaState = ClaudeQuotaState | CodexQuotaState;
export type ForecastQuotaWindow = ClaudeQuotaWindow | CodexQuotaWindow;
export type ForecastHistoryState = 'loading' | 'ready' | 'disabled' | 'error';
/** What drives a runout: the account's own pace, or traffic handed over when others run dry. */
export type ForecastDriver = 'own-pace' | 'pool-handoff' | 'idle';

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
  /** Calibrated chance of running out before the reset; null when no pace is known. */
  runoutChance: number | null;
  /** Likely runout window (middle half of past outcomes), clamped to the reset. */
  rangeStartMs: number | null;
  rangeEndMs: number | null;
  driver: ForecastDriver | null;
  /** The pool member whose runout sends traffic here, for `pool-handoff`. */
  handoffAfter: string | null;
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
    runoutChance: null,
    rangeStartMs: null,
    rangeEndMs: null,
    driver: null,
    handoffAfter: null,
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
    // An unused Codex window floats: its reset slides forward with every reading until first use.
    const floating = previous?.used_percent === 0;
    if (
      previous &&
      ((Math.abs(row.reset_at_ms - previous.reset_at_ms) > RESET_TOLERANCE_MS && !floating) ||
        row.period_hours !== previous.period_hours ||
        row.used_percent < previous.used_percent - 1)
    ) {
      segment = [];
      resetDetected = true;
    }
    if (floating && Math.abs(row.reset_at_ms - previous.reset_at_ms) > RESET_TOLERANCE_MS) {
      segment = [];
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

  // Backtested on this proxy's own history: the mean of a 6 h and a 24 h slope cut the median
  // runout error from 6.6 h to 5.1 h against a single 24 h endpoint slope.
  const slopes = FORECAST_PACE_WINDOWS_MS.map((windowMs) => {
    const inWindow = recent.filter((row) => row.observed_at_ms >= latest.observed_at_ms - windowMs);
    const start = inWindow[0];
    const coveredMs = latest.observed_at_ms - start.observed_at_ms;
    return inWindow.length >= 2 && coveredMs >= Math.max(FORECAST_MIN_ELAPSED_MS, windowMs / 2)
      ? (latest.used_percent - start.used_percent) / coveredMs
      : null;
  }).filter((slope): slope is number => slope !== null);
  const ratePercentPerMs =
    slopes.length > 0
      ? slopes.reduce((sum, slope) => sum + slope, 0) / slopes.length
      : deltaPercent / spanMs;
  if (!(ratePercentPerMs > 0)) return unknown('no-growth');
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
  const exhaustAtMs = Math.max(nowMs, projectedMs);
  return {
    ...unknown('none'),
    confidence: 'estimated',
    quality: covered && stable && !details.includesImportedReadings ? 'moderate' : 'low',
    outcome: projectedMs < latest.reset_at_ms ? 'before-reset' : 'lasts-to-reset',
    exhaustAtMs,
    ratePercentPerDay,
    driver: 'own-pace',
    ...calibrateRunout(exhaustAtMs, latest.reset_at_ms, nowMs),
  };
};

/**
 * Empirical calibration from replaying this proxy's quota history (Sep 13 to Oct 21 2026, 939
 * forecast moments): how often an account actually ran out before its reset, by how far along
 * the time to reset the predicted runout fell. Points are [predicted runout / time to reset,
 * observed share that ran out]; values between points are interpolated.
 */
const RUNOUT_CHANCE_CURVE: readonly (readonly [number, number])[] = [
  [0, 0.97],
  [0.5, 0.9],
  [0.9, 0.75],
  [1.25, 0.65],
  [1.6, 0.5],
  [2.5, 0.38],
  [5, 0.25],
  [10, 0.15],
];
/** Middle half of actual / predicted time-to-empty in the same replay. */
const RUNOUT_RANGE_LOW = 0.65;
const RUNOUT_RANGE_HIGH = 1.43;

export const runoutChance = (ratio: number): number => {
  const curve = RUNOUT_CHANCE_CURVE;
  if (!Number.isFinite(ratio)) return curve[curve.length - 1][1];
  if (ratio <= curve[0][0]) return curve[0][1];
  for (let index = 1; index < curve.length; index += 1) {
    const [x1, y1] = curve[index];
    const [x0, y0] = curve[index - 1];
    if (ratio <= x1) return y0 + ((ratio - x0) / (x1 - x0)) * (y1 - y0);
  }
  return curve[curve.length - 1][1];
};

export const calibrateRunout = (
  exhaustAtMs: number,
  resetAtMs: number,
  nowMs: number
): Pick<QuotaForecast, 'runoutChance' | 'rangeStartMs' | 'rangeEndMs'> => {
  const untilReset = resetAtMs - nowMs;
  const untilRunout = Math.max(0, exhaustAtMs - nowMs);
  if (!(untilReset > 0)) return { runoutChance: null, rangeStartMs: null, rangeEndMs: null };
  return {
    runoutChance: runoutChance(untilRunout / untilReset),
    rangeStartMs: Math.min(resetAtMs, nowMs + untilRunout * RUNOUT_RANGE_LOW),
    rangeEndMs: Math.min(resetAtMs, nowMs + untilRunout * RUNOUT_RANGE_HIGH),
  };
};

export interface PoolMember {
  id: string;
  /** Provider plus credential prefix: fill-first only moves traffic inside one pool. */
  pool: string;
  priority: number;
  forecast: QuotaForecast;
}

export interface PoolOutlook {
  pool: string;
  members: string[];
  /** Combined pace of every member, in quota points per day. */
  pacePercentPerDay: number;
  /** When every member is empty at once, and when the first reset brings capacity back. */
  dryFromMs: number | null;
  dryUntilMs: number | null;
}

const POOL_STEP_MS = 10 * 60_000;

/** Fill-first order: higher priority first, then credential ID, as the gateway selects. */
const fillFirstOrder = (left: PoolMember, right: PoolMember): number =>
  right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Replays fill-first routing forward. Session affinity keeps each account on its own recent pace;
 * when an account runs dry its pace moves to the first available member in routing order, and an
 * account that resets takes traffic again. In the same replay this caught 77% of runouts against
 * 69% for each account's own pace alone, mostly idle accounts drained once the ones ahead ran out.
 */
export const simulatePools = (
  members: readonly PoolMember[],
  nowMs: number
): { forecasts: Map<string, QuotaForecast>; pools: PoolOutlook[] } => {
  const forecasts = new Map(members.map((member) => [member.id, member.forecast]));
  const pools: PoolOutlook[] = [];
  const byPool = new Map<string, PoolMember[]>();
  members.forEach((member) => {
    byPool.set(member.pool, [...(byPool.get(member.pool) ?? []), member]);
  });

  for (const [pool, poolMembers] of byPool) {
    const ordered = [...poolMembers].sort(fillFirstOrder);
    const state = ordered
      .filter(
        (member) =>
          member.forecast.usedPercent !== null &&
          member.forecast.resetAtMs !== null &&
          member.forecast.resetAtMs > nowMs &&
          (member.forecast.outcome !== 'unknown' ||
            member.forecast.reason === 'no-growth' ||
            member.forecast.reason === 'no-consumption')
      )
      .map((member) => ({
        member,
        used: member.forecast.outcome === 'exhausted' ? 100 : (member.forecast.usedPercent ?? 0),
        resetAtMs: member.forecast.resetAtMs ?? nowMs,
        pace: Math.max(0, member.forecast.ratePercentPerDay ?? 0),
        exhaustAtMs: null as number | null,
        handoffFrom: null as string | null,
      }));
    const pacePerDay = state.reduce((sum, item) => sum + item.pace, 0);
    const outlook: PoolOutlook = {
      pool,
      members: ordered.map((member) => member.id),
      pacePercentPerDay: pacePerDay,
      dryFromMs: null,
      dryUntilMs: null,
    };
    pools.push(outlook);
    const horizonMs =
      pacePerDay > 0 ? Math.max(...state.map((item) => item.resetAtMs)) : nowMs;
    for (let at = nowMs; at < horizonMs; at += POOL_STEP_MS) {
      state.forEach((item) => {
        if (at >= item.resetAtMs) {
          item.used = 0;
          item.resetAtMs += WEEK_MS;
        }
      });
      const share = POOL_STEP_MS / DAY_MS;
      let spill = 0;
      let spillFrom: string | null = null;
      state.forEach((item) => {
        if (item.used >= 100) {
          spill += item.pace * share;
          spillFrom ??= item.member.id;
          return;
        }
        item.used = Math.min(100, item.used + item.pace * share);
      });
      for (const item of state) {
        if (spill <= 0) break;
        if (item.used >= 100) continue;
        const take = Math.min(spill, 100 - item.used);
        item.used += take;
        spill -= take;
        if (item.exhaustAtMs === null) item.handoffFrom ??= spillFrom;
      }
      state.forEach((item) => {
        if (item.used >= 100 && item.exhaustAtMs === null && at < item.member.forecast.resetAtMs!) {
          item.exhaustAtMs = at + POOL_STEP_MS;
        }
      });
      if (outlook.dryFromMs === null && state.every((item) => item.used >= 100)) {
        outlook.dryFromMs = at + POOL_STEP_MS;
        outlook.dryUntilMs = Math.min(...state.map((item) => item.resetAtMs));
      }
    }

    state.forEach((item) => {
      const own = item.member.forecast;
      const resetAtMs = own.resetAtMs!;
      if (own.outcome === 'exhausted') return;
      const ownRunoutMs =
        own.outcome === 'before-reset' && own.exhaustAtMs !== null ? own.exhaustAtMs : Infinity;
      if (item.exhaustAtMs !== null && item.exhaustAtMs < ownRunoutMs - HOUR_MS) {
        forecasts.set(item.member.id, {
          ...own,
          confidence: 'estimated',
          quality: own.quality ?? 'low',
          outcome: 'before-reset',
          exhaustAtMs: item.exhaustAtMs,
          driver: item.handoffFrom ? 'pool-handoff' : own.driver,
          handoffAfter: item.handoffFrom,
          reason: 'none',
          ...calibrateRunout(item.exhaustAtMs, resetAtMs, nowMs),
        });
      } else if (own.outcome === 'unknown') {
        // Idle with valid readings, and the pool never reaches it before its reset.
        forecasts.set(item.member.id, {
          ...own,
          confidence: 'estimated',
          quality: 'low',
          outcome: 'lasts-to-reset',
          driver: 'idle',
          reason: 'none',
        });
      }
    });
  }
  return { forecasts, pools };
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
