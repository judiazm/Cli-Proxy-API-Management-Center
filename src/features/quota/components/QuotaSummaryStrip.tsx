/**
 * One card per provider family, above the table.
 *
 * A list of credentials answers "how is this account doing". The question
 * actually being asked at the top of the page is "how is Claude doing" — and
 * five accounts at 58/100/100/51/100 is one answer, 409% of a possible 500%,
 * not five. The sparkbar row underneath is the same five numbers in the order
 * the table lists them, so a short bar in the strip is findable below.
 *
 * The reset shown is the soonest one still ahead on the binding window: the
 * first moment any of this family's capacity comes back.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import type { QuotaColumn, QuotaFamilyAggregate, QuotaFamilySummary } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindClassMap } from '../types';
import { QUOTA_BAR_CLASS_KEYS, QuotaBar } from './QuotaBar';
import { QUOTA_COUNTDOWN_CLASS_KEYS, QuotaCountdown } from './QuotaCountdown';
import styles from './QuotaSummaryStrip.module.scss';

const SOURCE = 'QuotaSummaryStrip.module.scss';
const barClasses = bindClassMap(QUOTA_BAR_CLASS_KEYS, styles, SOURCE);
const countdownClasses = bindClassMap(QUOTA_COUNTDOWN_CLASS_KEYS, styles, SOURCE);

export interface QuotaSummaryStripProps {
  summaries: QuotaFamilySummary[];
  resolvedTheme: ResolvedTheme;
  nowMs: number;
}

const NO_READING = '--';

export function QuotaSummaryStrip({ summaries, resolvedTheme, nowMs }: QuotaSummaryStripProps) {
  const { t, i18n } = useTranslation();

  if (summaries.length === 0) return null;

  const columnLabel = (column: QuotaColumn): string =>
    column.labelKey
      ? t(column.labelKey, column.labelParams as Record<string, string | number>)
      : (column.label ?? '');

  const aggregateTotal = (aggregate: QuotaFamilyAggregate): string =>
    aggregate.totalRemainingPercent === null ? NO_READING : `${aggregate.totalRemainingPercent}%`;

  return (
    <div className={styles.strip} data-reveal>
      {summaries.map((summary) => {
        const typeLabel = getTypeLabel(t, summary.family);
        const iconSrc = getAuthFileIcon(summary.family, resolvedTheme);

        return (
          <article key={summary.family} className={styles.card}>
            <header className={styles.head}>
              <span
                className={styles.iconWrap}
                style={
                  isThemeSurfaceIconProvider(summary.family)
                    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                    : undefined
                }
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className={styles.icon} />
                ) : (
                  <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <span className={styles.family}>{typeLabel}</span>
              <span className={styles.count}>
                {t('quota_management.meta_credentials', { count: summary.credentialCount })}
              </span>
            </header>

            {summary.binding ? (
              <>
                <span className={styles.windowLabel}>{columnLabel(summary.binding.column)}</span>
                <p className={styles.figure}>
                  <strong className={styles.figureValue}>{aggregateTotal(summary.binding)}</strong>
                  <span className={styles.figureOf}>
                    {t('quota_management.summary_of_total', {
                      total: summary.binding.maxRemainingPercent,
                    })}
                  </span>
                </p>
                <div
                  className={styles.bars}
                  role="img"
                  aria-label={t('quota_management.summary_bars_label', {
                    count: summary.credentialCount,
                  })}
                >
                  {summary.bars.map((percent, index) => (
                    <QuotaBar
                      // Index is the identity here: a sparkbar is a position in
                      // the list below, and the list has no id to borrow.
                      key={index}
                      percent={percent}
                      classes={barClasses}
                      index={index}
                    />
                  ))}
                </div>
                <div className={styles.reset}>
                  <QuotaCountdown
                    atMs={summary.soonestResetAtMs}
                    nowMs={nowMs}
                    locale={i18n.resolvedLanguage}
                    classes={countdownClasses}
                    emptyLabel={t('quota_management.no_reset_pending')}
                  />
                </div>
                {summary.secondary && (
                  <div className={styles.secondary}>
                    <span className={styles.secondaryLabel}>
                      {columnLabel(summary.secondary.column)}
                    </span>
                    <span className={styles.secondaryValue}>
                      {aggregateTotal(summary.secondary)}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className={styles.idle}>{t('quota_management.summary_idle')}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
