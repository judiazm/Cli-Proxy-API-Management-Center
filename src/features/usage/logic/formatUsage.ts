/**
 * Number formatting for a page that is mostly numbers.
 *
 * Two rules drive all of it. A column of figures is compared by eye, so every
 * number in a column must occupy the same shape: same unit, same decimal
 * count, tabular figures in the stylesheet. And a token count is read for its
 * magnitude, not its digits, so 3,148,220 is noise where 3.1M is an answer.
 *
 * The compact form here is lower-case `k` and upper-case `M`/`B`/`T`, which is
 * the convention this page was specified in. `formatCompactNumber` in
 * `@/utils/format` renders `K` and is used elsewhere in the app; the two are
 * deliberately not merged, because changing the shared one would move numbers
 * on the dashboard for no reason.
 */

const COMPACT_SUFFIXES = ['', 'k', 'M', 'B', 'T'] as const;

/**
 * `0`, `948`, `12.4k`, `3.1M`.
 *
 * Under 1000 the exact integer is shown; there is no reason to round a number
 * that already fits. Above it, one decimal up to 100 and none beyond, so the
 * rendered string never exceeds five characters and columns stay aligned.
 */
export const formatUsageCount = (value: number): string => {
  if (!Number.isFinite(value)) return '0';

  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs < 1000) return `${sign}${Math.round(abs)}`;

  const render = (tier: number): string => {
    const scaled = abs / 1000 ** tier;
    if (tier === 0) return String(Math.round(scaled));
    return scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled));
  };

  let tier = Math.min(Math.max(Math.floor(Math.log10(abs) / 3), 0), COMPACT_SUFFIXES.length - 1);
  let rendered = render(tier);

  // 999,999 rounds to "1000k". Promote to the next tier rather than print four
  // digits, which would break the column's alignment for one value in a
  // thousand.
  if (Number(rendered) >= 1000 && tier < COMPACT_SUFFIXES.length - 1) {
    tier += 1;
    rendered = render(tier);
  }

  return `${sign}${rendered.replace(/\.0$/, '')}${COMPACT_SUFFIXES[tier]}`;
};

/** Thousands-separated exact figure, for tooltips and CSV-adjacent detail. */
export const formatUsageExact = (value: number): string =>
  Number.isFinite(value) ? Math.round(value).toLocaleString() : '0';

/**
 * `0ms`, `840ms`, `1.4s`, `2m 05s`.
 *
 * Latency is compared against a human sense of "fast", so the unit switches
 * where that sense does, not at a power of ten.
 */
export const formatUsageDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};

/** A 0-1 ratio as a percentage. Null renders as an em-less dash. */
export const formatUsageRatio = (ratio: number | null, fractionDigits = 1): string => {
  if (ratio === null || !Number.isFinite(ratio)) return '--';
  const percent = ratio * 100;
  const rendered = percent >= 10 ? percent.toFixed(0) : percent.toFixed(fractionDigits);
  return `${rendered.replace(/\.0$/, '')}%`;
};

/** A signed relative change, `+18%` / `-4.2%`. Null when there is no baseline. */
export const formatUsageDelta = (delta: number | null): string => {
  if (delta === null || !Number.isFinite(delta)) return '';
  const percent = delta * 100;
  const magnitude = Math.abs(percent);
  const rendered = magnitude >= 10 ? magnitude.toFixed(0) : magnitude.toFixed(1);
  const sign = percent > 0 ? '+' : percent < 0 ? '-' : '';
  return `${sign}${rendered.replace(/\.0$/, '')}%`;
};

/** Value for a metric in the unit that metric is measured in. */
export const formatUsageMetric = (value: number, unit: 'count' | 'tokens' | 'ms'): string =>
  unit === 'ms' ? formatUsageDuration(value) : formatUsageCount(value);

/**
 * Bucket start stamp, shortened to what distinguishes one bucket from the next.
 *
 * An axis of forty-eight identical dates with only the hour changing wastes the
 * reader's attention on the part that is the same in every label.
 */
export const formatBucketLabel = (
  iso: string,
  bucket: 'hour' | 'day' | 'week' | 'month',
  locale?: string
): string => {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const date = new Date(parsed);

  switch (bucket) {
    case 'hour':
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    case 'month':
      return date.toLocaleDateString(locale, { year: 'numeric', month: 'short' });
    case 'week':
    case 'day':
    default:
      return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
};

/** Full stamp for tooltips and the request log. */
export const formatUsageInstant = (iso: string, locale?: string): string => {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso || '--';
  return new Date(parsed).toLocaleString(locale);
};
