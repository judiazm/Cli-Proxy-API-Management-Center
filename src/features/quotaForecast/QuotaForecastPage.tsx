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
import { useAuthStore, useQuotaStore } from '@/stores';
import { displayCredentialLabel } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { browserTimeZone } from '@/features/usage/logic/timeRange';
import { formatUsageCount, formatUsageExact } from '@/features/usage/logic/formatUsage';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { readQuotaShowEmails } from '@/features/quota/uiState';
import {
  WEEK_MS,
  FORECAST_RECENT_MS,
  buildQuotaForecast,
  buildForecastUsageMetrics,
  isQuotaAtRisk,
  startOfLocalWeek,
  type ForecastProvider,
  type ForecastHistoryState,
  type QuotaForecast,
} from './forecast';
import styles from './QuotaForecastPage.module.scss';

const DAY_MS = 24 * 60 * 60_000;

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${Math.round(value)}%`;

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
      await Promise.all([usageTask, historyTask]);
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

  const rows = useMemo(
    () =>
      entries.map((entry) => {
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
      }),
    [entries, claudeQuota, codexQuota, metrics, nowMs, history, historyState, storeDiagnostics]
  );

  const totals = useMemo(
    () => ({
      currentWeekTokens: rows.reduce((sum, row) => sum + (row.usage?.currentWeekTokens ?? 0), 0),
      dailyTokens:
        rows.length > 0 && rows.every((row) => row.usage?.dailyTokens != null)
          ? rows.reduce((sum, row) => sum + (row.usage?.dailyTokens ?? 0), 0)
          : null,
      atRisk: rows.filter((row) => isQuotaAtRisk(row.forecast)).length,
      unknown: rows.filter((row) => row.forecast.outcome === 'unknown').length,
    }),
    [rows]
  );

  const formatInstant = (value: number | null): string =>
    value === null
      ? '--'
      : new Date(value).toLocaleString(i18n.resolvedLanguage, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });

  const forecastText = (forecast: QuotaForecast): string => {
    switch (forecast.outcome) {
      case 'exhausted':
        return t('quota_forecast.outcome_exhausted');
      case 'before-reset':
        return t('quota_forecast.outcome_before_reset', {
          date: formatInstant(forecast.exhaustAtMs),
        });
      case 'lasts-to-reset':
        return t('quota_forecast.outcome_lasts');
      default:
        return t(`quota_forecast.reason_${forecast.reason.replace(/-/g, '_')}`);
    }
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

      <div className={styles.confidenceNote} role="note" data-reveal>
        <span className={styles.lowBadge}>{t('quota_forecast.estimated')}</span>
        <span>{t('quota_forecast.method_note')}</span>
      </div>

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
          <section className={styles.summary} aria-label={t('quota_forecast.summary_label')}>
            <article className={styles.stat}>
              <span>{t('quota_forecast.this_week')}</span>
              <strong title={currentWeek ? formatUsageExact(totals.currentWeekTokens) : undefined}>
                {currentWeek ? formatUsageCount(totals.currentWeekTokens) : '--'}
              </strong>
              <small>{t('quota_forecast.tokens')}</small>
            </article>
            <article className={styles.stat}>
              <span>{t('quota_forecast.daily_pace')}</span>
              <strong>
                {totals.dailyTokens === null ? '--' : formatUsageCount(totals.dailyTokens)}
              </strong>
              <small>{t('quota_forecast.tokens_per_day')}</small>
            </article>
            <article className={styles.stat}>
              <span>{t('quota_forecast.at_risk')}</span>
              <strong>{totals.atRisk}</strong>
              <small>{t('quota_forecast.before_reset')}</small>
            </article>
            <article className={styles.stat}>
              <span>{t('quota_forecast.pool_eta')}</span>
              <strong>--</strong>
              <small>{t('quota_forecast.pool_eta_unknown')}</small>
            </article>
          </section>

          <div className={styles.historyNote}>
            {usageDisabled
              ? t('quota_forecast.usage_disabled')
              : recent
                ? t('quota_forecast.history_available')
                : t('quota_forecast.history_unknown')}{' '}
            {t('quota_forecast.local_week_note')}
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('quota_forecast.account')}</th>
                  <th>{t('quota_forecast.provider_quota')}</th>
                  <th>{t('quota_forecast.this_week')}</th>
                  <th>{t('quota_forecast.daily_pace')}</th>
                  <th>{t('quota_forecast.forecast')}</th>
                  <th>{t('quota_forecast.reset')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ entry, quota, forecast, usage }) => (
                  <tr key={entry.file.name}>
                    <td>
                      <span className={styles.accountName}>
                        {displayCredentialLabel(entry.file.name, entry.file.note, showEmails)}
                      </span>
                      <span className={styles.accountState}>
                        {quota?.status === 'error'
                          ? t('quota_forecast.quota_error')
                          : entry.type === 'claude'
                            ? t('quota_forecast.claude_weekly')
                            : t('quota_forecast.codex_weekly')}
                      </span>
                    </td>
                    <td>
                      <strong className={styles.metricValue}>
                        {formatPercent(forecast.remainingPercent)}
                      </strong>
                      <span className={styles.reportedBadge}>
                        {forecast.remainingPercent === null
                          ? t('quota_forecast.unknown')
                          : t('quota_forecast.reported')}
                      </span>
                    </td>
                    <td>
                      <span className={styles.metricValue}>
                        {usage?.currentWeekTokens == null
                          ? '--'
                          : formatUsageCount(usage.currentWeekTokens)}
                      </span>
                      <span className={styles.metricUnit}>{t('quota_forecast.tokens')}</span>
                    </td>
                    <td>
                      <span className={styles.metricValue}>
                        {usage?.dailyTokens === null || usage?.dailyTokens === undefined
                          ? '--'
                          : formatUsageCount(usage.dailyTokens)}
                      </span>
                      <span className={styles.metricUnit}>
                        {t('quota_forecast.tokens_per_day')}
                        {usage?.observedRecentMs != null && usage.observedRecentMs >= 30 * 60_000
                          ? ` · ${t('quota_forecast.usage_span', {
                              days: (usage.observedRecentMs / DAY_MS).toLocaleString(
                                i18n.resolvedLanguage,
                                { maximumFractionDigits: 1 }
                              ),
                            })}`
                          : ''}
                      </span>
                      {usage?.recentRequests != null && (
                        <span className={styles.metricUnit}>
                          {t('quota_forecast.request_context', {
                            requests: formatUsageCount(usage.recentRequests),
                            failed: formatUsageCount(usage.recentFailed ?? 0),
                          })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={styles.forecastText}>{forecastText(forecast)}</span>
                      <span
                        className={
                          forecast.confidence === 'unknown'
                            ? styles.unknownBadge
                            : forecast.confidence === 'reported'
                              ? styles.reportedBadge
                              : styles.lowBadge
                        }
                      >
                        {forecast.confidence === 'reported'
                          ? t('quota_forecast.reported')
                          : forecast.confidence === 'estimated'
                            ? t(
                                forecast.quality === 'moderate'
                                  ? 'quota_forecast.moderate_confidence'
                                  : 'quota_forecast.low_confidence'
                              )
                            : t('quota_forecast.unknown')}
                      </span>
                      {forecast.observedAtMs !== null && (
                        <span className={styles.metricUnit}>
                          {t('quota_forecast.observation_context', {
                            count: forecast.sampleCount,
                            hours: (forecast.sampleSpanMs / 3_600_000).toLocaleString(
                              i18n.resolvedLanguage,
                              { maximumFractionDigits: 1 }
                            ),
                            minutes: Math.floor((forecast.ageMs ?? 0) / 60_000),
                          })}
                        </span>
                      )}
                      {forecast.ratePercentPerDay !== null && (
                        <span className={styles.metricUnit}>
                          {t('quota_forecast.quota_pace', {
                            percent: forecast.ratePercentPerDay.toLocaleString(
                              i18n.resolvedLanguage,
                              { maximumFractionDigits: 1 }
                            ),
                          })}
                        </span>
                      )}
                      {forecast.resetDetected && (
                        <span className={styles.metricUnit}>
                          {t('quota_forecast.reset_excluded')}
                        </span>
                      )}
                      {forecast.includesImportedReadings && (
                        <span className={styles.metricUnit}>
                          {t('quota_forecast.imported_readings')}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={styles.metricValue}>
                        {formatInstant(forecast.resetAtMs)}
                      </span>
                      <span className={styles.reportedBadge}>
                        {forecast.resetAtMs === null
                          ? t('quota_forecast.unknown')
                          : t('quota_forecast.reported')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totals.unknown > 0 && (
            <p className={styles.unknownNote}>
              {t('quota_forecast.unknown_accounts', { count: totals.unknown })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
