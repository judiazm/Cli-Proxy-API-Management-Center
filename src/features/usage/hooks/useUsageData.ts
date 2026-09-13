/**
 * Every read the page makes, and the order it makes them in.
 *
 * Three shapes of request, not four: the grouped summary a tab needs, a second
 * summary over the window before this one (the only way to say whether a number
 * is up or down), and the raw log when the Requests tab is open. The current
 * window's totals come back inside the grouped call, so the strip above the
 * tabs costs no request of its own.
 *
 * The store being switched off is not treated as an error. It arrives typed
 * from the service layer and is handed to the page as a state, because the
 * useful response is a config block, not a retry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  usageStoreApi,
  UsageStoreDisabledError,
  type UsageGroupColumn,
  type UsageMetaResponse,
  type UsageMetrics,
  type UsageRequestRow,
  type UsageSummaryResponse,
  type UsageTimeBucket,
} from '@/services/api';
import { useNotificationStore } from '@/stores';
import {
  autoUsageBucket,
  browserTimeZone,
  parseInstantMs,
  previousUsageRange,
  resolveUsageRange,
  type ResolvedUsageRange,
} from '../logic/timeRange';
import type { UsageViewState } from '../logic/viewState';

/** Group rows the table asks for. 500 is the store's own default. */
const TABLE_ROW_LIMIT = 500;
/** The timeline and the matrix multiply dimensions, so they need more rows. */
const GRID_ROW_LIMIT = 2000;
/** One page of the raw log. */
const REQUESTS_PAGE_SIZE = 200;

export interface UsageData {
  meta: UsageMetaResponse | null;
  /** The gateway answered 503: `usage-store.enabled` is false. */
  disabled: boolean;
  loading: boolean;
  error: string;
  summary: UsageSummaryResponse | null;
  /** Totals for the equal-length window before this one, for the deltas. */
  previousTotals: UsageMetrics | null;
  requests: UsageRequestRow[];
  requestsCursor: number | null;
  requestsLoading: boolean;
  loadMoreRequests: () => Promise<void>;
  reload: () => Promise<void>;
  range: ResolvedUsageRange;
  /** The bucket actually in force, with `auto` already resolved. */
  bucket: UsageTimeBucket;
  timeZone: string;
}

/** The dimensions a tab groups by, and how many rows it needs. */
const groupPlan = (
  view: UsageViewState,
  bucket: UsageTimeBucket
): { groupBy: UsageGroupColumn[]; limit: number } => {
  switch (view.tab) {
    case 'timeline':
      return { groupBy: [bucket, view.primary], limit: GRID_ROW_LIMIT };
    case 'matrix':
      return {
        groupBy:
          view.matrixRow === view.matrixColumn
            ? [view.matrixRow]
            : [view.matrixRow, view.matrixColumn],
        limit: GRID_ROW_LIMIT,
      };
    case 'requests':
      // The log carries its own rows; this call exists only for the totals.
      return { groupBy: [], limit: 1 };
    case 'table':
    default:
      return {
        groupBy: view.secondary ? [view.primary, view.secondary] : [view.primary],
        limit: TABLE_ROW_LIMIT,
      };
  }
};

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function useUsageData(view: UsageViewState): UsageData {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [meta, setMeta] = useState<UsageMetaResponse | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [previousTotals, setPreviousTotals] = useState<UsageMetrics | null>(null);
  const [requests, setRequests] = useState<UsageRequestRow[]>([]);
  const [requestsCursor, setRequestsCursor] = useState<number | null>(null);
  const [requestsLoading, setRequestsLoading] = useState(false);

  // Bumped on every manual refresh so the loader re-runs with a fresh clock.
  const [refreshToken, setRefreshToken] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const timeZone = useMemo(() => browserTimeZone(), []);
  const oldestMs = useMemo(() => parseInstantMs(meta?.oldest), [meta?.oldest]);

  const range = useMemo(
    () =>
      resolveUsageRange(view.range, {
        nowMs,
        customFromMs: view.customFromMs,
        customToMs: view.customToMs,
        oldestMs,
      }),
    [view.range, view.customFromMs, view.customToMs, nowMs, oldestMs]
  );

  const bucket = useMemo(
    () => (view.bucket === 'auto' ? autoUsageBucket(range) : view.bucket),
    [view.bucket, range]
  );

  const plan = useMemo(() => groupPlan(view, bucket), [view, bucket]);

  // Filters are rebuilt on every URL read, so the effect keys off their
  // content rather than their identity.
  const filtersKey = useMemo(() => JSON.stringify(view.filters), [view.filters]);
  const groupKey = plan.groupBy.join(',');

  const requestRef = useRef(0);

  // `meta` is read once per refresh: it describes the store, not the window.
  useEffect(() => {
    let cancelled = false;
    usageStoreApi
      .getMeta()
      .then((next) => {
        if (cancelled) return;
        setMeta(next);
        setDisabled(!next.enabled);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UsageStoreDisabledError) {
          setMeta(null);
          setDisabled(true);
          return;
        }
        setMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  useEffect(() => {
    const requestId = (requestRef.current += 1);
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setError('');

      const filters = view.filters;
      const previous = previousUsageRange(range);

      try {
        const [current, prior] = await Promise.all([
          usageStoreApi.getSummary({
            from: range.fromMs,
            to: range.toMs,
            tz: timeZone,
            groupBy: plan.groupBy,
            orderBy: view.metric,
            order: 'desc',
            limit: plan.limit,
            filters,
          }),
          previous
            ? usageStoreApi.getSummary({
                from: previous.fromMs,
                to: previous.toMs,
                tz: timeZone,
                filters,
              })
            : Promise.resolve(null),
        ]);

        if (cancelled || requestRef.current !== requestId) return;

        setSummary(current);
        setPreviousTotals(prior ? prior.totals : null);
        setDisabled(false);
      } catch (err: unknown) {
        if (cancelled || requestRef.current !== requestId) return;

        if (err instanceof UsageStoreDisabledError) {
          setDisabled(true);
          setSummary(null);
          setPreviousTotals(null);
          return;
        }

        const message = describeError(err, t('usage.load_failed'));
        setSummary(null);
        setPreviousTotals(null);
        setError(message);
        showNotification(message, 'error');
      } finally {
        if (!cancelled && requestRef.current === requestId) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // `filtersKey` and `groupKey` stand in for the objects they summarise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    range.fromMs,
    range.toMs,
    timeZone,
    groupKey,
    plan.limit,
    view.metric,
    filtersKey,
    refreshToken,
    t,
    showNotification,
  ]);

  // The raw log is only fetched while its tab is open, and reset whenever the
  // window or the filters move: a cursor from the previous query would page
  // through rows the new query never asked for.
  const isRequestsTab = view.tab === 'requests';
  const requestsRef = useRef(0);

  useEffect(() => {
    if (!isRequestsTab) {
      setRequests([]);
      setRequestsCursor(null);
      return;
    }

    const requestId = (requestsRef.current += 1);
    let cancelled = false;

    const run = async () => {
      setRequestsLoading(true);
      try {
        const page = await usageStoreApi.getRequests({
          from: range.fromMs,
          to: range.toMs,
          tz: timeZone,
          limit: REQUESTS_PAGE_SIZE,
          filters: view.filters,
        });
        if (cancelled || requestsRef.current !== requestId) return;
        setRequests(page.rows);
        setRequestsCursor(page.next_before);
      } catch (err: unknown) {
        if (cancelled || requestsRef.current !== requestId) return;
        if (err instanceof UsageStoreDisabledError) {
          setDisabled(true);
          setRequests([]);
          setRequestsCursor(null);
          return;
        }
        const message = describeError(err, t('usage.load_failed'));
        setRequests([]);
        setRequestsCursor(null);
        setError(message);
        showNotification(message, 'error');
      } finally {
        if (!cancelled && requestsRef.current === requestId) setRequestsLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isRequestsTab,
    range.fromMs,
    range.toMs,
    timeZone,
    filtersKey,
    refreshToken,
    t,
    showNotification,
  ]);

  const loadMoreRequests = useCallback(async () => {
    if (requestsCursor === null || requestsLoading) return;
    const requestId = requestsRef.current;

    setRequestsLoading(true);
    try {
      const page = await usageStoreApi.getRequests({
        from: range.fromMs,
        to: range.toMs,
        tz: timeZone,
        limit: REQUESTS_PAGE_SIZE,
        before: requestsCursor,
        filters: view.filters,
      });
      // A filter or range change between click and answer invalidates the page.
      if (requestsRef.current !== requestId) return;
      setRequests((current) => [...current, ...page.rows]);
      setRequestsCursor(page.next_before);
    } catch (err: unknown) {
      if (requestsRef.current !== requestId) return;
      if (err instanceof UsageStoreDisabledError) {
        setDisabled(true);
        return;
      }
      showNotification(describeError(err, t('usage.load_failed')), 'error');
    } finally {
      if (requestsRef.current === requestId) setRequestsLoading(false);
    }
  }, [
    requestsCursor,
    requestsLoading,
    range.fromMs,
    range.toMs,
    timeZone,
    view.filters,
    showNotification,
    t,
  ]);

  const reload = useCallback(async () => {
    setNowMs(Date.now());
    setRefreshToken((token) => token + 1);
  }, []);

  return {
    meta,
    disabled,
    loading,
    error,
    summary,
    previousTotals,
    requests,
    requestsCursor,
    requestsLoading,
    loadMoreRequests,
    reload,
    range,
    bucket,
    timeZone,
  };
}
