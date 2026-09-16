import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import {
  UsageStoreDisabledError,
  authFilesApi,
  usageStoreApi,
  type UsageSummaryResponse,
} from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import { displayCredentialLabel } from '@/utils/quota';
import { browserTimeZone, parseInstantMs } from '@/features/usage/logic/timeRange';
import { formatUsageCount, formatUsageExact } from '@/features/usage/logic/formatUsage';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { readQuotaShowEmails } from '@/features/quota/uiState';
import {
  WEEK_MS,
  buildCodexQuotaForecast,
  buildForecastUsageMetrics,
  firstUsageInstantMs,
  startOfLocalWeek,
  type CodexQuotaForecast,
} from './forecast';
import styles from './QuotaForecastPage.module.scss';

const DAY_MS = 24 * 60 * 60_000;

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${Math.round(value)}%`;

export function QuotaForecastPage() {
  const { t, i18n } = useTranslation();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const { batchLoading, loadQuota } = useQuotaBatchLoader();

  const [entries, setEntries] = useState<QuotaFileEntry[]>([]);
  const [currentWeek, setCurrentWeek] = useState<UsageSummaryResponse | null>(null);
  const [recent, setRecent] = useState<UsageSummaryResponse | null>(null);
  const [observedRecentMs, setObservedRecentMs] = useState(0);
  const [usageDisabled, setUsageDisabled] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const showEmails = readQuotaShowEmails();

  const loadData = useCallback(async () => {
    const now = Date.now();
    const recentFrom = now - WEEK_MS;
    const timeZone = browserTimeZone();
    setNowMs(now);
    setLoading(true);
    setError('');
    setUsageError('');

    try {
      const files = await authFilesApi.list();
      const codexEntries = classifyQuotaFiles(files?.files ?? []).filter(
        (entry) => entry.type === 'codex'
      );
      setEntries(codexEntries);

      const usageTask = (async () => {
        try {
          const meta = await usageStoreApi.getMeta();
          if (!meta.enabled) {
            setUsageDisabled(true);
            setCurrentWeek(null);
            setRecent(null);
            setObservedRecentMs(0);
            return;
          }

          const [weekSummary, recentSummary] = await Promise.all([
            usageStoreApi.getSummary({
              from: startOfLocalWeek(now),
              to: now,
              tz: timeZone,
              groupBy: ['auth_id'],
              filters: { provider: ['codex'] },
              limit: 500,
            }),
            usageStoreApi.getSummary({
              from: recentFrom,
              to: now,
              tz: timeZone,
              groupBy: ['auth_id'],
              filters: { provider: ['codex'] },
              limit: 500,
            }),
          ]);
          const oldestMs = firstUsageInstantMs(recentSummary) ?? parseInstantMs(meta.oldest);
          setCurrentWeek(weekSummary);
          setRecent(recentSummary);
          setObservedRecentMs(
            oldestMs === null ? 0 : Math.max(0, now - Math.max(recentFrom, oldestMs))
          );
          setUsageDisabled(false);
        } catch (usageFailure: unknown) {
          if (usageFailure instanceof UsageStoreDisabledError) {
            setUsageDisabled(true);
            setCurrentWeek(null);
            setRecent(null);
            setObservedRecentMs(0);
            return;
          }
          setUsageDisabled(false);
          setUsageError(describeError(usageFailure, t('quota_forecast.usage_failed')));
          setCurrentWeek(null);
          setRecent(null);
          setObservedRecentMs(0);
        }
      })();

      await Promise.all([usageTask, loadQuota(codexEntries)]);
    } catch (failure: unknown) {
      setError(describeError(failure, t('quota_forecast.load_failed')));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [loadQuota, t]);

  useHeaderRefresh(loadData);
  useEffect(() => {
    void loadData();
  }, [loadData]);

  const metrics = useMemo(
    () =>
      buildForecastUsageMetrics(
        entries.map((entry) => entry.file.name),
        currentWeek,
        recent,
        observedRecentMs
      ),
    [entries, currentWeek, recent, observedRecentMs]
  );

  const rows = useMemo(
    () =>
      entries.map((entry) => ({
        entry,
        quota: codexQuota[entry.file.name],
        forecast: buildCodexQuotaForecast(codexQuota[entry.file.name], nowMs),
        usage: metrics.get(entry.file.name),
      })),
    [entries, codexQuota, metrics, nowMs]
  );

  const totals = useMemo(
    () => ({
      currentWeekTokens: rows.reduce((sum, row) => sum + (row.usage?.currentWeekTokens ?? 0), 0),
      dailyTokens: rows.reduce((sum, row) => sum + (row.usage?.dailyTokens ?? 0), 0),
      atRisk: rows.filter((row) => row.forecast.outcome === 'before-reset').length,
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

  const forecastText = (forecast: CodexQuotaForecast): string => {
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
  const observedDays = observedRecentMs / DAY_MS;

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
        <span className={styles.lowBadge}>{t('quota_forecast.low_confidence')}</span>
        <span>{t('quota_forecast.method_note')}</span>
      </div>

      {(error || usageError) && (
        <div className={styles.errorBanner} role="alert">
          {error || usageError}
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
              <strong title={formatUsageExact(totals.currentWeekTokens)}>
                {formatUsageCount(totals.currentWeekTokens)}
              </strong>
              <small>{t('quota_forecast.tokens')}</small>
            </article>
            <article className={styles.stat}>
              <span>{t('quota_forecast.daily_pace')}</span>
              <strong>{observedRecentMs > 0 ? formatUsageCount(totals.dailyTokens) : '--'}</strong>
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
              : observedRecentMs > 0
                ? t('quota_forecast.history_available', {
                    days: observedDays.toLocaleString(i18n.resolvedLanguage, {
                      maximumFractionDigits: 1,
                    }),
                  })
                : t('quota_forecast.history_unknown')}
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
                        {usage ? formatUsageCount(usage.currentWeekTokens) : '--'}
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
                      </span>
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
                            ? t('quota_forecast.low_confidence')
                            : t('quota_forecast.unknown')}
                      </span>
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
