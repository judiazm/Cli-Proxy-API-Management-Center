/**
 * Summary rows → the two-level tree the table renders.
 *
 * The store returns a flat list: one row per combination of the grouped
 * columns. With a secondary dimension selected that means the primary
 * dimension appears once per child, and the row a reader actually wants first
 * ("this device, all models") is not in the response at all. It is built
 * here by combining the children, which is exact (see `combineUsageMetrics`)
 * and costs no second request.
 */

import type { UsageGroupColumn, UsageMetrics, UsageSummaryRow } from '@/services/api';
import { combineUsageMetrics, readUsageMetric } from './metrics';

export interface UsageGroupChild {
  /** Raw value of the secondary dimension, as the store returned it. */
  key: string;
  metrics: UsageMetrics;
  firstAt: string;
  lastAt: string;
}

export interface UsageGroupNode {
  /** Raw value of the primary dimension. Also the React key; it is unique. */
  key: string;
  metrics: UsageMetrics;
  children: UsageGroupChild[];
  firstAt: string;
  lastAt: string;
}

export interface BuildUsageGroupTreeOptions {
  primary: UsageGroupColumn;
  secondary?: UsageGroupColumn | null;
}

/** Earliest non-empty of two RFC3339 stamps; string order matches time order. */
const earliest = (left: string, right: string): string => {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
};

const latest = (left: string, right: string): string => {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
};

export const buildUsageGroupTree = (
  rows: readonly UsageSummaryRow[],
  options: BuildUsageGroupTreeOptions
): UsageGroupNode[] => {
  const { primary, secondary } = options;
  const hasSecondary = Boolean(secondary) && secondary !== primary;

  // Insertion order is the server's order, which is the server's `order_by`.
  // Client-side sorting happens afterwards, so an unsorted render still shows
  // the most interesting rows first.
  const order: string[] = [];
  const grouped = new Map<string, UsageSummaryRow[]>();

  rows.forEach((row) => {
    const key = row.keys[primary] ?? '';
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
      return;
    }
    order.push(key);
    grouped.set(key, [row]);
  });

  return order.map((key) => {
    const bucket = grouped.get(key) ?? [];
    const metrics = combineUsageMetrics(bucket);
    const firstAt = bucket.reduce((value, row) => earliest(value, row.first_at), '');
    const lastAt = bucket.reduce((value, row) => latest(value, row.last_at), '');

    const children: UsageGroupChild[] = hasSecondary
      ? bucket.map((row) => ({
          key: row.keys[secondary as UsageGroupColumn] ?? '',
          metrics: {
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
          },
          firstAt: row.first_at,
          lastAt: row.last_at,
        }))
      : [];

    return { key, metrics, children, firstAt, lastAt };
  });
};

export type UsageSortDirection = 'asc' | 'desc';

/** A table column can sort on a metric or on the group key's display label. */
export type UsageSortColumn = { kind: 'key' } | { kind: 'metric'; id: keyof UsageMetrics };

export interface SortUsageGroupsOptions {
  column: UsageSortColumn;
  direction: UsageSortDirection;
  /** Display label for a node's key, so "sort by name" sorts what is on screen. */
  labelOf: (key: string) => string;
  /** Same, for the secondary dimension. Falls back to `labelOf`. */
  childLabelOf?: (key: string) => string;
}

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sort nodes and, with the same column, their children.
 *
 * Sorting the children too is what makes an expanded row readable: a device
 * sorted to the top by token count whose models were left in server order
 * invites the reader to compare the wrong numbers.
 */
export const sortUsageGroups = (
  nodes: readonly UsageGroupNode[],
  options: SortUsageGroupsOptions
): UsageGroupNode[] => {
  const { column, direction, labelOf } = options;
  const childLabelOf = options.childLabelOf ?? labelOf;
  const sign = direction === 'asc' ? 1 : -1;

  const comparerFor =
    (label: (key: string) => string) =>
    (
      left: { key: string; metrics: UsageMetrics },
      right: { key: string; metrics: UsageMetrics }
    ): number => {
      if (column.kind === 'key') {
        return sign * compareText(label(left.key), label(right.key));
      }
      const delta =
        readUsageMetric(left.metrics, column.id) - readUsageMetric(right.metrics, column.id);
      // Ties fall back to the label so repeated renders keep a stable order.
      if (delta === 0) return compareText(label(left.key), label(right.key));
      return sign * delta;
    };

  const compareNodes = comparerFor(labelOf);
  const compareChildren = comparerFor(childLabelOf);

  return nodes
    .map((node) => ({ ...node, children: [...node.children].sort(compareChildren) }))
    .sort(compareNodes);
};
