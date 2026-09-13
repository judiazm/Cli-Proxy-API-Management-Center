/**
 * Summary rows -> a pivot table.
 *
 * The table view answers "which device is heaviest" and "which model is
 * heaviest" one at a time. The crossing, meaning which model is heavy on which
 * device, is a different shape, and a flat list of device/model rows makes
 * the reader do the transposition in their head. This builds the grid instead.
 *
 * Both axes are ordinary dimensions, so the same code serves Device x Model,
 * Account x Model, or any other pair.
 */

import type { UsageGroupColumn, UsageMetrics, UsageSummaryRow } from '@/services/api';
import { combineUsageMetrics, readUsageMetric } from './metrics';

export interface UsageMatrixCell {
  rowKey: string;
  columnKey: string;
  metrics: UsageMetrics;
}

export interface UsageMatrixAxisEntry {
  key: string;
  totals: UsageMetrics;
}

export interface UsageMatrix {
  rowDimension: UsageGroupColumn;
  columnDimension: UsageGroupColumn;
  rows: UsageMatrixAxisEntry[];
  columns: UsageMatrixAxisEntry[];
  /**
   * Row key -> column key -> cell. Nested rather than a joined string key: a
   * model id, an account name and a client key are all free text, so any
   * single-character join is a collision waiting to happen.
   */
  cells: Map<string, Map<string, UsageMatrixCell>>;
  totals: UsageMetrics;
}

export const usageMatrixCell = (
  matrix: UsageMatrix,
  rowKey: string,
  columnKey: string
): UsageMatrixCell | undefined => matrix.cells.get(rowKey)?.get(columnKey);

export interface BuildUsageMatrixOptions {
  rowDimension: UsageGroupColumn;
  columnDimension: UsageGroupColumn;
  /** Metric the axes are ordered by, heaviest first. */
  metric: keyof UsageMetrics;
}

const rowMetrics = (row: UsageSummaryRow): UsageMetrics => ({
  requests: row.requests,
  failed: row.failed,
  input_tokens: row.input_tokens,
  cache_read_tokens: row.cache_read_tokens,
  cache_creation_tokens: row.cache_creation_tokens,
  cached_tokens: row.cached_tokens,
  output_tokens: row.output_tokens,
  reasoning_tokens: row.reasoning_tokens,
  total_tokens: row.total_tokens,
  latency_ms_avg: row.latency_ms_avg,
  latency_ms_p95: row.latency_ms_p95,
  ttft_ms_avg: row.ttft_ms_avg,
});

export const buildUsageMatrix = (
  rows: readonly UsageSummaryRow[],
  options: BuildUsageMatrixOptions
): UsageMatrix => {
  const { rowDimension, columnDimension, metric } = options;

  const cells = new Map<string, Map<string, UsageMatrixCell>>();
  const rowBuckets = new Map<string, UsageMetrics[]>();
  const columnBuckets = new Map<string, UsageMetrics[]>();

  rows.forEach((row) => {
    const rowKey = row.keys[rowDimension] ?? '';
    const columnKey = row.keys[columnDimension] ?? '';
    const metrics = rowMetrics(row);

    let columnMap = cells.get(rowKey);
    if (!columnMap) {
      columnMap = new Map<string, UsageMatrixCell>();
      cells.set(rowKey, columnMap);
    }
    const existing = columnMap.get(columnKey);
    // The store returns one row per pair, but a same-pair collision (a
    // duplicate from a re-ordered or re-fetched response) must add rather than
    // overwrite, or the grid would silently under-report.
    columnMap.set(columnKey, {
      rowKey,
      columnKey,
      metrics: existing ? combineUsageMetrics([existing.metrics, metrics]) : metrics,
    });

    const rowBucket = rowBuckets.get(rowKey);
    if (rowBucket) rowBucket.push(metrics);
    else rowBuckets.set(rowKey, [metrics]);

    const columnBucket = columnBuckets.get(columnKey);
    if (columnBucket) columnBucket.push(metrics);
    else columnBuckets.set(columnKey, [metrics]);
  });

  const toAxis = (buckets: Map<string, UsageMetrics[]>): UsageMatrixAxisEntry[] =>
    Array.from(buckets.entries())
      .map(([key, entries]) => ({ key, totals: combineUsageMetrics(entries) }))
      .sort((left, right) => {
        const delta = readUsageMetric(right.totals, metric) - readUsageMetric(left.totals, metric);
        if (delta !== 0) return delta;
        return left.key.localeCompare(right.key, undefined, { numeric: true });
      });

  const axisRows = toAxis(rowBuckets);

  return {
    rowDimension,
    columnDimension,
    rows: axisRows,
    columns: toAxis(columnBuckets),
    cells,
    totals: combineUsageMetrics(axisRows.map((entry) => entry.totals)),
  };
};

/**
 * Heat shade for a cell, 0-1 against the busiest cell in the grid.
 *
 * Square-rooted rather than linear: token counts across devices are usually one
 * or two orders of magnitude apart, and a linear ramp leaves every cell but the
 * heaviest indistinguishable from empty.
 */
export const usageHeatIntensity = (value: number, max: number): number => {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0;
  return Math.min(1, Math.sqrt(value / max));
};

export const usageMatrixMaxCell = (matrix: UsageMatrix, metric: keyof UsageMetrics): number => {
  let max = 0;
  matrix.cells.forEach((columnMap) => {
    columnMap.forEach((cell) => {
      const value = readUsageMetric(cell.metrics, metric);
      if (value > max) max = value;
    });
  });
  return max;
};

/** Reorder the matrix rows by a metric on their totals. */
export const sortUsageMatrixAxis = (
  entries: readonly UsageMatrixAxisEntry[],
  metric: keyof UsageMetrics,
  direction: 'asc' | 'desc'
): UsageMatrixAxisEntry[] => {
  const sign = direction === 'asc' ? 1 : -1;
  return [...entries].sort((left, right) => {
    const delta = readUsageMetric(left.totals, metric) - readUsageMetric(right.totals, metric);
    if (delta !== 0) return sign * delta;
    return left.key.localeCompare(right.key, undefined, { numeric: true });
  });
};
