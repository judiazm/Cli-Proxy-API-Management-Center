/**
 * One row per group, every metric sortable, secondary groups folded underneath.
 *
 * This is the view that answers the page's actual question, so it carries the
 * two derived columns the store does not return: share of the selected metric,
 * and cache hit ratio. Both are ratios a reader would otherwise compute from
 * two other columns, which is exactly the work a table should absorb.
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconDownload } from '@/components/ui/icons';
import type { UsageGroupColumn, UsageMetrics, UsageSummaryResponse } from '@/services/api';
import { downloadBlob } from '@/utils/download';
import { USAGE_METRICS, findUsageDimension } from '../logic/dimensions';
import { csvBlob, serializeCsv, usageCsvFilename, type CsvValue } from '../logic/csv';
import { formatUsageExact, formatUsageMetric, formatUsageRatio } from '../logic/formatUsage';
import {
  buildUsageGroupTree,
  sortUsageGroups,
  type UsageSortColumn,
  type UsageSortDirection,
} from '../logic/groupTree';
import { cacheHitRatio, readUsageMetric } from '../logic/metrics';
import { filterNameForDimension } from '../logic/viewState';
import type { UsageLabeller } from '../hooks/useUsageLabels';
import styles from './UsageViews.module.scss';

export interface UsageTableViewProps {
  summary: UsageSummaryResponse;
  primary: UsageGroupColumn;
  secondary: UsageGroupColumn | null;
  metric: keyof UsageMetrics;
  sortColumn: UsageSortColumn;
  sortDirection: UsageSortDirection;
  onSortChange: (column: UsageSortColumn, direction: UsageSortDirection) => void;
  onDrilldown: (dimension: UsageGroupColumn, value: string) => void;
  labeller: UsageLabeller;
}

export function UsageTableView({
  summary,
  primary,
  secondary,
  metric,
  sortColumn,
  sortDirection,
  onSortChange,
  onDrilldown,
  labeller,
}: UsageTableViewProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const primaryDef = findUsageDimension(primary);
  const secondaryDef = secondary ? findUsageDimension(secondary) : undefined;

  const nodes = useMemo(
    () =>
      sortUsageGroups(buildUsageGroupTree(summary.rows, { primary, secondary }), {
        column: sortColumn,
        direction: sortDirection,
        labelOf: (key) => labeller.plainLabel(primary, key),
        childLabelOf: secondary ? (key) => labeller.plainLabel(secondary, key) : undefined,
      }),
    [summary.rows, primary, secondary, sortColumn, sortDirection, labeller]
  );

  const metricTotal = readUsageMetric(summary.totals, metric);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (column: UsageSortColumn) => {
      const sameColumn =
        column.kind === sortColumn.kind &&
        (column.kind === 'key' || column.id === (sortColumn as { id: string }).id);
      if (sameColumn) {
        onSortChange(column, sortDirection === 'desc' ? 'asc' : 'desc');
        return;
      }
      // A fresh numeric column starts at its largest value, which is what a
      // reader clicking "Output" is looking for; the name column starts A-Z.
      onSortChange(column, column.kind === 'key' ? 'asc' : 'desc');
    },
    [sortColumn, sortDirection, onSortChange]
  );

  const isSorted = (column: UsageSortColumn): boolean =>
    column.kind === sortColumn.kind &&
    (column.kind === 'key' || column.id === (sortColumn as { id: string }).id);

  const sortIndicator = (column: UsageSortColumn) =>
    isSorted(column) ? (
      <span className={styles.sortArrow} aria-hidden="true">
        {sortDirection === 'asc' ? '▲' : '▼'}
      </span>
    ) : null;

  const drilldownDimension = filterNameForDimension(primary) ? primary : null;
  const childDrilldown = secondary && filterNameForDimension(secondary) ? secondary : null;

  const handleExport = useCallback(() => {
    const header: string[] = [t(primaryDef?.labelKey ?? 'usage.dim_device')];
    if (secondaryDef) header.push(t(secondaryDef.labelKey));
    USAGE_METRICS.forEach((definition) => header.push(t(definition.labelKey)));
    header.push(t('usage.column_share'), t('usage.column_cache_ratio'));

    const rows: CsvValue[][] = [];
    nodes.forEach((node) => {
      const line: CsvValue[] = [labeller.plainLabel(primary, node.key)];
      if (secondaryDef) line.push('');
      USAGE_METRICS.forEach((definition) =>
        line.push(readUsageMetric(node.metrics, definition.id))
      );
      line.push(
        metricTotal > 0 ? readUsageMetric(node.metrics, metric) / metricTotal : 0,
        cacheHitRatio(node.metrics)
      );
      rows.push(line);

      if (!secondaryDef || !secondary) return;
      node.children.forEach((child) => {
        const childLine: CsvValue[] = [
          labeller.plainLabel(primary, node.key),
          labeller.plainLabel(secondary, child.key),
        ];
        USAGE_METRICS.forEach((definition) =>
          childLine.push(readUsageMetric(child.metrics, definition.id))
        );
        childLine.push(
          metricTotal > 0 ? readUsageMetric(child.metrics, metric) / metricTotal : 0,
          cacheHitRatio(child.metrics)
        );
        rows.push(childLine);
      });
    });

    downloadBlob({
      filename: usageCsvFilename(),
      blob: csvBlob(serializeCsv({ header, rows })),
    });
  }, [nodes, primary, primaryDef, secondary, secondaryDef, metric, metricTotal, labeller, t]);

  const renderKeyCell = (
    dimension: UsageGroupColumn,
    key: string,
    options: { expandable?: boolean; expandedNow?: boolean; child?: boolean } = {}
  ) => {
    const resolved = labeller.label(dimension, key);
    const canDrill = (options.child ? childDrilldown : drilldownDimension) !== null && key !== '';

    const content = (
      <>
        {options.child ? <span className={styles.childIndent} aria-hidden="true" /> : null}
        <span className={styles.keyText}>
          <span className={styles.keyPrimary} title={resolved.primary}>
            {resolved.primary}
          </span>
          {resolved.secondary ? (
            <span
              className={`${styles.keySecondary} ${resolved.monoSecondary ? styles.keyMono : ''}`}
              title={resolved.secondary}
            >
              {resolved.secondary}
            </span>
          ) : null}
        </span>
      </>
    );

    return (
      <div className={styles.keyCell}>
        {options.expandable ? (
          <button
            type="button"
            className={`${styles.expandToggle} ${options.expandedNow ? styles.expandOpen : ''}`}
            onClick={() => toggleExpanded(key)}
            aria-expanded={options.expandedNow}
            aria-label={t(options.expandedNow ? 'usage.collapse_row' : 'usage.expand_row')}
          >
            <IconChevronDown size={13} />
          </button>
        ) : options.child ? null : (
          <span className={styles.expandSpacer} aria-hidden="true" />
        )}
        {canDrill ? (
          <button
            type="button"
            className={styles.drilldown}
            onClick={() => onDrilldown(dimension, key)}
            title={t('usage.filter_by_value', { value: resolved.primary })}
          >
            {content}
          </button>
        ) : (
          <div className={styles.drilldown} aria-hidden="false">
            {content}
          </div>
        )}
      </div>
    );
  };

  const renderMetricCells = (metrics: UsageMetrics) => (
    <>
      {USAGE_METRICS.map((definition) => {
        const value = readUsageMetric(metrics, definition.id);
        const isFailureColumn = definition.id === 'failed' && value > 0;
        return (
          <td
            key={definition.id}
            className={isFailureColumn ? styles.failureValue : undefined}
            title={definition.unit === 'ms' ? undefined : formatUsageExact(value)}
          >
            {formatUsageMetric(value, definition.unit)}
          </td>
        );
      })}
    </>
  );

  const renderShareCell = (metrics: UsageMetrics) => {
    const share = metricTotal > 0 ? readUsageMetric(metrics, metric) / metricTotal : null;
    return (
      <td>
        <span className={styles.shareBar} aria-hidden="true">
          <span
            className={styles.shareFill}
            style={{ width: `${Math.min(100, (share ?? 0) * 100)}%` }}
          />
        </span>
        {formatUsageRatio(share)}
      </td>
    );
  };

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <p className={styles.panelNote}>{t('usage.table_note', { count: nodes.length })}</p>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.action}
            onClick={handleExport}
            disabled={nodes.length === 0}
          >
            <IconDownload size={13} aria-hidden="true" />
            {t('usage.export_csv')}
          </button>
        </div>
      </div>

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.keyColumn}>
                <button
                  type="button"
                  className={`${styles.sortButton} ${isSorted({ kind: 'key' }) ? styles.sortActive : ''}`}
                  onClick={() => handleSort({ kind: 'key' })}
                >
                  {t(primaryDef?.labelKey ?? 'usage.dim_device')}
                  {sortIndicator({ kind: 'key' })}
                </button>
              </th>
              {USAGE_METRICS.map((definition) => {
                const column: UsageSortColumn = { kind: 'metric', id: definition.id };
                return (
                  <th key={definition.id} scope="col">
                    <button
                      type="button"
                      className={`${styles.sortButton} ${isSorted(column) ? styles.sortActive : ''}`}
                      onClick={() => handleSort(column)}
                      title={t(definition.labelKey)}
                    >
                      {t(definition.shortLabelKey)}
                      {sortIndicator(column)}
                    </button>
                  </th>
                );
              })}
              <th scope="col">{t('usage.column_share')}</th>
              <th scope="col" title={t('usage.column_cache_ratio_hint')}>
                {t('usage.column_cache_ratio')}
              </th>
            </tr>
          </thead>

          <tbody>
            {nodes.map((node) => {
              const isExpanded = expanded.has(node.key);
              const expandable = node.children.length > 1;
              return (
                <Fragment key={node.key || '__blank__'}>
                  <tr className={styles.row}>
                    <td className={styles.keyColumn}>
                      {renderKeyCell(primary, node.key, {
                        expandable,
                        expandedNow: isExpanded,
                      })}
                    </td>
                    {renderMetricCells(node.metrics)}
                    {renderShareCell(node.metrics)}
                    <td>{formatUsageRatio(cacheHitRatio(node.metrics))}</td>
                  </tr>

                  {isExpanded && secondary
                    ? node.children.map((child) => (
                        <tr
                          key={`${node.key}/${child.key}`}
                          className={`${styles.row} ${styles.childRow}`}
                        >
                          <td className={styles.keyColumn}>
                            {renderKeyCell(secondary, child.key, { child: true })}
                          </td>
                          {renderMetricCells(child.metrics)}
                          {renderShareCell(child.metrics)}
                          <td>{formatUsageRatio(cacheHitRatio(child.metrics))}</td>
                        </tr>
                      ))
                    : null}
                </Fragment>
              );
            })}
          </tbody>

          <tfoot>
            <tr className={styles.totalsRow}>
              <td className={styles.keyColumn}>{t('usage.totals')}</td>
              {USAGE_METRICS.map((definition) => (
                <td key={definition.id}>
                  {formatUsageMetric(
                    readUsageMetric(summary.totals, definition.id),
                    definition.unit
                  )}
                </td>
              ))}
              <td>{formatUsageRatio(metricTotal > 0 ? 1 : null)}</td>
              <td>{formatUsageRatio(cacheHitRatio(summary.totals))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
