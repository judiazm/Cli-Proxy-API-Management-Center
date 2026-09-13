/**
 * Device by model, or any other pair of dimensions, as a heat-shaded grid.
 *
 * The table view ranks one dimension at a time. This one shows the crossing,
 * which is where the surprises are: a model that looks modest in total because
 * it is spread over five devices, or a device whose whole footprint is one
 * model. Row and column totals stay on screen so a cell can be read against
 * both of its margins without scrolling away from it.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDownload } from '@/components/ui/icons';
import type { UsageGroupColumn, UsageMetrics, UsageSummaryResponse } from '@/services/api';
import { downloadBlob } from '@/utils/download';
import { csvBlob, serializeCsv, usageCsvFilename, type CsvValue } from '../logic/csv';
import { findUsageDimension, findUsageMetric } from '../logic/dimensions';
import { formatUsageExact, formatUsageMetric } from '../logic/formatUsage';
import {
  buildUsageMatrix,
  sortUsageMatrixAxis,
  usageHeatIntensity,
  usageMatrixCell,
  usageMatrixMaxCell,
} from '../logic/matrix';
import { readUsageMetric } from '../logic/metrics';
import { filterNameForDimension } from '../logic/viewState';
import type { UsageLabeller } from '../hooks/useUsageLabels';
import styles from './UsageViews.module.scss';

/** Beyond this many columns the grid stops being a grid and starts being a wall. */
const COLUMN_LIMIT = 40;

export interface UsageMatrixViewProps {
  summary: UsageSummaryResponse;
  rowDimension: UsageGroupColumn;
  columnDimension: UsageGroupColumn;
  metric: keyof UsageMetrics;
  sortDirection: 'asc' | 'desc';
  onSortDirectionChange: (direction: 'asc' | 'desc') => void;
  onDrilldown: (dimension: UsageGroupColumn, value: string) => void;
  labeller: UsageLabeller;
}

export function UsageMatrixView({
  summary,
  rowDimension,
  columnDimension,
  metric,
  sortDirection,
  onSortDirectionChange,
  onDrilldown,
  labeller,
}: UsageMatrixViewProps) {
  const { t } = useTranslation();

  const metricDef = findUsageMetric(metric);
  const unit = metricDef?.unit ?? 'count';
  const rowDef = findUsageDimension(rowDimension);
  const columnDef = findUsageDimension(columnDimension);

  const matrix = useMemo(
    () => buildUsageMatrix(summary.rows, { rowDimension, columnDimension, metric }),
    [summary.rows, rowDimension, columnDimension, metric]
  );

  const rows = useMemo(
    () => sortUsageMatrixAxis(matrix.rows, metric, sortDirection),
    [matrix.rows, metric, sortDirection]
  );
  const columns = useMemo(() => matrix.columns.slice(0, COLUMN_LIMIT), [matrix.columns]);
  const hiddenColumns = matrix.columns.length - columns.length;

  const maxCell = useMemo(() => usageMatrixMaxCell(matrix, metric), [matrix, metric]);

  const rowDrillable = filterNameForDimension(rowDimension) !== null;
  const columnDrillable = filterNameForDimension(columnDimension) !== null;

  const handleExport = useCallback(() => {
    const header = [
      t(rowDef?.labelKey ?? 'usage.dim_device'),
      ...columns.map((column) => labeller.plainLabel(columnDimension, column.key)),
      t('usage.totals'),
    ];

    const csvRows: CsvValue[][] = rows.map((row) => [
      labeller.plainLabel(rowDimension, row.key),
      ...columns.map((column) => {
        const cell = usageMatrixCell(matrix, row.key, column.key);
        return cell ? readUsageMetric(cell.metrics, metric) : 0;
      }),
      readUsageMetric(row.totals, metric),
    ]);

    csvRows.push([
      t('usage.totals'),
      ...columns.map((column) => readUsageMetric(column.totals, metric)),
      readUsageMetric(matrix.totals, metric),
    ]);

    downloadBlob({
      filename: usageCsvFilename(),
      blob: csvBlob(serializeCsv({ header, rows: csvRows })),
    });
  }, [rows, columns, matrix, metric, rowDimension, columnDimension, rowDef, labeller, t]);

  if (rows.length === 0 || columns.length === 0) {
    return (
      <section className={styles.panel}>
        <p className={styles.panelNote}>{t('usage.empty_range')}</p>
      </section>
    );
  }

  const axisHeader = (dimension: UsageGroupColumn, key: string, drillable: boolean) => {
    const resolved = labeller.label(dimension, key);
    const content = (
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
    );

    return drillable && key ? (
      <button
        type="button"
        className={styles.drilldown}
        onClick={() => onDrilldown(dimension, key)}
        title={t('usage.filter_by_value', { value: resolved.primary })}
      >
        {content}
      </button>
    ) : (
      content
    );
  };

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <p className={styles.panelNote}>
          {t('usage.matrix_note', {
            metric: t(metricDef?.labelKey ?? 'usage.metric_total_tokens'),
            rows: rows.length,
            columns: matrix.columns.length,
          })}
          {hiddenColumns > 0 ? ` ${t('usage.matrix_truncated', { count: hiddenColumns })}` : ''}
        </p>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => onSortDirectionChange(sortDirection === 'desc' ? 'asc' : 'desc')}
          >
            {t(sortDirection === 'desc' ? 'usage.sort_desc' : 'usage.sort_asc')}
          </button>
          <button type="button" className={styles.action} onClick={handleExport}>
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
                {t('usage.matrix_axis_header', {
                  row: t(rowDef?.labelKey ?? 'usage.dim_device'),
                  column: t(columnDef?.labelKey ?? 'usage.dim_model'),
                })}
              </th>
              {columns.map((column) => (
                <th key={column.key || '__blank__'} scope="col">
                  {axisHeader(columnDimension, column.key, columnDrillable)}
                </th>
              ))}
              <th scope="col">{t('usage.totals')}</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={row.key || '__blank__'} className={styles.row}>
                <td className={styles.keyColumn}>
                  {axisHeader(rowDimension, row.key, rowDrillable)}
                </td>
                {columns.map((column) => {
                  const cell = usageMatrixCell(matrix, row.key, column.key);
                  const value = cell ? readUsageMetric(cell.metrics, metric) : 0;
                  const intensity = usageHeatIntensity(value, maxCell);
                  return (
                    <td
                      key={column.key || '__blank__'}
                      className={styles.matrixCell}
                      title={value > 0 ? formatUsageExact(value) : undefined}
                    >
                      <span
                        className={styles.heat}
                        style={{ '--heat': intensity * 0.42 } as React.CSSProperties}
                        aria-hidden="true"
                      />
                      <span className={`${styles.heatValue} ${value === 0 ? styles.muted : ''}`}>
                        {value > 0 ? formatUsageMetric(value, unit) : '·'}
                      </span>
                    </td>
                  );
                })}
                <td>{formatUsageMetric(readUsageMetric(row.totals, metric), unit)}</td>
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className={styles.totalsRow}>
              <td className={styles.keyColumn}>{t('usage.totals')}</td>
              {columns.map((column) => (
                <td key={column.key || '__blank__'}>
                  {formatUsageMetric(readUsageMetric(column.totals, metric), unit)}
                </td>
              ))}
              <td>{formatUsageMetric(readUsageMetric(matrix.totals, metric), unit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
