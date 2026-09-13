/**
 * One derived pool, and the misconfiguration card that follows the set.
 *
 * The card answers three questions in the order they get asked: how much is
 * left in this pool, which credentials are in it, and who can reach it. The
 * allowlist patterns sit under the keys because they are the *reason* a key is
 * listed — without them a reader has to go to the config panel to find out why
 * a key appears beside a pool it was never explicitly given.
 *
 * Names are masked by default and keys are never shown in full: this page is
 * the kind that gets screen-shared.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { displayCredentialName } from '@/utils/quota';
import { describeClientKey, type DerivedPool, type UnreachableCredential } from '../logic';
import type { PoolQuotaAggregate } from '../quota';
import styles from './PoolCard.module.scss';

const NO_READING = '--';

export interface PoolCardProps {
  pool: DerivedPool;
  quota: PoolQuotaAggregate | null;
  showEmails: boolean;
  resolvedTheme: ResolvedTheme;
}

export function PoolCard({ pool, quota, showEmails, resolvedTheme }: PoolCardProps) {
  const { t } = useTranslation();

  const typeLabel = getTypeLabel(t, pool.family);
  const iconSrc = getAuthFileIcon(pool.family, resolvedTheme);
  const hasOpenClient = pool.clients.some((grant) => grant.client.unrestricted);

  return (
    <article
      className={styles.card}
      aria-label={pool.prefix ? `${typeLabel} · ${pool.prefix}/` : typeLabel}
    >
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(pool.family)
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
        {pool.prefix && <span className={styles.prefixBadge}>{`${pool.prefix}/`}</span>}
        <span className={styles.count}>
          {t('pools.meta_credentials', { count: pool.members.length })}
        </span>
      </header>

      <p className={styles.figure}>
        {quota ? (
          <>
            <strong className={styles.figureValue}>{`${quota.totalRemainingPercent}%`}</strong>
            <span className={styles.figureOf}>
              {t('quota_management.summary_of_total', { total: quota.maxRemainingPercent })}
            </span>
          </>
        ) : (
          <>
            <strong className={`${styles.figureValue} ${styles.figureIdle}`}>{NO_READING}</strong>
            <span className={styles.figureOf}>{t('pools.remaining_idle')}</span>
          </>
        )}
      </p>

      <div className={styles.section}>
        <span className={styles.sectionLabel}>{t('pools.members_label')}</span>
        <ul className={styles.list}>
          {pool.members.map((member) => (
            <li
              key={member.name}
              className={
                member.disabled ? `${styles.member} ${styles.memberDisabled}` : styles.member
              }
            >
              <span className={styles.memberName}>
                {displayCredentialName(member.name, showEmails)}
              </span>
              {member.disabled && (
                <span className={styles.badge}>{t('pools.reason_disabled')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionLabel}>
          {t('pools.clients_label', { count: pool.clients.length })}
        </span>
        {pool.clients.length === 0 ? (
          <p className={`${styles.empty} ${styles.emptyWarn}`}>{t('pools.clients_empty')}</p>
        ) : (
          <div className={styles.chips}>
            {pool.clients.map((grant) => (
              <span
                key={grant.client.key}
                className={
                  grant.client.unrestricted ? `${styles.chip} ${styles.chipOpen}` : styles.chip
                }
                title={
                  grant.client.unrestricted ? t('pools.patterns_all') : grant.patterns.join(', ')
                }
              >
                {describeClientKey(grant.client)}
              </span>
            ))}
          </div>
        )}
      </div>

      {(pool.patterns.length > 0 || hasOpenClient) && (
        <div className={styles.section}>
          <span className={styles.sectionLabel}>{t('pools.patterns_label')}</span>
          <div className={styles.chips}>
            {hasOpenClient && (
              <span className={`${styles.chip} ${styles.chipOpen}`}>{t('pools.patterns_all')}</span>
            )}
            {pool.patterns.map((pattern) => (
              <span key={pattern} className={styles.chip}>
                {pattern}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export interface UnreachablePoolCardProps {
  entries: UnreachableCredential[];
  showEmails: boolean;
}

/**
 * The card that exists so a mistake cannot hide.
 *
 * A credential that no key can reach looks exactly like a working one in the
 * vault list — it has a valid token, it refreshes, it reports quota. The only
 * place that shows it is serving nothing is here.
 */
export function UnreachablePoolCard({ entries, showEmails }: UnreachablePoolCardProps) {
  const { t } = useTranslation();

  return (
    <article
      className={entries.length > 0 ? `${styles.card} ${styles.cardAlert}` : styles.card}
      aria-label={t('pools.unreachable_title')}
    >
      <header className={styles.head}>
        <span className={styles.family}>{t('pools.unreachable_title')}</span>
        <span className={styles.count}>
          {t('pools.meta_credentials', { count: entries.length })}
        </span>
      </header>

      {entries.length === 0 ? (
        <p className={styles.empty}>{t('pools.unreachable_empty')}</p>
      ) : (
        <>
          <p className={styles.empty}>{t('pools.unreachable_desc')}</p>
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={`${entry.credential.name}:${entry.reason}`} className={styles.member}>
                <span className={styles.memberName}>
                  {displayCredentialName(entry.credential.name, showEmails)}
                </span>
                <span className={styles.reason}>
                  {entry.reason === 'disabled'
                    ? t('pools.reason_disabled')
                    : t('pools.reason_no_client')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
