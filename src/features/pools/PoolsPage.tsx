/**
 * Pools view: who can reach which credentials.
 *
 * The gateway stores no pools. It stores credentials that may carry a model
 * prefix, and client API keys that may carry an `allowed-models` allowlist.
 * Read together those two say which credentials serve which clients — a fact
 * nobody can currently see without holding the auth-file list and the config's
 * `api-keys` block side by side and doing the glob matching by hand. This page
 * does that matching.
 *
 * Derivation lives in `logic.ts` (pure, tested); this file is wiring: load,
 * group, and hand the quota store's numbers to the cards.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import { useQuotaStore, useThemeStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { readQuotaShowEmails, writeQuotaShowEmails } from '@/features/quota/uiState';
import { PoolCard, UnreachablePoolCard } from './components/PoolCard';
import { usePoolsData } from './hooks/usePoolsData';
import { derivePools } from './logic';
import { buildPoolQuotaAggregate } from './quota';
import styles from './PoolsPage.module.scss';

const SKELETON_CARD_COUNT = 3;

export function PoolsPage() {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const revealRef = useRevealGroup<HTMLDivElement>();

  const { credentials, clientKeys, loading, error, reload } = usePoolsData();
  useHeaderRefresh(reload);

  // The same stored preference the quota page writes: one decision about
  // whether addresses are on screen, not one per page.
  const [showEmails, setShowEmails] = useState<boolean>(() => readQuotaShowEmails());
  const handleToggleEmails = useCallback(() => {
    setShowEmails((current) => {
      const next = !current;
      writeQuotaShowEmails(next);
      return next;
    });
  }, []);

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByFamily = useMemo<Record<string, Record<string, unknown>>>(
    () => ({
      antigravity: antigravityQuota,
      claude: claudeQuota,
      codex: codexQuota,
      kimi: kimiQuota,
      xai: xaiQuota,
    }),
    [antigravityQuota, claudeQuota, codexQuota, kimiQuota, xaiQuota]
  );

  const quotaFor = useCallback(
    (family: string, name: string) => quotaByFamily[family]?.[name],
    [quotaByFamily]
  );

  const model = useMemo(() => derivePools(credentials, clientKeys), [credentials, clientKeys]);

  const quotaByPool = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildPoolQuotaAggregate>>();
    model.pools.forEach((pool) => {
      map.set(pool.id, buildPoolQuotaAggregate(pool.family, pool.members, quotaFor));
    });
    return map;
  }, [model.pools, quotaFor]);

  const isEmpty = !loading && credentials.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('pools.title')}
          </h1>
          <p className={styles.meta} data-reveal>
            <span>{t('pools.meta_pools', { count: model.pools.length })}</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{t('pools.meta_credentials', { count: model.credentialCount })}</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{t('pools.meta_client_keys', { count: model.clientKeyCount })}</span>
          </p>
        </div>
        <div className={styles.actions} data-reveal>
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={handleToggleEmails}
            aria-pressed={showEmails}
            title={t(showEmails ? 'quota_management.hide_emails' : 'quota_management.show_emails')}
          >
            {showEmails ? (
              <IconEyeOff size={14} aria-hidden="true" />
            ) : (
              <IconEye size={14} aria-hidden="true" />
            )}
            {t(showEmails ? 'quota_management.hide_emails' : 'quota_management.show_emails')}
          </button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className={styles.skeletonList} aria-hidden="true">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            <Skeleton key={index} height={196} rounded={14} />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState title={t('pools.empty_title')} description={t('pools.empty_desc')} />
      ) : (
        <div className={styles.grid} data-reveal>
          {model.pools.map((pool) => (
            <PoolCard
              key={pool.id}
              pool={pool}
              quota={quotaByPool.get(pool.id) ?? null}
              showEmails={showEmails}
              resolvedTheme={resolvedTheme}
            />
          ))}
          <UnreachablePoolCard entries={model.unreachable} showEmails={showEmails} />
        </div>
      )}
    </div>
  );
}
