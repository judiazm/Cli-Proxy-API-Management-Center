/**
 * The five numbers worth seeing before choosing a view.
 *
 * Each carries a change against the equal-length window immediately before this
 * one, because a token count on its own is not information: 4.2M means nothing
 * until you know last week was 1.1M. The arrow's colour follows meaning rather
 * than direction, so more failures and slower responses read as red however the
 * number moved.
 */

import { useTranslation } from 'react-i18next';
import type { UsageMetrics } from '@/services/api';
import {
  formatUsageCount,
  formatUsageDelta,
  formatUsageDuration,
  formatUsageExact,
  formatUsageRatio,
} from '../logic/formatUsage';
import { cacheHitRatio, relativeDelta } from '../logic/metrics';
import styles from '../UsagePage.module.scss';

export interface UsageSummaryStripProps {
  totals: UsageMetrics;
  previous: UsageMetrics | null;
}

interface StatProps {
  label: string;
  value: string;
  exact?: string;
  delta: number | null;
  /** True where a rise is bad news: failures, latency. */
  inverted?: boolean;
}

function Stat({ label, value, exact, delta, inverted }: StatProps) {
  const { t } = useTranslation();
  const rendered = formatUsageDelta(delta);
  const tone =
    delta === null || delta === 0
      ? styles.deltaFlat
      : delta > 0
        ? styles.deltaUp
        : styles.deltaDown;

  return (
    <div className={styles.stat}>
      <span className={styles.statLabel} title={label}>
        {label}
      </span>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statFoot}>
        {rendered ? (
          <span className={`${tone} ${inverted ? styles.deltaInverted : ''}`}>{rendered}</span>
        ) : (
          <span className={styles.deltaFlat}>{t('usage.delta_none')}</span>
        )}
        {exact ? <span className={styles.statExact}>{exact}</span> : null}
      </span>
    </div>
  );
}

export function UsageSummaryStrip({ totals, previous }: UsageSummaryStripProps) {
  const { t } = useTranslation();

  const currentCache = cacheHitRatio(totals);
  const previousCache = previous ? cacheHitRatio(previous) : null;

  return (
    <div className={styles.strip} data-reveal>
      <Stat
        label={t('usage.metric_requests')}
        value={formatUsageCount(totals.requests)}
        exact={formatUsageExact(totals.requests)}
        delta={previous ? relativeDelta(totals.requests, previous.requests) : null}
      />
      <Stat
        label={t('usage.metric_failures')}
        value={formatUsageCount(totals.failed)}
        exact={formatUsageRatio(totals.requests > 0 ? totals.failed / totals.requests : null)}
        delta={previous ? relativeDelta(totals.failed, previous.failed) : null}
        inverted
      />
      <Stat
        label={t('usage.metric_total_tokens')}
        value={formatUsageCount(totals.total_tokens)}
        exact={formatUsageExact(totals.total_tokens)}
        delta={previous ? relativeDelta(totals.total_tokens, previous.total_tokens) : null}
      />
      <Stat
        label={t('usage.column_cache_ratio')}
        value={formatUsageRatio(currentCache)}
        exact={formatUsageCount(totals.cache_read_tokens)}
        delta={
          currentCache !== null && previousCache !== null
            ? relativeDelta(currentCache, previousCache)
            : null
        }
      />
      <Stat
        label={t('usage.metric_latency')}
        value={formatUsageDuration(totals.latency_ms_avg)}
        exact={
          totals.ttft_ms_avg > 0
            ? t('usage.ttft_inline', { value: formatUsageDuration(totals.ttft_ms_avg) })
            : undefined
        }
        delta={previous ? relativeDelta(totals.latency_ms_avg, previous.latency_ms_avg) : null}
        inverted
      />
    </div>
  );
}
