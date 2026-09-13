/**
 * Summary rows grouped by (bucket, dimension) into stacked columns.
 *
 * Two decisions shape the result. Buckets are sorted chronologically rather
 * than by size, because a time axis that is not in time order is not a time
 * axis. And the series are capped: a stack of sixty devices is sixty slivers
 * and one unreadable legend, so everything past the top few is folded into a
 * single remainder series that is still counted in the totals.
 */

import type { UsageGroupColumn, UsageMetrics, UsageSummaryRow } from '@/services/api';
import { readUsageMetric } from './metrics';

/** Series kept apart before the rest are folded together. */
export const USAGE_TIMELINE_SERIES_LIMIT = 10;

/** Identifies the folded remainder series; no real key can collide with it. */
export const USAGE_TIMELINE_OTHER = '__usage_other__';

export interface UsageTimelineSeries {
  key: string;
  total: number;
  /** True for the folded remainder, which has no single name. */
  isOther: boolean;
}

export interface UsageTimelineBucket {
  /** RFC3339 bucket start, as the store emitted it in the requested zone. */
  key: string;
  total: number;
  /** Series key to value; series absent from this bucket are simply missing. */
  values: Map<string, number>;
}

export interface UsageTimeline {
  buckets: UsageTimelineBucket[];
  series: UsageTimelineSeries[];
  peak: number;
}

export interface BuildUsageTimelineOptions {
  bucketDimension: UsageGroupColumn;
  seriesDimension: UsageGroupColumn;
  metric: keyof UsageMetrics;
  seriesLimit?: number;
}

export const buildUsageTimeline = (
  rows: readonly UsageSummaryRow[],
  options: BuildUsageTimelineOptions
): UsageTimeline => {
  const { bucketDimension, seriesDimension, metric } = options;
  const limit = options.seriesLimit ?? USAGE_TIMELINE_SERIES_LIMIT;

  const seriesTotals = new Map<string, number>();
  rows.forEach((row) => {
    const key = row.keys[seriesDimension] ?? '';
    seriesTotals.set(key, (seriesTotals.get(key) ?? 0) + readUsageMetric(row, metric));
  });

  const ranked = Array.from(seriesTotals.entries()).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );
  const kept = ranked.slice(0, limit);
  const folded = ranked.slice(limit);
  const keptKeys = new Set(kept.map(([key]) => key));

  const bucketMap = new Map<string, UsageTimelineBucket>();
  rows.forEach((row) => {
    const bucketKey = row.keys[bucketDimension] ?? '';
    const rawSeries = row.keys[seriesDimension] ?? '';
    const seriesKey = keptKeys.has(rawSeries) ? rawSeries : USAGE_TIMELINE_OTHER;
    const value = readUsageMetric(row, metric);

    let bucket = bucketMap.get(bucketKey);
    if (!bucket) {
      bucket = { key: bucketKey, total: 0, values: new Map<string, number>() };
      bucketMap.set(bucketKey, bucket);
    }
    bucket.values.set(seriesKey, (bucket.values.get(seriesKey) ?? 0) + value);
    bucket.total += value;
  });

  // RFC3339 with a fixed offset sorts lexicographically in time order, but the
  // store emits bucket starts in the requested zone, so the comparison is on
  // parsed instants to stay correct across a DST boundary.
  const buckets = Array.from(bucketMap.values()).sort((left, right) => {
    const leftMs = Date.parse(left.key);
    const rightMs = Date.parse(right.key);
    if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left.key.localeCompare(right.key);
    return leftMs - rightMs;
  });

  const series: UsageTimelineSeries[] = kept.map(([key, total]) => ({
    key,
    total,
    isOther: false,
  }));
  if (folded.length > 0) {
    series.push({
      key: USAGE_TIMELINE_OTHER,
      total: folded.reduce((sum, [, total]) => sum + total, 0),
      isOther: true,
    });
  }

  const peak = buckets.reduce((max, bucket) => Math.max(max, bucket.total), 0);

  return { buckets, series, peak };
};

/**
 * Peak of the visible stack when some series are toggled off.
 *
 * Recomputed rather than kept at the full-stack peak: hiding the largest series
 * should let the remaining ones use the height of the chart, which is usually
 * the reason someone hid it.
 */
export const visibleTimelinePeak = (timeline: UsageTimeline, hidden: ReadonlySet<string>): number =>
  timeline.buckets.reduce((max, bucket) => {
    let total = 0;
    bucket.values.forEach((value, key) => {
      if (!hidden.has(key)) total += value;
    });
    return Math.max(max, total);
  }, 0);
