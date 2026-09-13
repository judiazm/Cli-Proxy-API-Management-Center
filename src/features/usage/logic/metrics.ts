/**
 * Combining metric rows.
 *
 * The store answers with one row per group; every view on this page needs some
 * row the store did not return: a parent row over its children, a matrix
 * row/column total, a table totals line. Those are produced here so the three
 * views cannot disagree about what a total means.
 */

import type { UsageMetrics } from '@/services/api';

export const emptyUsageMetrics = (): UsageMetrics => ({
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

/**
 * Sum a set of rows into one.
 *
 * Counts add. The two averages are recombined as a request-weighted mean,
 * which is exact rather than approximate: each input average is already the
 * mean over exactly that row's `requests`, so weighting by `requests` rebuilds
 * the mean over the union. p95 is not recoverable from per-row p95s at all, so
 * the combined row reports null instead of a plausible-looking wrong number.
 */
export const combineUsageMetrics = (rows: readonly UsageMetrics[]): UsageMetrics => {
  const combined = emptyUsageMetrics();
  let latencyWeighted = 0;
  let ttftWeighted = 0;

  rows.forEach((row) => {
    combined.requests += row.requests;
    combined.failed += row.failed;
    combined.input_tokens += row.input_tokens;
    combined.cache_read_tokens += row.cache_read_tokens;
    combined.cache_creation_tokens += row.cache_creation_tokens;
    combined.cached_tokens += row.cached_tokens;
    combined.output_tokens += row.output_tokens;
    combined.reasoning_tokens += row.reasoning_tokens;
    combined.total_tokens += row.total_tokens;
    latencyWeighted += row.latency_ms_avg * row.requests;
    ttftWeighted += row.ttft_ms_avg * row.requests;
  });

  if (combined.requests > 0) {
    combined.latency_ms_avg = latencyWeighted / combined.requests;
    combined.ttft_ms_avg = ttftWeighted / combined.requests;
  }

  // A single row keeps its own p95; two or more cannot be merged.
  combined.latency_ms_p95 = rows.length === 1 ? rows[0].latency_ms_p95 : null;

  return combined;
};

export const readUsageMetric = (metrics: UsageMetrics, id: keyof UsageMetrics): number => {
  const value = metrics[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/**
 * Share of prompt tokens that came from cache.
 *
 * The denominator is `input_tokens + cache_read_tokens` because a cached read
 * is a prompt token that was not billed as fresh input, while cache writes belong to
 * the cost of filling the cache, not to how well it is being hit. Null when
 * there were no prompt tokens at all, which renders as a dash rather than 0%.
 */
export const cacheHitRatio = (metrics: UsageMetrics): number | null => {
  const denominator = metrics.input_tokens + metrics.cache_read_tokens;
  if (denominator <= 0) return null;
  return metrics.cache_read_tokens / denominator;
};

/** Share of requests that failed, or null when nothing ran. */
export const failureRatio = (metrics: UsageMetrics): number | null => {
  if (metrics.requests <= 0) return null;
  return metrics.failed / metrics.requests;
};

/**
 * Change from one window to the equal-length window before it.
 *
 * Null when the earlier window is empty: every first day of data would
 * otherwise read as a clean +100%, which says nothing about a trend.
 */
export const relativeDelta = (current: number, previous: number): number | null => {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / previous;
};
