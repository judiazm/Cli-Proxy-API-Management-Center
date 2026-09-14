/**
 * The window the page is looking at, and the bucket that window implies.
 *
 * Everything here is a pure function of an explicit `now`, so the tests do not
 * need a clock and a page left open overnight recomputes rather than drifts.
 * Presets resolve to absolute milliseconds at the moment they are used; the URL
 * stores the preset, not its resolution, so a shared link means "the last
 * 7 days" to whoever opens it rather than "the 7 days before I sent this".
 */

import type { UsageTimeBucket } from '@/services/api';

export const USAGE_RANGE_PRESETS = ['today', '24h', '7d', '30d', '90d', 'all', 'custom'] as const;

export type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number];

export const isUsageRangePreset = (value: unknown): value is UsageRangePreset =>
  typeof value === 'string' && (USAGE_RANGE_PRESETS as readonly string[]).includes(value);

export interface ResolvedUsageRange {
  fromMs: number;
  toMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PRESET_SPANS: Partial<Record<UsageRangePreset, number>> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

export interface ResolveUsageRangeOptions {
  /** Local-midnight anchor and the end of every relative preset. */
  nowMs: number;
  /** Only read by the `custom` preset. Milliseconds. */
  customFromMs?: number | null;
  customToMs?: number | null;
  /** `meta.oldest` in milliseconds; the floor of the `all` preset. */
  oldestMs?: number | null;
}

/**
 * `today` starts at local midnight, not 24 hours ago.
 *
 * The distinction is the whole point of having both presets: at 09:00 "today"
 * is nine hours of data and "24h" is yesterday morning onwards, and someone
 * checking whether a device has been busy *today* means the former.
 */
const startOfLocalDay = (nowMs: number): number => {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const resolveUsageRange = (
  preset: UsageRangePreset,
  options: ResolveUsageRangeOptions
): ResolvedUsageRange => {
  const { nowMs } = options;

  if (preset === 'custom') {
    const toMs = options.customToMs ?? nowMs;
    const fromMs = options.customFromMs ?? toMs - DAY_MS;
    // A backwards custom range is a typo in the inputs, not a query; swapping
    // is the reading that returns data instead of an empty table.
    return fromMs <= toMs ? { fromMs, toMs } : { fromMs: toMs, toMs: fromMs };
  }

  if (preset === 'all') {
    const oldest = options.oldestMs;
    const fromMs = typeof oldest === 'number' && Number.isFinite(oldest) ? oldest : 0;
    return { fromMs: Math.min(fromMs, nowMs), toMs: nowMs };
  }

  if (preset === 'today') {
    return { fromMs: startOfLocalDay(nowMs), toMs: nowMs };
  }

  const span = PRESET_SPANS[preset] ?? DAY_MS;
  return { fromMs: nowMs - span, toMs: nowMs };
};

/**
 * The equal-length window immediately before this one.
 *
 * Used for the deltas in the summary strip. A zero-length range (a custom
 * from == to) has no meaningful predecessor, so it is reported as such rather
 * than as a window of zero requests that would render as a −100% delta.
 */
export const previousUsageRange = (range: ResolvedUsageRange): ResolvedUsageRange | null => {
  const span = range.toMs - range.fromMs;
  if (span <= 0) return null;
  return { fromMs: range.fromMs - span, toMs: range.fromMs };
};

/**
 * Bucket width for a range, when the user has not chosen one.
 *
 * The thresholds are about bar count, not about time: 48 hours of hourly bars
 * is 48 columns, 90 days of daily bars is 90, and a year of weekly bars is 52.
 * Past 90 days a daily bucket stops being readable before it stops being
 * computable, which is why the ceiling is here rather than in the backend.
 */
export const autoUsageBucket = (range: ResolvedUsageRange): UsageTimeBucket => {
  const span = Math.max(0, range.toMs - range.fromMs);
  if (span <= 48 * HOUR_MS) return 'hour';
  if (span <= 90 * DAY_MS) return 'day';
  return 'week';
};

/** The browser's IANA zone, or UTC where the runtime will not say. */
export const browserTimeZone = (): string => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Milliseconds for an RFC3339 instant, or null when it will not parse. */
export const parseInstantMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/** `2026-09-13T14:30` in local time, the value an input[type=datetime-local] wants. */
export const toDateTimeLocalInput = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

/** The inverse of `toDateTimeLocalInput`; null for an empty or invalid field. */
export const fromDateTimeLocalInput = (value: string): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};
