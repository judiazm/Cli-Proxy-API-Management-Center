/**
 * Persistent usage store (`usage-store`) reads.
 *
 * The fork's proxy keeps one row per request in SQLite and exposes three
 * read-only management endpoints over it: an aggregate (`/summary`), the raw
 * log (`/requests`), and a description of what the store holds (`/meta`).
 * Field names here are the contract's, not guesses. The wire shape is
 * documented in `../CLIProxyAPI/PATCHES.md`, "Patch 3: persistent usage store".
 *
 * Two boundary jobs live in this module and nowhere else:
 *
 * - Repeatable filters. `api_key`, `model`, `auth_id` and friends are OR'd
 *   within a parameter and AND'd across parameters, which on the wire means
 *   the same parameter name repeated, not a comma list. `group_by` is the one
 *   genuinely comma-separated parameter.
 * - The disabled store. The endpoints answer 503 when `usage-store.enabled` is
 *   false. That is a configuration state the page has something useful to say
 *   about, not a failure, so it arrives as its own error type rather than as a
 *   generic message the UI would have to string-match.
 */

import { apiClient } from './client';
import type { ApiError } from '@/types';

const BASE = '/usage-store';

/** Dimensions `group_by` accepts, in the order the contract lists them. */
export const USAGE_GROUP_COLUMNS = [
  'api_key',
  'model',
  'alias',
  'auth_id',
  'provider',
  'auth_type',
  'endpoint',
  'session_id',
  'reasoning_effort',
  'service_tier',
  'stream',
  'failed',
  'day',
  'hour',
  'week',
  'month',
] as const;

export type UsageGroupColumn = (typeof USAGE_GROUP_COLUMNS)[number];

/** The four `group_by` values that bucket by time rather than by a column. */
export const USAGE_TIME_BUCKETS = ['hour', 'day', 'week', 'month'] as const;

export type UsageTimeBucket = (typeof USAGE_TIME_BUCKETS)[number];

/** Filters that repeat: OR within one name, AND across names. */
export const USAGE_LIST_FILTERS = [
  'api_key',
  'model',
  'alias',
  'auth_id',
  'provider',
  'auth_type',
  'session_id',
  'reasoning_effort',
  'endpoint',
] as const;

export type UsageListFilter = (typeof USAGE_LIST_FILTERS)[number];

/**
 * Filters as the endpoints accept them.
 *
 * The list-valued names repeat on the wire; `failed` and `stream` are single
 * booleans (the contract says so explicitly) and are omitted when undefined,
 * which is the "either" case rather than a third value.
 */
export type UsageFilters = Partial<Record<UsageListFilter, readonly string[]>> & {
  failed?: boolean;
  stream?: boolean;
};

export interface UsageRangeParams {
  /** RFC3339 or unix milliseconds. Defaults server-side to `to` − 24 h. */
  from?: string | number;
  /** RFC3339 or unix milliseconds. Defaults server-side to now. */
  to?: string | number;
  /** IANA zone name for `day`/`hour`/`week`/`month` bucketing. Default UTC. */
  tz?: string;
}

export interface UsageSummaryParams extends UsageRangeParams {
  /** 0–3 dimensions. Empty means a single totals row. */
  groupBy?: readonly UsageGroupColumn[];
  /** A metric name or a group column. Server default is `total_tokens`. */
  orderBy?: string;
  order?: 'asc' | 'desc';
  /** Server default 500, max 5000. */
  limit?: number;
  filters?: UsageFilters;
}

export interface UsageRequestsParams extends UsageRangeParams {
  /** Server default 200, max 2000. */
  limit?: number;
  /** Row id cursor: return rows strictly older than this id. */
  before?: number;
  filters?: UsageFilters;
}

/** The additive and averaged metrics every summary row and the totals carry. */
export interface UsageMetrics {
  requests: number;
  failed: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  latency_ms_avg: number;
  /** Null when the bucket was too large for the server to compute it. */
  latency_ms_p95: number | null;
  ttft_ms_avg: number;
}

export interface UsageSummaryRow extends UsageMetrics {
  /** One entry per `group_by` dimension, normalized to a string. */
  keys: Record<string, string>;
  first_at: string;
  last_at: string;
}

export interface UsageSummaryResponse {
  from: string;
  to: string;
  tz: string;
  group_by: UsageGroupColumn[];
  rows: UsageSummaryRow[];
  totals: UsageMetrics;
}

/** One `usage_requests` row, with `ts` as RFC3339 in place of `ts_ms`. */
export interface UsageRequestRow {
  id: number;
  ts: string;
  api_key: string;
  model: string;
  alias: string;
  /** The auth file's name relative to the auth dir, extension included. */
  auth_id: string;
  /**
   * Opaque credential fingerprint, `hex(sha256(seed)[:8])`, not a number and
   * not reversible to a name. Anything displayed uses `auth_id` instead.
   */
  auth_index: string;
  provider: string;
  auth_type: string;
  executor_type: string;
  endpoint: string;
  request_id: string;
  session_id: string;
  parent_session_id: string;
  reasoning_effort: string;
  service_tier: string;
  response_service_tier: string;
  stream: boolean;
  generate: boolean;
  failed: boolean;
  status_code: number;
  latency_ms: number;
  ttft_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  client_ip: string;
  user_agent: string;
}

export interface UsageRequestsResponse {
  rows: UsageRequestRow[];
  /** Cursor for the next page, or null at the end of the log. */
  next_before: number | null;
}

/** Distinct values seen in the last 90 days, per dimension. */
export type UsageDimensions = Partial<Record<UsageListFilter, string[]>>;

export interface UsageMetaResponse {
  enabled: boolean;
  path: string;
  retention_days: number;
  rows: number;
  oldest: string | null;
  newest: string | null;
  size_bytes: number;
  dimensions: UsageDimensions;
}

/**
 * The store is off in the gateway's config.
 *
 * Thrown for the contract's 503 so the page can offer the config block instead
 * of reporting a transport failure it cannot help with.
 */
export class UsageStoreDisabledError extends Error {
  readonly status = 503;

  constructor(message = 'usage store disabled') {
    super(message);
    this.name = 'UsageStoreDisabledError';
  }
}

const readApiErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as ApiError).status;
  return typeof status === 'number' ? status : undefined;
};

/** Re-throw a 503 as the typed disabled error; everything else passes through. */
const rethrow = (error: unknown): never => {
  if (readApiErrorStatus(error) === 503) {
    const message = error instanceof Error ? error.message : '';
    throw new UsageStoreDisabledError(message || undefined);
  }
  throw error;
};

const appendRange = (params: URLSearchParams, range: UsageRangeParams) => {
  if (range.from !== undefined && range.from !== '') params.append('from', String(range.from));
  if (range.to !== undefined && range.to !== '') params.append('to', String(range.to));
  if (range.tz) params.append('tz', range.tz);
};

/**
 * Repeatable filters, repeated.
 *
 * Blank values are dropped rather than sent: an empty filter value would ask
 * the store for rows whose api_key is the empty string, which is a different
 * question from "no filter on api_key".
 */
const appendFilters = (params: URLSearchParams, filters: UsageFilters | undefined) => {
  if (!filters) return;

  USAGE_LIST_FILTERS.forEach((name) => {
    const values = filters[name];
    if (!values) return;
    values.forEach((value) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) params.append(name, trimmed);
    });
  });

  if (typeof filters.failed === 'boolean') params.append('failed', String(filters.failed));
  if (typeof filters.stream === 'boolean') params.append('stream', String(filters.stream));
};

/** Query string for `/summary`. Exported because the encoding is worth testing. */
export const buildUsageSummaryQuery = (params: UsageSummaryParams): URLSearchParams => {
  const search = new URLSearchParams();
  appendRange(search, params);

  if (params.groupBy && params.groupBy.length > 0) {
    search.append('group_by', params.groupBy.join(','));
  }
  if (params.orderBy) search.append('order_by', params.orderBy);
  if (params.order) search.append('order', params.order);
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    search.append('limit', String(Math.trunc(params.limit)));
  }

  appendFilters(search, params.filters);
  return search;
};

/** Query string for `/requests`. */
export const buildUsageRequestsQuery = (params: UsageRequestsParams): URLSearchParams => {
  const search = new URLSearchParams();
  appendRange(search, params);

  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    search.append('limit', String(Math.trunc(params.limit)));
  }
  if (typeof params.before === 'number' && Number.isFinite(params.before)) {
    search.append('before', String(Math.trunc(params.before)));
  }

  appendFilters(search, params.filters);
  return search;
};

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
};

/** SQLite stores these as 0/1; a Go bool would arrive as true/false. Accept both. */
const toFlag = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeMetrics = (raw: Record<string, unknown>): UsageMetrics => ({
  requests: toNumber(raw.requests),
  failed: toNumber(raw.failed),
  input_tokens: toNumber(raw.input_tokens),
  cache_read_tokens: toNumber(raw.cache_read_tokens),
  cache_creation_tokens: toNumber(raw.cache_creation_tokens),
  cached_tokens: toNumber(raw.cached_tokens),
  output_tokens: toNumber(raw.output_tokens),
  reasoning_tokens: toNumber(raw.reasoning_tokens),
  total_tokens: toNumber(raw.total_tokens),
  latency_ms_avg: toNumber(raw.latency_ms_avg),
  latency_ms_p95: toNullableNumber(raw.latency_ms_p95),
  ttft_ms_avg: toNumber(raw.ttft_ms_avg),
});

/**
 * Group keys come back typed as their column: `stream` and `failed` as
 * booleans or 0/1, the time buckets as RFC3339 strings, the rest as text.
 * The views only ever compare and render them, so they are flattened to
 * strings here rather than every consumer re-narrowing the union.
 */
const normalizeKeys = (raw: unknown): Record<string, string> => {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, toText(value)]));
};

const normalizeSummaryRow = (raw: unknown): UsageSummaryRow => {
  const record = isRecord(raw) ? raw : {};
  return {
    ...normalizeMetrics(record),
    keys: normalizeKeys(record.keys),
    first_at: toText(record.first_at),
    last_at: toText(record.last_at),
  };
};

const normalizeSummaryResponse = (raw: unknown): UsageSummaryResponse => {
  const record = isRecord(raw) ? raw : {};
  const groupBy = Array.isArray(record.group_by)
    ? record.group_by.filter((value): value is UsageGroupColumn =>
        (USAGE_GROUP_COLUMNS as readonly string[]).includes(toText(value))
      )
    : [];

  return {
    from: toText(record.from),
    to: toText(record.to),
    tz: toText(record.tz),
    group_by: groupBy,
    rows: Array.isArray(record.rows) ? record.rows.map(normalizeSummaryRow) : [],
    totals: normalizeMetrics(isRecord(record.totals) ? record.totals : {}),
  };
};

const normalizeRequestRow = (raw: unknown): UsageRequestRow => {
  const record = isRecord(raw) ? raw : {};

  return {
    id: toNumber(record.id),
    ts: toText(record.ts),
    api_key: toText(record.api_key),
    model: toText(record.model),
    alias: toText(record.alias),
    auth_id: toText(record.auth_id),
    auth_index: toText(record.auth_index),
    provider: toText(record.provider),
    auth_type: toText(record.auth_type),
    executor_type: toText(record.executor_type),
    endpoint: toText(record.endpoint),
    request_id: toText(record.request_id),
    session_id: toText(record.session_id),
    parent_session_id: toText(record.parent_session_id),
    reasoning_effort: toText(record.reasoning_effort),
    service_tier: toText(record.service_tier),
    response_service_tier: toText(record.response_service_tier),
    stream: toFlag(record.stream),
    generate: toFlag(record.generate),
    failed: toFlag(record.failed),
    status_code: toNumber(record.status_code),
    latency_ms: toNumber(record.latency_ms),
    ttft_ms: toNumber(record.ttft_ms),
    input_tokens: toNumber(record.input_tokens),
    output_tokens: toNumber(record.output_tokens),
    reasoning_tokens: toNumber(record.reasoning_tokens),
    cached_tokens: toNumber(record.cached_tokens),
    cache_read_tokens: toNumber(record.cache_read_tokens),
    cache_creation_tokens: toNumber(record.cache_creation_tokens),
    total_tokens: toNumber(record.total_tokens),
    client_ip: toText(record.client_ip),
    user_agent: toText(record.user_agent),
  };
};

const normalizeRequestsResponse = (raw: unknown): UsageRequestsResponse => {
  const record = isRecord(raw) ? raw : {};
  return {
    rows: Array.isArray(record.rows) ? record.rows.map(normalizeRequestRow) : [],
    next_before: toNullableNumber(record.next_before),
  };
};

const normalizeDimensions = (raw: unknown): UsageDimensions => {
  if (!isRecord(raw)) return {};

  return USAGE_LIST_FILTERS.reduce<UsageDimensions>((dimensions, name) => {
    const values = raw[name];
    if (!Array.isArray(values)) return dimensions;
    const cleaned = values.map(toText).filter((value) => value !== '');
    if (cleaned.length > 0) dimensions[name] = cleaned;
    return dimensions;
  }, {});
};

const normalizeMetaResponse = (raw: unknown): UsageMetaResponse => {
  const record = isRecord(raw) ? raw : {};
  return {
    enabled: toFlag(record.enabled),
    path: toText(record.path),
    retention_days: toNumber(record.retention_days),
    rows: toNumber(record.rows),
    oldest: toText(record.oldest) || null,
    newest: toText(record.newest) || null,
    size_bytes: toNumber(record.size_bytes),
    dimensions: normalizeDimensions(record.dimensions),
  };
};

const withQuery = (path: string, search: URLSearchParams): string => {
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

export const usageStoreApi = {
  async getSummary(params: UsageSummaryParams = {}): Promise<UsageSummaryResponse> {
    try {
      const raw = await apiClient.get<unknown>(
        withQuery(`${BASE}/summary`, buildUsageSummaryQuery(params))
      );
      return normalizeSummaryResponse(raw);
    } catch (error) {
      return rethrow(error);
    }
  },

  async getRequests(params: UsageRequestsParams = {}): Promise<UsageRequestsResponse> {
    try {
      const raw = await apiClient.get<unknown>(
        withQuery(`${BASE}/requests`, buildUsageRequestsQuery(params))
      );
      return normalizeRequestsResponse(raw);
    } catch (error) {
      return rethrow(error);
    }
  },

  async getMeta(): Promise<UsageMetaResponse> {
    try {
      const raw = await apiClient.get<unknown>(`${BASE}/meta`);
      return normalizeMetaResponse(raw);
    } catch (error) {
      return rethrow(error);
    }
  },
};
