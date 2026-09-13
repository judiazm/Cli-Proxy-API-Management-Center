/**
 * The raw log, newest first, paged by the store's row-id cursor.
 *
 * The aggregates answer "how much"; this answers "which one". It is the view
 * someone opens after the table showed a spike, so it carries the columns that
 * explain a single request rather than a population: the status code, the
 * latency and time to first token side by side, and the full token split.
 *
 * A cursor rather than an offset because rows keep arriving while the page is
 * open. Offset paging would show the same request twice and skip another.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconDownload, IconLoader2 } from '@/components/ui/icons';
import type { UsageRequestRow } from '@/services/api';
import { downloadBlob } from '@/utils/download';
import { csvBlob, serializeCsv, usageCsvFilename, type CsvValue } from '../logic/csv';
import { formatUsageCount, formatUsageDuration, formatUsageInstant } from '../logic/formatUsage';
import { resolveAccountName, resolveDeviceName, resolveModelName } from '../logic/naming';
import type { AccountIndex, DeviceIndex } from '../logic/naming';
import styles from './UsageViews.module.scss';

export interface UsageRequestsViewProps {
  rows: UsageRequestRow[];
  cursor: number | null;
  loading: boolean;
  onLoadMore: () => void;
  devices: DeviceIndex;
  accounts: AccountIndex;
}

export function UsageRequestsView({
  rows,
  cursor,
  loading,
  onLoadMore,
  devices,
  accounts,
}: UsageRequestsViewProps) {
  const { t, i18n } = useTranslation();

  const deviceLabel = useCallback(
    (row: UsageRequestRow): { primary: string; secondary: string } => {
      const name = resolveDeviceName(row.api_key, devices);
      if (name.kind === 'label') return { primary: name.label, secondary: name.fingerprint };
      if (name.kind === 'unknown') {
        return {
          primary: t('usage.device_unknown', { fingerprint: name.fingerprint }),
          secondary: name.fingerprint,
        };
      }
      return {
        primary: t('usage.device_fallback', { fingerprint: name.fingerprint }),
        secondary: '',
      };
    },
    [devices, t]
  );

  const accountLabel = useCallback(
    (row: UsageRequestRow): string => {
      const name = resolveAccountName(row.auth_id, accounts);
      if (name.kind === 'email') return name.email;
      if (name.kind === 'file') return name.file;
      return name.authId || t('usage.value_none');
    },
    [accounts, t]
  );

  const handleExport = useCallback(() => {
    const header = [
      t('usage.column_time'),
      t('usage.dim_device'),
      t('usage.dim_model'),
      t('usage.column_alias'),
      t('usage.dim_account'),
      t('usage.dim_effort'),
      t('usage.dim_stream'),
      t('usage.column_status'),
      t('usage.column_code'),
      t('usage.metric_latency'),
      t('usage.metric_ttft'),
      t('usage.metric_input_tokens'),
      t('usage.metric_cache_read'),
      t('usage.metric_cache_write'),
      t('usage.metric_output_tokens'),
      t('usage.metric_reasoning'),
      t('usage.metric_total_tokens'),
    ];

    const csvRows: CsvValue[][] = rows.map((row) => [
      row.ts,
      deviceLabel(row).primary,
      row.model,
      row.alias,
      accountLabel(row),
      row.reasoning_effort,
      row.stream ? 'true' : 'false',
      row.failed ? 'failed' : 'ok',
      row.status_code,
      row.latency_ms,
      row.ttft_ms,
      row.input_tokens,
      row.cache_read_tokens,
      row.cache_creation_tokens,
      row.output_tokens,
      row.reasoning_tokens,
      row.total_tokens,
    ]);

    downloadBlob({
      filename: usageCsvFilename(),
      blob: csvBlob(serializeCsv({ header, rows: csvRows })),
    });
  }, [rows, deviceLabel, accountLabel, t]);

  if (rows.length === 0 && !loading) {
    return (
      <section className={styles.panel}>
        <p className={styles.panelNote}>{t('usage.empty_range')}</p>
      </section>
    );
  }

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <p className={styles.panelNote}>{t('usage.requests_note', { count: rows.length })}</p>
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.action}
            onClick={handleExport}
            disabled={rows.length === 0}
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
                {t('usage.column_time')}
              </th>
              <th scope="col">{t('usage.dim_device')}</th>
              <th scope="col">{t('usage.dim_model')}</th>
              <th scope="col">{t('usage.dim_account')}</th>
              <th scope="col">{t('usage.dim_effort')}</th>
              <th scope="col">{t('usage.dim_stream')}</th>
              <th scope="col">{t('usage.column_status')}</th>
              <th scope="col">{t('usage.metric_latency_short')}</th>
              <th scope="col">{t('usage.metric_ttft_short')}</th>
              <th scope="col">{t('usage.metric_input_tokens_short')}</th>
              <th scope="col">{t('usage.metric_cache_read_short')}</th>
              <th scope="col">{t('usage.metric_cache_write_short')}</th>
              <th scope="col">{t('usage.metric_output_tokens_short')}</th>
              <th scope="col">{t('usage.metric_reasoning_short')}</th>
              <th scope="col">{t('usage.metric_total_tokens_short')}</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => {
              const device = deviceLabel(row);
              const model = resolveModelName(row.model, row.alias);
              return (
                <tr key={row.id} className={styles.row}>
                  <td className={`${styles.keyColumn} ${styles.timeCell}`}>
                    {formatUsageInstant(row.ts, i18n.language)}
                  </td>
                  <td>
                    <span className={styles.keyText}>
                      <span className={styles.keyPrimary}>{device.primary}</span>
                      {device.secondary ? (
                        <span className={`${styles.keySecondary} ${styles.keyMono}`}>
                          {device.secondary}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <span className={styles.keyText}>
                      <span className={styles.keyPrimary}>
                        {model.primary || t('usage.value_none')}
                      </span>
                      {model.secondary ? (
                        <span className={`${styles.keySecondary} ${styles.keyMono}`}>
                          {model.secondary}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td>{accountLabel(row)}</td>
                  <td className={styles.flagCell}>
                    {row.reasoning_effort || t('usage.value_none')}
                  </td>
                  <td className={styles.flagCell}>
                    {t(row.stream ? 'usage.stream_on' : 'usage.stream_off')}
                  </td>
                  <td className={row.failed ? styles.statusFail : styles.statusOk}>
                    <span className={styles.codeCell}>
                      {row.failed
                        ? row.status_code
                          ? String(row.status_code)
                          : t('usage.status_failed')
                        : t('usage.status_ok')}
                    </span>
                  </td>
                  <td>{formatUsageDuration(row.latency_ms)}</td>
                  <td>{formatUsageDuration(row.ttft_ms)}</td>
                  <td>{formatUsageCount(row.input_tokens)}</td>
                  <td>{formatUsageCount(row.cache_read_tokens)}</td>
                  <td>{formatUsageCount(row.cache_creation_tokens)}</td>
                  <td>{formatUsageCount(row.output_tokens)}</td>
                  <td>{formatUsageCount(row.reasoning_tokens)}</td>
                  <td>{formatUsageCount(row.total_tokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {cursor !== null ? (
        <div className={styles.loadMore}>
          <button type="button" className={styles.action} onClick={onLoadMore} disabled={loading}>
            {loading ? <IconLoader2 size={13} aria-hidden="true" /> : null}
            {t(loading ? 'usage.loading' : 'usage.load_more')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
