/**
 * What the page can group by and what it can measure.
 *
 * Both lists are subsets of the contract's vocabulary, chosen for the question
 * this page exists to answer (per device and per model) rather than mirroring
 * every column the store happens to keep. `column` is the wire name; `id` is
 * the same string, kept separate so the UI never has to care that they match.
 */

import type { UsageGroupColumn, UsageMetrics } from '@/services/api';

export interface UsageDimensionDef {
  id: UsageGroupColumn;
  column: UsageGroupColumn;
  labelKey: string;
  /** Time buckets are picked from a separate control, not the group-by menu. */
  isTimeBucket: boolean;
  /** Whether this dimension can be narrowed with a filter chip. */
  filterable: boolean;
}

const def = (
  id: UsageGroupColumn,
  labelKey: string,
  options: { isTimeBucket?: boolean; filterable?: boolean } = {}
): UsageDimensionDef => ({
  id,
  column: id,
  labelKey,
  isTimeBucket: options.isTimeBucket ?? false,
  filterable: options.filterable ?? false,
});

/** Dimensions offered as a primary or secondary grouping, in menu order. */
export const USAGE_DIMENSIONS: readonly UsageDimensionDef[] = [
  def('api_key', 'usage.dim_device', { filterable: true }),
  def('model', 'usage.dim_model', { filterable: true }),
  def('auth_id', 'usage.dim_account', { filterable: true }),
  def('provider', 'usage.dim_provider', { filterable: true }),
  def('reasoning_effort', 'usage.dim_effort', { filterable: true }),
  def('session_id', 'usage.dim_session', { filterable: true }),
  def('failed', 'usage.dim_status'),
  def('stream', 'usage.dim_stream'),
  def('hour', 'usage.dim_hour', { isTimeBucket: true }),
  def('day', 'usage.dim_day', { isTimeBucket: true }),
  def('week', 'usage.dim_week', { isTimeBucket: true }),
  def('month', 'usage.dim_month', { isTimeBucket: true }),
];

const DIMENSION_BY_ID = new Map(USAGE_DIMENSIONS.map((dimension) => [dimension.id, dimension]));

export const findUsageDimension = (id: string): UsageDimensionDef | undefined =>
  DIMENSION_BY_ID.get(id as UsageGroupColumn);

export const isUsageDimensionId = (value: unknown): value is UsageGroupColumn =>
  typeof value === 'string' && DIMENSION_BY_ID.has(value as UsageGroupColumn);

/** Dimensions a filter chip can be built for, in chip-menu order. */
export const USAGE_FILTER_DIMENSIONS = USAGE_DIMENSIONS.filter((dimension) => dimension.filterable);

/**
 * Metrics, keyed by the response field they read.
 *
 * `additive` says whether a parent row may be produced by summing its
 * children. The averages are not additive; they are recombined by weighting on
 * request count, which is exact because each child's average is over exactly
 * that child's requests.
 */
export interface UsageMetricDef {
  id: keyof UsageMetrics;
  labelKey: string;
  shortLabelKey: string;
  additive: boolean;
  /** Milliseconds render as a duration, everything else as a count. */
  unit: 'count' | 'tokens' | 'ms';
}

export const USAGE_METRICS: readonly UsageMetricDef[] = [
  {
    id: 'requests',
    labelKey: 'usage.metric_requests',
    shortLabelKey: 'usage.metric_requests_short',
    additive: true,
    unit: 'count',
  },
  {
    id: 'total_tokens',
    labelKey: 'usage.metric_total_tokens',
    shortLabelKey: 'usage.metric_total_tokens_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'input_tokens',
    labelKey: 'usage.metric_input_tokens',
    shortLabelKey: 'usage.metric_input_tokens_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'output_tokens',
    labelKey: 'usage.metric_output_tokens',
    shortLabelKey: 'usage.metric_output_tokens_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'cache_read_tokens',
    labelKey: 'usage.metric_cache_read',
    shortLabelKey: 'usage.metric_cache_read_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'cache_creation_tokens',
    labelKey: 'usage.metric_cache_write',
    shortLabelKey: 'usage.metric_cache_write_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'reasoning_tokens',
    labelKey: 'usage.metric_reasoning',
    shortLabelKey: 'usage.metric_reasoning_short',
    additive: true,
    unit: 'tokens',
  },
  {
    id: 'failed',
    labelKey: 'usage.metric_failures',
    shortLabelKey: 'usage.metric_failures_short',
    additive: true,
    unit: 'count',
  },
  {
    id: 'latency_ms_avg',
    labelKey: 'usage.metric_latency',
    shortLabelKey: 'usage.metric_latency_short',
    additive: false,
    unit: 'ms',
  },
  {
    id: 'ttft_ms_avg',
    labelKey: 'usage.metric_ttft',
    shortLabelKey: 'usage.metric_ttft_short',
    additive: false,
    unit: 'ms',
  },
];

const METRIC_BY_ID = new Map(USAGE_METRICS.map((metric) => [metric.id, metric]));

export const findUsageMetric = (id: string): UsageMetricDef | undefined =>
  METRIC_BY_ID.get(id as keyof UsageMetrics);

export const isUsageMetricId = (value: unknown): value is keyof UsageMetrics =>
  typeof value === 'string' && METRIC_BY_ID.has(value as keyof UsageMetrics);

export const DEFAULT_USAGE_METRIC: keyof UsageMetrics = 'total_tokens';
