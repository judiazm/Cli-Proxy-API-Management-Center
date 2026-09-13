/**
 * The whole view, in the address bar.
 *
 * Everything the page shows is a function of this object: the window, the
 * grouping, the metric, the filters, the sort, the tab. Keeping it in the query
 * string means a view is a link. "Codex is eating the Claude quota, look" stops
 * being six instructions and becomes a URL, and the browser's back button
 * undoes a filter, which is what a reader expects it to do.
 *
 * localStorage holds the last-used view as a fallback only. It answers the
 * first visit of a session, never a visit that arrived with parameters, or a
 * shared link would quietly turn into whatever the recipient looked at last.
 *
 * Every value read back in is validated against the same catalogues the
 * controls are built from, so a hand-edited or stale URL degrades to the
 * default rather than to a request the store will reject.
 */

import type { UsageFilters, UsageGroupColumn, UsageMetrics, UsageTimeBucket } from '@/services/api';
import { USAGE_LIST_FILTERS } from '@/services/api';
import {
  DEFAULT_USAGE_METRIC,
  findUsageDimension,
  isUsageDimensionId,
  isUsageMetricId,
} from './dimensions';
import type { UsageSortColumn, UsageSortDirection } from './groupTree';
import { isUsageRangePreset, type UsageRangePreset } from './timeRange';

export const USAGE_TABS = ['table', 'timeline', 'matrix', 'requests'] as const;

export type UsageTabId = (typeof USAGE_TABS)[number];

export const isUsageTabId = (value: unknown): value is UsageTabId =>
  typeof value === 'string' && (USAGE_TABS as readonly string[]).includes(value);

export type UsageBucketChoice = UsageTimeBucket | 'auto';

const BUCKET_CHOICES: readonly UsageBucketChoice[] = ['auto', 'hour', 'day', 'week', 'month'];

const isBucketChoice = (value: unknown): value is UsageBucketChoice =>
  typeof value === 'string' && (BUCKET_CHOICES as readonly string[]).includes(value);

export interface UsageViewState {
  tab: UsageTabId;
  range: UsageRangePreset;
  /** Custom-range bounds in milliseconds. Ignored unless `range` is `custom`. */
  customFromMs: number | null;
  customToMs: number | null;
  primary: UsageGroupColumn;
  secondary: UsageGroupColumn | null;
  metric: keyof UsageMetrics;
  bucket: UsageBucketChoice;
  matrixRow: UsageGroupColumn;
  matrixColumn: UsageGroupColumn;
  sortColumn: UsageSortColumn;
  sortDirection: UsageSortDirection;
  filters: UsageFilters;
}

export const DEFAULT_USAGE_VIEW: UsageViewState = {
  tab: 'table',
  range: '7d',
  customFromMs: null,
  customToMs: null,
  primary: 'api_key',
  secondary: 'model',
  metric: DEFAULT_USAGE_METRIC,
  bucket: 'auto',
  matrixRow: 'api_key',
  matrixColumn: 'model',
  sortColumn: { kind: 'metric', id: DEFAULT_USAGE_METRIC },
  sortDirection: 'desc',
  filters: {},
};

const PARAM = {
  tab: 'tab',
  range: 'range',
  from: 'from',
  to: 'to',
  primary: 'g',
  secondary: 'g2',
  metric: 'm',
  bucket: 'bucket',
  matrixRow: 'mrow',
  matrixColumn: 'mcol',
  sort: 'sort',
  direction: 'dir',
} as const;

const readDimension = (value: string | null, fallback: UsageGroupColumn): UsageGroupColumn =>
  isUsageDimensionId(value) ? value : fallback;

const readMs = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readSortColumn = (value: string | null, metric: keyof UsageMetrics): UsageSortColumn => {
  if (value === 'key') return { kind: 'key' };
  if (isUsageMetricId(value)) return { kind: 'metric', id: value };
  return { kind: 'metric', id: metric };
};

const readFilters = (params: URLSearchParams): UsageFilters => {
  const filters: UsageFilters = {};

  USAGE_LIST_FILTERS.forEach((name) => {
    const values = params.getAll(name).filter((value) => value.trim() !== '');
    if (values.length > 0) filters[name] = values;
  });

  const failed = params.get('failed');
  if (failed === 'true') filters.failed = true;
  else if (failed === 'false') filters.failed = false;

  const stream = params.get('stream');
  if (stream === 'true') filters.stream = true;
  else if (stream === 'false') filters.stream = false;

  return filters;
};

/** True when the URL says anything at all about this page's view. */
export const hasUsageViewParams = (params: URLSearchParams): boolean => {
  const names: string[] = [...Object.values(PARAM), ...USAGE_LIST_FILTERS, 'failed', 'stream'];
  return names.some((name) => params.has(name));
};

export const readUsageViewState = (
  params: URLSearchParams,
  base: UsageViewState = DEFAULT_USAGE_VIEW
): UsageViewState => {
  const tabValue = params.get(PARAM.tab);
  const rangeValue = params.get(PARAM.range);
  const metricValue = params.get(PARAM.metric);
  const bucketValue = params.get(PARAM.bucket);
  const directionValue = params.get(PARAM.direction);

  const primary = readDimension(params.get(PARAM.primary), base.primary);
  const secondaryRaw = params.get(PARAM.secondary);
  const secondary =
    secondaryRaw === 'none'
      ? null
      : isUsageDimensionId(secondaryRaw)
        ? secondaryRaw
        : secondaryRaw === null
          ? base.secondary
          : null;

  const metric = isUsageMetricId(metricValue) ? metricValue : base.metric;

  return {
    tab: isUsageTabId(tabValue) ? tabValue : base.tab,
    range: isUsageRangePreset(rangeValue) ? rangeValue : base.range,
    customFromMs: readMs(params.get(PARAM.from)) ?? base.customFromMs,
    customToMs: readMs(params.get(PARAM.to)) ?? base.customToMs,
    primary,
    // A secondary equal to the primary would ask the store to group by the
    // same column twice and render every parent with one identical child.
    secondary: secondary === primary ? null : secondary,
    metric,
    bucket: isBucketChoice(bucketValue) ? bucketValue : base.bucket,
    matrixRow: readDimension(params.get(PARAM.matrixRow), base.matrixRow),
    matrixColumn: readDimension(params.get(PARAM.matrixColumn), base.matrixColumn),
    sortColumn: params.has(PARAM.sort)
      ? readSortColumn(params.get(PARAM.sort), metric)
      : base.sortColumn,
    sortDirection:
      directionValue === 'asc' ? 'asc' : directionValue === 'desc' ? 'desc' : base.sortDirection,
    filters: readFilters(params),
  };
};

/**
 * State to query string, omitting anything still at its default.
 *
 * A URL that repeats the defaults is longer, harder to read, and freezes them:
 * a link shared today would keep pinning `range=7d` after the default changed.
 */
export const writeUsageViewParams = (state: UsageViewState): URLSearchParams => {
  const params = new URLSearchParams();
  const base = DEFAULT_USAGE_VIEW;

  if (state.tab !== base.tab) params.set(PARAM.tab, state.tab);
  if (state.range !== base.range) params.set(PARAM.range, state.range);
  if (state.range === 'custom') {
    if (state.customFromMs !== null) params.set(PARAM.from, String(state.customFromMs));
    if (state.customToMs !== null) params.set(PARAM.to, String(state.customToMs));
  }
  if (state.primary !== base.primary) params.set(PARAM.primary, state.primary);
  if (state.secondary !== base.secondary) {
    params.set(PARAM.secondary, state.secondary ?? 'none');
  }
  if (state.metric !== base.metric) params.set(PARAM.metric, state.metric);
  if (state.bucket !== base.bucket) params.set(PARAM.bucket, state.bucket);
  if (state.matrixRow !== base.matrixRow) params.set(PARAM.matrixRow, state.matrixRow);
  if (state.matrixColumn !== base.matrixColumn) params.set(PARAM.matrixColumn, state.matrixColumn);

  const sortValue = state.sortColumn.kind === 'key' ? 'key' : state.sortColumn.id;
  const baseSortValue = base.sortColumn.kind === 'key' ? 'key' : base.sortColumn.id;
  if (sortValue !== baseSortValue) params.set(PARAM.sort, sortValue);
  if (state.sortDirection !== base.sortDirection) params.set(PARAM.direction, state.sortDirection);

  USAGE_LIST_FILTERS.forEach((name) => {
    (state.filters[name] ?? []).forEach((value) => {
      if (value.trim()) params.append(name, value);
    });
  });
  if (typeof state.filters.failed === 'boolean') {
    params.set('failed', String(state.filters.failed));
  }
  if (typeof state.filters.stream === 'boolean') {
    params.set('stream', String(state.filters.stream));
  }

  return params;
};

/* ------------------------------------------------------------------ *
 * Last-used view
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'usagePage.view';

export const readStoredUsageView = (): UsageViewState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Stored as a query string rather than JSON so one validator covers both
    // paths: a stale stored view is checked exactly like a hand-edited URL.
    return readUsageViewState(new URLSearchParams(raw));
  } catch {
    return null;
  }
};

export const writeStoredUsageView = (state: UsageViewState) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, writeUsageViewParams(state).toString());
  } catch {
    // A private window with storage blocked still gets a working page.
  }
};

/* ------------------------------------------------------------------ *
 * Filter chips
 * ------------------------------------------------------------------ */

export interface UsageFilterChip {
  /** The filter this chip belongs to; the boolean filters use their own name. */
  name: (typeof USAGE_LIST_FILTERS)[number] | 'failed' | 'stream';
  /** Raw value, as sent to the store. `true`/`false` for the boolean filters. */
  value: string;
}

export const usageFilterChips = (filters: UsageFilters): UsageFilterChip[] => {
  const chips: UsageFilterChip[] = [];

  USAGE_LIST_FILTERS.forEach((name) => {
    (filters[name] ?? []).forEach((value) => chips.push({ name, value }));
  });
  if (typeof filters.failed === 'boolean') {
    chips.push({ name: 'failed', value: String(filters.failed) });
  }
  if (typeof filters.stream === 'boolean') {
    chips.push({ name: 'stream', value: String(filters.stream) });
  }

  return chips;
};

/** Add a value to a repeatable filter, ignoring a duplicate. */
export const addUsageFilter = (
  filters: UsageFilters,
  name: (typeof USAGE_LIST_FILTERS)[number],
  value: string
): UsageFilters => {
  const trimmed = value.trim();
  if (!trimmed) return filters;
  const current = filters[name] ?? [];
  if (current.includes(trimmed)) return filters;
  return { ...filters, [name]: [...current, trimmed] };
};

export const removeUsageFilter = (filters: UsageFilters, chip: UsageFilterChip): UsageFilters => {
  if (chip.name === 'failed' || chip.name === 'stream') {
    const next = { ...filters };
    delete next[chip.name];
    return next;
  }

  const current = filters[chip.name] ?? [];
  const remaining = current.filter((value) => value !== chip.value);
  const next = { ...filters };
  if (remaining.length > 0) next[chip.name] = remaining;
  else delete next[chip.name];
  return next;
};

/**
 * The filter a group dimension's value corresponds to.
 *
 * Clicking a row in the table narrows to that row, which only works for the
 * dimensions the store also accepts as a filter. `failed` and `stream` are
 * groupable but filter as booleans, so they are handled by name.
 */
export const filterNameForDimension = (
  dimension: UsageGroupColumn
): (typeof USAGE_LIST_FILTERS)[number] | 'failed' | 'stream' | null => {
  if (dimension === 'failed' || dimension === 'stream') return dimension;
  const def = findUsageDimension(dimension);
  if (!def || !def.filterable) return null;
  return (USAGE_LIST_FILTERS as readonly string[]).includes(dimension)
    ? (dimension as (typeof USAGE_LIST_FILTERS)[number])
    : null;
};

/** Narrow the view to one value of a dimension, as a row click does. */
export const applyUsageDrilldown = (
  filters: UsageFilters,
  dimension: UsageGroupColumn,
  value: string
): UsageFilters => {
  const name = filterNameForDimension(dimension);
  if (!name) return filters;

  if (name === 'failed' || name === 'stream') {
    const normalized = value.trim().toLowerCase();
    const flag = normalized === '1' || normalized === 'true' || normalized === 'yes';
    return { ...filters, [name]: flag };
  }

  return addUsageFilter(filters, name, value);
};
