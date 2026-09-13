/**
 * Usage: what each device and each model actually consumed.
 *
 * The gateway has always had the numbers and never kept them. With the store
 * behind it the question "which client is burning the Claude quota, and on
 * which model" becomes answerable from the panel instead of from a log grep,
 * and the whole point of the page is that the answer is arrived at by looking
 * rather than by querying. So the controls are all visible, every view reads
 * the same window and the same filters, and the state of the page lives in the
 * URL, which makes a finding shareable as a link.
 *
 * This file is wiring. The window arithmetic, the grouping, the pivot, the
 * naming and the CSV all live in `logic/` and are tested there.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import type { UsageGroupColumn } from '@/services/api';
import { UsageControls } from './components/UsageControls';
import { UsageDisabledPanel } from './components/UsageDisabledPanel';
import { UsageMatrixView } from './components/UsageMatrixView';
import { UsageRequestsView } from './components/UsageRequestsView';
import { UsageSummaryStrip } from './components/UsageSummaryStrip';
import { UsageTableView } from './components/UsageTableView';
import { UsageTimelineView } from './components/UsageTimelineView';
import { useUsageData } from './hooks/useUsageData';
import { useUsageLabels } from './hooks/useUsageLabels';
import { useUsageNames } from './hooks/useUsageNames';
import { useUsageView } from './hooks/useUsageView';
import { formatUsageInstant } from './logic/formatUsage';
import { emptyUsageMetrics } from './logic/metrics';
import { applyUsageDrilldown, USAGE_TABS, type UsageTabId } from './logic/viewState';
import styles from './UsagePage.module.scss';

const TAB_LABEL_KEYS: Record<UsageTabId, string> = {
  table: 'usage.tab_table',
  timeline: 'usage.tab_timeline',
  matrix: 'usage.tab_matrix',
  requests: 'usage.tab_requests',
};

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const revealRef = useRevealGroup<HTMLDivElement>();

  const { view, patchView } = useUsageView();
  const names = useUsageNames();
  const labeller = useUsageLabels(names.devices, names.accounts);
  const data = useUsageData(view);

  const reload = useCallback(async () => {
    await Promise.all([data.reload(), names.reload()]);
  }, [data, names]);
  useHeaderRefresh(reload);

  const handleDrilldown = useCallback(
    (dimension: UsageGroupColumn, value: string) => {
      patchView({ filters: applyUsageDrilldown(view.filters, dimension, value) });
    },
    [patchView, view.filters]
  );

  const totals = data.summary?.totals ?? emptyUsageMetrics();
  const hasRows = (data.summary?.rows.length ?? 0) > 0;

  const rangeLabel = useMemo(
    () =>
      t('usage.range_label', {
        from: formatUsageInstant(new Date(data.range.fromMs).toISOString(), i18n.language),
        to: formatUsageInstant(new Date(data.range.toMs).toISOString(), i18n.language),
      }),
    [data.range.fromMs, data.range.toMs, i18n.language, t]
  );

  if (data.disabled) {
    return (
      <div className={styles.page} ref={revealRef}>
        <header className={styles.header}>
          <div className={styles.copy}>
            <h1 className={styles.title} data-reveal>
              {t('usage.title')}
            </h1>
          </div>
        </header>
        <UsageDisabledPanel />
      </div>
    );
  }

  const renderView = () => {
    if (data.loading && !data.summary) {
      return (
        <div className={styles.skeletonStack} aria-hidden="true">
          <Skeleton height={38} rounded={10} />
          <Skeleton height={280} rounded={14} />
        </div>
      );
    }

    if (view.tab === 'requests') {
      return (
        <UsageRequestsView
          rows={data.requests}
          cursor={data.requestsCursor}
          loading={data.requestsLoading}
          onLoadMore={() => void data.loadMoreRequests()}
          devices={names.devices}
          accounts={names.accounts}
        />
      );
    }

    if (!data.summary || !hasRows) {
      return <EmptyState title={t('usage.empty_title')} description={t('usage.empty_range')} />;
    }

    if (view.tab === 'timeline') {
      return (
        <UsageTimelineView
          rows={data.summary.rows}
          bucket={data.bucket}
          seriesDimension={view.primary}
          metric={view.metric}
          labeller={labeller}
        />
      );
    }

    if (view.tab === 'matrix') {
      return (
        <UsageMatrixView
          summary={data.summary}
          rowDimension={view.matrixRow}
          columnDimension={view.matrixColumn}
          metric={view.metric}
          sortDirection={view.sortDirection}
          onSortDirectionChange={(direction) => patchView({ sortDirection: direction })}
          onDrilldown={handleDrilldown}
          labeller={labeller}
        />
      );
    }

    return (
      <UsageTableView
        summary={data.summary}
        primary={view.primary}
        secondary={view.secondary}
        metric={view.metric}
        sortColumn={view.sortColumn}
        sortDirection={view.sortDirection}
        onSortChange={(column, direction) =>
          patchView({ sortColumn: column, sortDirection: direction })
        }
        onDrilldown={handleDrilldown}
        labeller={labeller}
      />
    );
  };

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('usage.title')}
          </h1>
          <p className={styles.meta} data-reveal>
            <span>{rangeLabel}</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span>{data.timeZone}</span>
            {data.meta ? (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span>{t('usage.meta_rows', { count: data.meta.rows })}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className={styles.actions} data-reveal>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => void reload()}
            disabled={data.loading}
          >
            <IconRefreshCw size={14} aria-hidden="true" />
            {t('common.refresh')}
          </button>
        </div>
      </header>

      {data.error && (
        <div className={styles.errorBanner} role="alert">
          {data.error}
        </div>
      )}

      <UsageControls
        view={view}
        onChange={patchView}
        dimensions={data.meta?.dimensions ?? {}}
        labeller={labeller}
        effectiveBucket={data.bucket}
      />

      <UsageSummaryStrip totals={totals} previous={data.previousTotals} />

      <div className={styles.tabs} role="tablist" aria-label={t('usage.title')}>
        {USAGE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view.tab === tab}
            className={`${styles.tab} ${view.tab === tab ? styles.tabActive : ''}`}
            onClick={() => patchView({ tab })}
          >
            {t(TAB_LABEL_KEYS[tab])}
          </button>
        ))}
      </div>

      {renderView()}
    </div>
  );
}
