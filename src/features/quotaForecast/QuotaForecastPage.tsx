import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import {
  UsageStoreDisabledError,
  apiClient,
  authFilesApi,
  quotaHistoryApi,
  type QuotaHistoryResponse,
  usageStoreApi,
  type UsageSummaryResponse,
} from '@/services/api';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import {
  TYPE_COLORS,
  claudePlanBadge,
  codexPlanBadge,
  displayCredentialLabel,
  formatRelativeInstant,
  quotaRemainingTone,
} from '@/utils/quota';
import type { QuotaPlanBadge } from '@/utils/quota/rowModel';
import bodyStyles from '@/features/quota/components/QuotaBody.module.scss';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { browserTimeZone } from '@/features/usage/logic/timeRange';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { formatUsageCount, formatUsageExact } from '@/features/usage/logic/formatUsage';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { readQuotaShowEmails } from '@/features/quota/uiState';
import { fetchPrefixes } from '@/features/pools/hooks/usePoolsData';
import {
  WEEK_MS,
  FORECAST_RECENT_MS,
  buildQuotaForecast,
  buildForecastUsageMetrics,
  simulatePools,
  startOfLocalWeek,
  type ForecastOutcome,
  type ForecastProvider,
  type ForecastHistoryState,
  type PoolOutlook,
  type QuotaForecast,
} from './forecast';
import styles from './QuotaForecastPage.module.scss';

const DAY_MS = 24 * 60 * 60_000;

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${Math.round(value)}%`;

type DisplayStatus = Exclude<ForecastOutcome, 'lasts-to-reset'> | 'tight' | 'on-track';

/** Most urgent first: out of quota, then earliest projected runout, then the rest. */
const STATUS_ORDER: Record<DisplayStatus, number> = {
  exhausted: 0,
  'before-reset': 1,
  tight: 2,
  'on-track': 3,
  unknown: 4,
};
const STATUS_KEYS = Object.keys(STATUS_ORDER) as DisplayStatus[];
/** At or above this calibrated chance, an account expected to last is still worth watching. */
const TIGHT_CHANCE = 0.35;

const displayStatus = (forecast: QuotaForecast): DisplayStatus =>
  forecast.outcome === 'lasts-to-reset'
    ? (forecast.runoutChance ?? 0) >= TIGHT_CHANCE
      ? 'tight'
      : 'on-track'
    : forecast.outcome;

type GroupBy = 'none' | 'provider' | 'tier' | 'pool';
const GROUP_OPTIONS: readonly GroupBy[] = ['none', 'provider', 'tier', 'pool'];
const GROUP_STORAGE_KEY = 'quotaForecast.groupBy';
const TIER_RANK = { elite: 0, premium: 1, plain: 2 } as const;

const readGroupBy = (): GroupBy => {
  try {
    const stored = window.localStorage.getItem(GROUP_STORAGE_KEY);
    return GROUP_OPTIONS.includes(stored as GroupBy) ? (stored as GroupBy) : 'none';
  } catch {
    return 'none';
  }
};

/** Plan badge finishes are finalized assets shared with the Quota page; borrow them. */
const planBadgeClass = (tier: QuotaPlanBadge['tier']): string =>
  tier === 'elite'
    ? bodyStyles.elitePlanValue
    : tier === 'premium'
      ? bodyStyles.premiumPlanValue
      : styles.planPlain;

/** Position of an instant inside the weekly cycle that ends at the reported reset. */
const cyclePercent = (instantMs: number, cycleStartMs: number): number =>
  Math.min(100, Math.max(0, ((instantMs - cycleStartMs) / WEEK_MS) * 100));

/** A duration in one unit people read at a glance: minutes, hours, or days. */
const formatSpan = (ms: number, locale?: string): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 48 * 60
        ? [Math.round(minutes / 60), 'hour']
        : [minutes / (24 * 60), 'day'];
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'long',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${Math.round(value)} ${unit}`;
  }
};

type ForecastEntry = QuotaFileEntry & { type: ForecastProvider };

const isForecastEntry = (entry: QuotaFileEntry): entry is ForecastEntry =>
  entry.type === 'claude' || entry.type === 'codex';

export function QuotaForecastPage() {
  const { t, i18n } = useTranslation();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const { batchLoading, loadQuota } = useQuotaBatchLoader();

  const [entries, setEntries] = useState<ForecastEntry[]>([]);
  const [prefixes, setPrefixes] = useState<Map<string, string>>(new Map());
  const [currentWeek, setCurrentWeek] = useState<UsageSummaryResponse | null>(null);
  const [recent, setRecent] = useState<UsageSummaryResponse | null>(null);
  const [history, setHistory] = useState<QuotaHistoryResponse | null>(null);
  const [historyState, setHistoryState] = useState<ForecastHistoryState>('loading');
  const [historyError, setHistoryError] = useState('');
  const [storeDiagnostics, setStoreDiagnostics] = useState<'healthy' | 'losses' | 'unavailable'>(
    'unavailable'
  );
  const [usageDisabled, setUsageDisabled] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const showEmails = readQuotaShowEmails();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const [groupBy, setGroupByState] = useState<GroupBy>(readGroupBy);
  const setGroupBy = (next: GroupBy) => {
    setGroupByState(next);
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, next);
    } catch {
      // Grouping still works for this visit without storage.
    }
  };

  const requestRef = useRef(0);

  const loadData = useCallback(async () => {
    const requestId = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    const current = () =>
      requestRef.current === requestId &&
      apiClient.getConnectionRevision() === revision &&
      useAuthStore.getState().connectionStatus === 'connected';
    if (connectionStatus !== 'connected') return;
    const now = Date.now();
    const recentFrom = now - WEEK_MS;
    const timeZone = browserTimeZone();
    setNowMs(now);
    setLoading(true);
    setError('');
    setUsageError('');
    setHistoryError('');
    setHistory(null);
    setHistoryState('loading');
    setStoreDiagnostics('unavailable');
    setCurrentWeek(null);
    setRecent(null);

    try {
      const files = await authFilesApi.list();
      if (!current()) return;
      const forecastEntries = classifyQuotaFiles(files?.files ?? []).filter(isForecastEntry);
      setEntries(forecastEntries);

      const prefixTask = (async () => {
        const resolved = await fetchPrefixes(forecastEntries.map((entry) => entry.file));
        if (!current()) return;
        setPrefixes(
          new Map(forecastEntries.map((entry, index) => [entry.file.name, resolved[index] ?? '']))
        );
      })();

      const usageTask = (async () => {
        try {
          const meta = await usageStoreApi.getMeta();
          if (!current()) return;
          if (!meta.enabled) {
            setUsageDisabled(true);
            return;
          }
          setStoreDiagnostics(
            !meta.health
              ? 'unavailable'
              : meta.health.dropped_total > 0 ||
                  meta.health.persistence_failed_rows > 0 ||
                  meta.health.persistence_failed_batches > 0
                ? 'losses'
                : 'healthy'
          );
          const [weekSummary, recentSummary] = await Promise.all([
            usageStoreApi.getSummary({
              from: startOfLocalWeek(now),
              to: now,
              tz: timeZone,
              groupBy: ['auth_id'],
              filters: { provider: ['claude', 'codex'] },
              limit: 5000,
            }),
            usageStoreApi.getSummary({
              from: recentFrom,
              to: now,
              tz: timeZone,
              groupBy: ['auth_id'],
              filters: { provider: ['claude', 'codex'] },
              limit: 5000,
            }),
          ]);
          if (!current()) return;
          setCurrentWeek(weekSummary);
          setRecent(recentSummary);
          setUsageDisabled(false);
        } catch (failure: unknown) {
          if (!current()) return;
          setUsageDisabled(failure instanceof UsageStoreDisabledError);
          if (!(failure instanceof UsageStoreDisabledError)) {
            setUsageError(describeError(failure, t('quota_forecast.usage_failed')));
          }
        }
      })();

      const historyTask = (async () => {
        // A quota check records genuine observations. Read history after that check completes.
        await loadQuota(forecastEntries);
        if (!current()) return;
        try {
          const next = await quotaHistoryApi.getHistory({
            from: new Date(Date.now() - FORECAST_RECENT_MS).toISOString(),
            to: new Date(Date.now()).toISOString(),
            limit: 10000,
          });
          if (!current()) return;
          setHistory(next);
          setHistoryState('ready');
          setNowMs(Date.now());
        } catch (failure: unknown) {
          if (!current()) return;
          setHistoryState(failure instanceof UsageStoreDisabledError ? 'disabled' : 'error');
          if (!(failure instanceof UsageStoreDisabledError)) {
            setHistoryError(describeError(failure, t('quota_forecast.history_failed')));
          }
        }
      })();
      await Promise.all([usageTask, historyTask, prefixTask]);
    } catch (failure: unknown) {
      if (!current()) return;
      setError(describeError(failure, t('quota_forecast.load_failed')));
      setEntries([]);
      setHistoryState('error');
    } finally {
      if (current()) setLoading(false);
    }
  }, [connectionStatus, loadQuota, t]);

  useHeaderRefresh(loadData);
  useEffect(() => {
    if (connectionStatus === 'connected') void loadData();
    else {
      setEntries([]);
      setHistory(null);
      setCurrentWeek(null);
      setRecent(null);
      setHistoryState('loading');
      setLoading(false);
    }
    return () => {
      requestRef.current += 1;
    };
  }, [loadData, connectionStatus, apiBase]);

  useEffect(() => {
    // Re-evaluate freshness without making provider requests.
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    const updateClock = () => {
      if (!document.hidden) setNowMs(Date.now());
    };
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', updateClock);
    };
  }, []);

  const metrics = useMemo(
    () =>
      buildForecastUsageMetrics(
        entries.map((entry) => entry.file.name),
        currentWeek,
        recent
      ),
    [entries, currentWeek, recent]
  );

  const { rows, pools } = useMemo(() => {
    const own = entries.map((entry) => {
      const cacheKey = getQuotaCacheKey(entry.file);
      const quota = entry.type === 'claude' ? claudeQuota[cacheKey] : codexQuota[cacheKey];
      return {
        entry,
        quota,
        forecast: buildQuotaForecast(entry.type, quota, nowMs, {
          authId: entry.file.name,
          authIndex: entry.file.authIndex,
          history,
          state: historyState,
          diagnostics: storeDiagnostics,
        }),
        usage: metrics.get(entry.file.name),
      };
    });
    const simulation = simulatePools(
      own
        .filter(({ entry }) => !entry.file.disabled)
        .map(({ entry, forecast }) => {
          const prefix = prefixes.get(entry.file.name) ?? '';
          return {
            id: entry.file.name,
            pool: prefix ? `${entry.type}/${prefix}` : entry.type,
            priority: typeof entry.file.priority === 'number' ? entry.file.priority : 0,
            forecast,
          };
        }),
      nowMs
    );
    return {
      rows: own.map((row) => ({
        ...row,
        forecast: simulation.forecasts.get(row.entry.file.name) ?? row.forecast,
      })),
      pools: simulation.pools,
    };
  }, [
    entries,
    prefixes,
    claudeQuota,
    codexQuota,
    metrics,
    nowMs,
    history,
    historyState,
    storeDiagnostics,
  ]);

  const labelFor = useCallback(
    (authId: string): string => {
      const entry = entries.find((item) => item.file.name === authId);
      return displayCredentialLabel(authId, entry?.file.note, showEmails);
    },
    [entries, showEmails]
  );

  const sortedRows = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .sort(
          (left, right) =>
            STATUS_ORDER[displayStatus(left.row.forecast)] -
              STATUS_ORDER[displayStatus(right.row.forecast)] ||
            (left.row.forecast.exhaustAtMs ?? Infinity) -
              (right.row.forecast.exhaustAtMs ?? Infinity) ||
            left.index - right.index
        )
        .map(({ row }) => row),
    [rows]
  );

  const totals = useMemo(() => {
    const byOutcome: Record<DisplayStatus, number> = {
      exhausted: 0,
      'before-reset': 0,
      tight: 0,
      'on-track': 0,
      unknown: 0,
    };
    rows.forEach((row) => {
      byOutcome[displayStatus(row.forecast)] += 1;
    });
    return {
      currentWeekTokens: rows.reduce((sum, row) => sum + (row.usage?.currentWeekTokens ?? 0), 0),
      // Accounts without a recent request have no pace; they add nothing rather than blanking the total.
      dailyTokens: rows.some((row) => row.usage?.dailyTokens != null)
        ? rows.reduce((sum, row) => sum + (row.usage?.dailyTokens ?? 0), 0)
        : null,
      byOutcome,
      unknown: byOutcome.unknown,
    };
  }, [rows]);

  const locale = i18n.resolvedLanguage;

  const formatInstant = (value: number | null): string =>
    value === null
      ? '--'
      : `${new Date(value).toLocaleString(locale, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })} ${resolveTimeZoneLabel(new Date(value))}`;

  const formatNumber = (value: number): string =>
    value.toLocaleString(locale, { maximumFractionDigits: 1 });

  const statusLabel = (status: DisplayStatus): string =>
    t(`quota_forecast.status_${status.replace(/-/g, '_')}`);

  const formatPercentChance = (value: number): string =>
    value.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 });

  const headlineText = (forecast: QuotaForecast): string => {
    switch (forecast.outcome) {
      case 'exhausted':
        return forecast.resetAtMs === null
          ? statusLabel('exhausted')
          : t('quota_forecast.headline_exhausted', {
              relative: formatRelativeInstant(forecast.resetAtMs, nowMs, locale),
            });
      case 'before-reset': {
        const values = {
          relative: formatRelativeInstant(forecast.exhaustAtMs ?? nowMs, nowMs, locale),
          gap: formatSpan((forecast.resetAtMs ?? 0) - (forecast.exhaustAtMs ?? 0), locale),
          account: forecast.handoffAfter ? labelFor(forecast.handoffAfter) : '',
        };
        return forecast.driver === 'pool-handoff' && forecast.handoffAfter
          ? t('quota_forecast.headline_handoff', values)
          : t('quota_forecast.headline_before_reset', values);
      }
      case 'lasts-to-reset':
        return t(
          forecast.driver === 'idle'
            ? 'quota_forecast.headline_idle'
            : 'quota_forecast.headline_lasts',
          { relative: formatRelativeInstant(forecast.resetAtMs ?? nowMs, nowMs, locale) }
        );
      default:
        return t(`quota_forecast.reason_${forecast.reason.replace(/-/g, '_')}`);
    }
  };

  const confidenceText = (forecast: QuotaForecast): string =>
    forecast.confidence === 'reported'
      ? t('quota_forecast.reported')
      : forecast.confidence === 'estimated'
        ? t(
            forecast.quality === 'moderate'
              ? 'quota_forecast.moderate_confidence'
              : 'quota_forecast.low_confidence'
          )
        : t('quota_forecast.unknown');

  const poolLabel = (poolId: string): string => {
    const [provider, prefix] = poolId.split('/');
    const name = provider === 'claude' ? 'Claude' : 'Codex';
    return prefix
      ? t('quota_forecast.pool_prefixed', { name, prefix })
      : t('quota_forecast.pool_name', { name });
  };

  const poolText = (pool: PoolOutlook): string => {
    if (pool.pacePercentPerDay <= 0) return t('quota_forecast.pool_idle');
    if (pool.dryFromMs === null) return t('quota_forecast.pool_covered');
    return t('quota_forecast.pool_dry', {
      from: formatInstant(pool.dryFromMs),
      relative: formatRelativeInstant(pool.dryFromMs, nowMs, locale),
      until: formatInstant(pool.dryUntilMs),
    });
  };

  type ForecastRow = (typeof rows)[number];
  type PlanChip = { text: string; tier: QuotaPlanBadge['tier'] };

  const providerName = (provider: ForecastProvider): string =>
    provider === 'claude' ? 'Claude' : 'Codex';

  const providerChip = (provider: ForecastProvider) => {
    const colors = TYPE_COLORS[provider]?.[resolvedTheme === 'dark' ? 'dark' : 'light'];
    return (
      <span
        className={styles.providerChip}
        style={colors ? { color: colors.text, background: colors.bg } : undefined}
      >
        {providerName(provider)}
      </span>
    );
  };

  const planFor = (provider: ForecastProvider, quota: ForecastRow['quota']): PlanChip | null => {
    const planType = (quota as { planType?: string | null } | undefined)?.planType ?? null;
    const badge = provider === 'claude' ? claudePlanBadge(planType) : codexPlanBadge(planType);
    if (!badge) return null;
    return { text: badge.labelKey ? t(badge.labelKey) : (badge.text ?? ''), tier: badge.tier };
  };

  const poolIdFor = (row: ForecastRow): string => {
    const prefix = prefixes.get(row.entry.file.name) ?? '';
    return prefix ? `${row.entry.type}/${prefix}` : row.entry.type;
  };

  interface RowGroup {
    key: string;
    label: string;
    provider: ForecastProvider | null;
    plan: PlanChip | null;
    note: string;
    order: (string | number)[];
    rows: ForecastRow[];
  }

  const groups: RowGroup[] = (() => {
    if (groupBy === 'none') {
      return [
        {
          key: 'all',
          label: '',
          provider: null,
          plan: null,
          note: '',
          order: [],
          rows: sortedRows,
        },
      ];
    }
    const byKey = new Map<string, RowGroup>();
    sortedRows.forEach((row) => {
      const provider = row.entry.type;
      const providerOrder = provider === 'claude' ? 0 : 1;
      let key: string = provider;
      let label = '';
      let plan: PlanChip | null = null;
      let note = '';
      let order: (string | number)[] = [providerOrder];
      if (groupBy === 'tier') {
        plan = planFor(provider, row.quota);
        key = `${provider}|${plan?.text ?? ''}`;
        label = plan ? '' : t('quota_forecast.plan_unknown');
        order = [providerOrder, plan ? TIER_RANK[plan.tier] : 3, plan?.text ?? ''];
      } else if (groupBy === 'pool') {
        key = poolIdFor(row);
        const pool = pools.find((item) => item.pool === key);
        label = poolLabel(key);
        note = pool ? poolText(pool) : '';
        order = [providerOrder, key.includes('/') ? 1 : 0, key];
      }
      const group = byKey.get(key) ?? {
        key,
        label,
        provider: groupBy === 'pool' ? null : provider,
        plan,
        note,
        order,
        rows: [],
      };
      group.rows.push(row);
      byKey.set(key, group);
    });
    return [...byKey.values()].sort((left, right) => {
      for (let index = 0; index < Math.max(left.order.length, right.order.length); index += 1) {
        const a = left.order[index] ?? '';
        const b = right.order[index] ?? '';
        if (a !== b) return a < b ? -1 : 1;
      }
      return 0;
    });
  })();

  const renderRow = ({ entry, quota, forecast, usage }: ForecastRow) => {
    const status = displayStatus(forecast);
    const cycleStartMs = forecast.resetAtMs === null ? null : forecast.resetAtMs - WEEK_MS;
    const elapsedPercent = cycleStartMs === null ? null : cyclePercent(nowMs, cycleStartMs);
    const dryFromPercent =
      cycleStartMs === null
        ? null
        : forecast.outcome === 'exhausted'
          ? elapsedPercent
          : forecast.outcome === 'before-reset' && forecast.exhaustAtMs !== null
            ? cyclePercent(forecast.exhaustAtMs, cycleStartMs)
            : null;
    const usedPercent = forecast.usedPercent;
    const plan = planFor(entry.type, quota);
    return (
      <li key={entry.file.name} className={styles.row} data-status={status}>
        <div className={styles.identity}>
          <span className={styles.accountName}>
            {displayCredentialLabel(entry.file.name, entry.file.note, showEmails)}
          </span>
          <span className={styles.badges}>
            {providerChip(entry.type)}
            {plan && <span className={planBadgeClass(plan.tier)}>{plan.text}</span>}
            {quota?.status === 'error' && (
              <span className={styles.accountKind}>{t('quota_forecast.quota_error')}</span>
            )}
          </span>
          <span className={styles.statusPill} data-status={status}>
            {statusLabel(status)}
          </span>
        </div>

        <div className={styles.remaining}>
          <strong>{formatPercent(forecast.remainingPercent)}</strong>
          <span>{t('quota_forecast.left')}</span>
        </div>

        <div className={styles.forecastCell}>
          <p className={styles.headline}>{headlineText(forecast)}</p>
          <div
            className={styles.tracks}
            role="img"
            aria-label={t('quota_forecast.bar_aria', {
              used: formatPercent(usedPercent),
              elapsed: formatPercent(elapsedPercent),
            })}
          >
            <span className={styles.trackLabel}>{t('quota_forecast.bar_used')}</span>
            <span className={styles.track}>
              {usedPercent !== null && (
                <span
                  className={styles.usedFill}
                  data-tone={quotaRemainingTone(forecast.remainingPercent)}
                  style={{ width: `${usedPercent}%` }}
                />
              )}
            </span>
            <span className={styles.trackValue}>{formatPercent(usedPercent)}</span>

            <span className={styles.trackLabel}>{t('quota_forecast.bar_elapsed')}</span>
            <span className={styles.track}>
              {elapsedPercent !== null && (
                <span className={styles.elapsedFill} style={{ width: `${elapsedPercent}%` }} />
              )}
              {cycleStartMs !== null &&
                forecast.outcome === 'before-reset' &&
                forecast.rangeStartMs !== null &&
                forecast.rangeEndMs !== null && (
                  <span
                    className={styles.rangeBand}
                    style={{
                      left: `${cyclePercent(forecast.rangeStartMs, cycleStartMs)}%`,
                      width: `${
                        cyclePercent(forecast.rangeEndMs, cycleStartMs) -
                        cyclePercent(forecast.rangeStartMs, cycleStartMs)
                      }%`,
                    }}
                  />
                )}
              {dryFromPercent !== null && (
                <span className={styles.dryZone} style={{ left: `${dryFromPercent}%`, right: 0 }} />
              )}
              {elapsedPercent !== null && (
                <span className={styles.nowMark} style={{ left: `${elapsedPercent}%` }} />
              )}
            </span>
            <span className={styles.trackValue}>{formatPercent(elapsedPercent)}</span>
          </div>
        </div>

        <div className={styles.reset}>
          <span>{t('quota_forecast.resets')}</span>
          <strong>
            {forecast.resetAtMs === null
              ? '--'
              : formatRelativeInstant(forecast.resetAtMs, nowMs, locale)}
          </strong>
          <small>{formatInstant(forecast.resetAtMs)}</small>
        </div>

        <dl className={styles.details}>
          <div>
            <dt>{t('quota_forecast.this_week')}</dt>
            <dd>
              {usage?.currentWeekTokens == null
                ? '--'
                : t('quota_forecast.value_tokens', {
                    value: formatUsageCount(usage.currentWeekTokens),
                  })}
            </dd>
          </div>
          <div>
            <dt>{t('quota_forecast.daily_pace')}</dt>
            <dd>
              {usage?.dailyTokens == null
                ? '--'
                : t('quota_forecast.value_token_pace', {
                    value: formatUsageCount(usage.dailyTokens),
                    days: formatNumber((usage.observedRecentMs ?? 0) / DAY_MS),
                  })}
            </dd>
          </div>
          {usage?.recentRequests != null && (
            <div>
              <dt>{t('quota_forecast.detail_requests')}</dt>
              <dd>
                {t('quota_forecast.value_requests', {
                  requests: formatUsageCount(usage.recentRequests),
                  failed: formatUsageCount(usage.recentFailed ?? 0),
                })}
              </dd>
            </div>
          )}
          {forecast.ratePercentPerDay !== null && (
            <div>
              <dt>{t('quota_forecast.detail_quota_pace')}</dt>
              <dd>
                {t('quota_forecast.value_quota_pace', {
                  percent: formatNumber(forecast.ratePercentPerDay),
                })}
              </dd>
            </div>
          )}
          {forecast.observedAtMs !== null && (
            <div>
              <dt>{t('quota_forecast.detail_readings')}</dt>
              <dd>
                {t('quota_forecast.value_readings', {
                  count: forecast.sampleCount,
                  hours: formatNumber(forecast.sampleSpanMs / 3_600_000),
                  minutes: Math.floor((forecast.ageMs ?? 0) / 60_000),
                })}
              </dd>
            </div>
          )}
          <div>
            <dt>{t('quota_forecast.detail_confidence')}</dt>
            <dd data-confidence={forecast.quality ?? forecast.confidence}>
              {confidenceText(forecast)}
            </dd>
          </div>
          {forecast.runoutChance !== null && (
            <div>
              <dt>{t('quota_forecast.detail_chance')}</dt>
              <dd>
                {t('quota_forecast.value_chance', {
                  percent: formatPercentChance(forecast.runoutChance),
                })}
              </dd>
            </div>
          )}
          {forecast.outcome === 'before-reset' &&
            forecast.rangeStartMs !== null &&
            forecast.rangeEndMs !== null && (
              <div>
                <dt>{t('quota_forecast.detail_window')}</dt>
                <dd>
                  {t('quota_forecast.value_window', {
                    start: formatInstant(forecast.rangeStartMs),
                    end:
                      forecast.rangeEndMs >= (forecast.resetAtMs ?? Infinity)
                        ? t('quota_forecast.window_reset')
                        : formatInstant(forecast.rangeEndMs),
                  })}
                </dd>
              </div>
            )}
          {forecast.resetDetected && (
            <div className={styles.detailNote}>
              <dd>{t('quota_forecast.reset_excluded')}</dd>
            </div>
          )}
          {forecast.includesImportedReadings && (
            <div className={styles.detailNote}>
              <dd>{t('quota_forecast.imported_readings')}</dd>
            </div>
          )}
        </dl>
      </li>
    );
  };

  const busy = loading || batchLoading;

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title} data-reveal>
            {t('quota_forecast.title')}
          </h1>
          <p className={styles.description} data-reveal>
            {t('quota_forecast.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadData()}
          disabled={busy || connectionStatus !== 'connected'}
        >
          <IconRefreshCw size={14} className={busy ? styles.spinning : undefined} />
          {t('common.refresh')}
        </Button>
      </header>

      {(error || usageError || historyError) && (
        <div className={styles.errorBanner} role="alert">
          {error || usageError || historyError}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton height={104} rounded={14} />
          <Skeleton height={280} rounded={14} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('quota_forecast.empty_title')}
          description={t('quota_forecast.empty_desc')}
        />
      ) : (
        <>
          <section className={styles.overview} aria-label={t('quota_forecast.summary_label')}>
            <div className={styles.statusSummary}>
              <h2 className={styles.overviewTitle}>
                {t('quota_forecast.accounts_count', { count: rows.length })}
              </h2>
              <div className={styles.statusBar} aria-hidden="true">
                {STATUS_KEYS.filter((status) => totals.byOutcome[status] > 0).map((status) => (
                  <span
                    key={status}
                    className={styles.statusSegment}
                    data-status={status}
                    style={{ flexGrow: totals.byOutcome[status] }}
                  />
                ))}
              </div>
              <ul className={styles.statusLegend}>
                {STATUS_KEYS.map((status) => (
                  <li key={status} data-status={status} data-empty={totals.byOutcome[status] === 0}>
                    <span className={styles.swatch} aria-hidden="true" />
                    <strong>{totals.byOutcome[status]}</strong>
                    <span>{statusLabel(status)}</span>
                  </li>
                ))}
              </ul>
              {pools.length > 0 && (
                <ul className={styles.poolList} aria-label={t('quota_forecast.pools_label')}>
                  {pools.map((pool) => (
                    <li key={pool.pool} data-dry={pool.dryFromMs !== null}>
                      <strong>{poolLabel(pool.pool)}</strong>
                      <span>{poolText(pool)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className={styles.stat}>
              <span>{t('quota_forecast.this_week')}</span>
              <strong title={currentWeek ? formatUsageExact(totals.currentWeekTokens) : undefined}>
                {currentWeek ? formatUsageCount(totals.currentWeekTokens) : '--'}
              </strong>
              <small>{t('quota_forecast.tokens')}</small>
            </div>
            <div className={styles.stat}>
              <span>{t('quota_forecast.daily_pace')}</span>
              <strong>
                {totals.dailyTokens === null ? '--' : formatUsageCount(totals.dailyTokens)}
              </strong>
              <small>{t('quota_forecast.tokens_per_day')}</small>
            </div>
          </section>

          <div className={styles.listHead}>
            <div
              className={styles.groupSwitch}
              role="group"
              aria-label={t('quota_forecast.group_label')}
            >
              <span>{t('quota_forecast.group_label')}</span>
              <div className={styles.segmented}>
                {GROUP_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={groupBy === option}
                    onClick={() => setGroupBy(option)}
                  >
                    {t(`quota_forecast.group_${option}`)}
                  </button>
                ))}
              </div>
            </div>
            <ul className={styles.trackLegend}>
              <li>
                <span className={styles.legendUsed} aria-hidden="true" />
                {t('quota_forecast.bar_used')}
              </li>
              <li>
                <span className={styles.legendElapsed} aria-hidden="true" />
                {t('quota_forecast.legend_elapsed')}
              </li>
              <li>
                <span className={styles.legendNow} aria-hidden="true" />
                {t('quota_forecast.legend_now')}
              </li>
              <li>
                <span className={styles.legendRange} aria-hidden="true" />
                {t('quota_forecast.legend_window')}
              </li>
              <li>
                <span className={styles.legendDry} aria-hidden="true" />
                {t('quota_forecast.legend_dry')}
              </li>
            </ul>
          </div>

          <div className={styles.groups}>
            {groups.map((group) => (
              <section key={group.key} className={styles.group}>
                {groupBy !== 'none' && (
                  <div className={styles.groupHead}>
                    <div className={styles.groupTitle}>
                      {group.provider && providerChip(group.provider)}
                      {group.plan ? (
                        <span className={planBadgeClass(group.plan.tier)}>{group.plan.text}</span>
                      ) : (
                        group.label && <h3>{group.label}</h3>
                      )}
                      <span className={styles.groupCount}>
                        {t('quota_forecast.accounts_count', { count: group.rows.length })}
                      </span>
                    </div>
                    <div className={styles.groupStatus}>
                      <div className={styles.miniBar} aria-hidden="true">
                        {STATUS_KEYS.map((status) => {
                          const count = group.rows.filter(
                            (row) => displayStatus(row.forecast) === status
                          ).length;
                          return count > 0 ? (
                            <span
                              key={status}
                              className={styles.statusSegment}
                              data-status={status}
                              style={{ flexGrow: count }}
                            />
                          ) : null;
                        })}
                      </div>
                      {group.note && <span className={styles.groupNote}>{group.note}</span>}
                    </div>
                  </div>
                )}
                <ul className={styles.list}>{group.rows.map(renderRow)}</ul>
              </section>
            ))}
          </div>

          {totals.unknown > 0 && (
            <p className={styles.unknownNote}>
              {t('quota_forecast.unknown_accounts', { count: totals.unknown })}
            </p>
          )}

          <details className={styles.method}>
            <summary>{t('quota_forecast.how_it_works')}</summary>
            <p>{t('quota_forecast.method_note')}</p>
            <p>
              {usageDisabled
                ? t('quota_forecast.usage_disabled')
                : recent
                  ? t('quota_forecast.history_available')
                  : t('quota_forecast.history_unknown')}{' '}
              {t('quota_forecast.local_week_note')}
            </p>
          </details>
        </>
      )}
    </div>
  );
}
