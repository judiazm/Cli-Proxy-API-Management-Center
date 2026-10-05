/**
 * Logs → Requests: one row per proxied request, live.
 *
 * Built from the same log buffer as the line view, so it tails as the log
 * tails. Each row is joined by request id to the usage store, which adds what
 * the log never prints: the client key's label, the account, the model and
 * alias, the speed tier, time to first token and tokens.
 *
 * A full client key never reaches the screen: keys show as their config label
 * or a six-character fingerprint, exactly as on the Usage page.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usageStoreApi, type UsageRequestRow } from '@/services/api';
import { useUsageNames } from '@/features/usage/hooks/useUsageNames';
import { resolveAccountName, resolveDeviceName } from '@/features/usage/logic/naming';
import type { AccountIndex, DeviceIndex } from '@/features/usage/logic/naming';
import { formatUsageCount, formatUsageDuration } from '@/features/usage/logic/formatUsage';
import { formatLogInstant } from '@/utils/time/displayZone';
import { isManagementPath, type LogEntry } from '../model/logSelectors';
import {
  EMPTY_LOG_REQUEST_FILTERS,
  buildLogRequestRecords,
  describeServiceTier,
  distinctValues,
  filterLogRequests,
  indexUsageRowsByShortId,
  joinLogRequests,
  statusClassOf,
  SLOW_FIRST_TOKEN_MS,
  type LogRequestFilters,
  type LogRequestJoined,
  type LogRequestStatusClass,
} from '../model/logRequestTable';
import styles from './LogRequestsView.module.scss';

const STATUS_CLASSES: LogRequestStatusClass[] = ['2xx', '4xx', '5xx', 'pending'];
/** Rows rendered at once; the log buffer can hold thousands of requests. */
const PAGE_SIZE = 200;
/** Usage rows read per refresh, newest first, across at most this many pages. */
const USAGE_PAGE_LIMIT = 2000;
const USAGE_MAX_PAGES = 3;
/** Re-read the store at most this often while the log tails. */
const USAGE_REFRESH_MS = 15_000;

const accountLabel = (authId: string | null, accounts: AccountIndex): string => {
  if (!authId) return '';
  const name = resolveAccountName(authId, accounts);
  if (name.kind === 'raw') return name.authId;
  const file = accounts.get(name.file.toLowerCase());
  const note = typeof file?.note === 'string' ? file.note.trim() : '';
  if (note) return note;
  return name.kind === 'email' ? name.email : name.file;
};

const clientLabel = (
  row: LogRequestJoined,
  devices: DeviceIndex
): { primary: string; secondary: string } => {
  const key = row.usage?.api_key ?? '';
  if (key) {
    const name = resolveDeviceName(key, devices);
    if (name.kind === 'label') return { primary: name.label, secondary: name.fingerprint };
    return { primary: name.fingerprint, secondary: row.record.ip ?? '' };
  }
  return { primary: row.record.ip ?? '', secondary: '' };
};

export interface LogRequestsViewProps {
  entries: LogEntry[];
  /** Hide `/v0|v8/management` calls, mirroring the line view's switch. */
  hideManagement: boolean;
}

export function LogRequestsView({ entries, hideManagement }: LogRequestsViewProps) {
  const { t } = useTranslation();
  const { devices, accounts } = useUsageNames();
  const [filters, setFilters] = useState<LogRequestFilters>(EMPTY_LOG_REQUEST_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [usageRows, setUsageRows] = useState<UsageRequestRow[]>([]);
  const [usageState, setUsageState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>(
    'idle'
  );

  const records = useMemo(() => {
    const all = buildLogRequestRecords(entries);
    if (!hideManagement) return all;
    return all.filter((record) => !isManagementPath((record.path ?? '').split('?')[0]));
  }, [entries, hideManagement]);

  // Time range the log covers, widened a little so requests that started
  // before the oldest line still find their stored record.
  const range = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const record of records) {
      if (record.atMs === null) continue;
      if (record.atMs < min) min = record.atMs;
      if (record.atMs > max) max = record.atMs;
    }
    return Number.isFinite(min) ? { from: min - 10 * 60_000, to: max + 2 * 60_000 } : null;
  }, [records]);

  const requestSeq = useRef(0);
  const lastFetchAt = useRef(0);
  const loadUsage = useCallback(async (from: number, to: number) => {
    const seq = (requestSeq.current += 1);
    lastFetchAt.current = Date.now();
    setUsageState((state) => (state === 'ready' ? state : 'loading'));
    try {
      const rows: UsageRequestRow[] = [];
      let before: number | undefined;
      for (let page = 0; page < USAGE_MAX_PAGES; page += 1) {
        const response = await usageStoreApi.getRequests({
          from,
          to,
          limit: USAGE_PAGE_LIMIT,
          before,
        });
        rows.push(...response.rows);
        if (response.next_before === null || response.rows.length < USAGE_PAGE_LIMIT) break;
        before = response.next_before;
      }
      if (seq !== requestSeq.current) return;
      setUsageRows(rows);
      setUsageState('ready');
    } catch {
      if (seq !== requestSeq.current) return;
      setUsageState('unavailable');
    }
  }, []);

  // Refresh the join as the log tails, throttled.
  useEffect(() => {
    if (!range) return;
    const wait = Math.max(0, USAGE_REFRESH_MS - (Date.now() - lastFetchAt.current));
    const timer = window.setTimeout(() => void loadUsage(range.from, range.to), wait);
    return () => window.clearTimeout(timer);
  }, [range, loadUsage]);

  const joined = useMemo(
    () => joinLogRequests(records, indexUsageRowsByShortId(usageRows)),
    [records, usageRows]
  );
  const shown = useMemo(() => filterLogRequests(joined, filters), [joined, filters]);

  const providers = useMemo(() => distinctValues(joined, (row) => row.provider), [joined]);
  const accountsSeen = useMemo(() => distinctValues(joined, (row) => row.authId), [joined]);
  const models = useMemo(() => distinctValues(joined, (row) => row.model), [joined]);
  const counts = useMemo(() => {
    const byClass: Record<string, number> = {};
    let errors = 0;
    let slow = 0;
    for (const row of joined) {
      const cls = row.finished ? statusClassOf(row.status) : 'pending';
      byClass[cls] = (byClass[cls] ?? 0) + 1;
      if (row.isError || row.record.rateLimited) errors += 1;
      if (row.slowFirstToken) slow += 1;
    }
    return { byClass, errors, slow };
  }, [joined]);

  const update = (patch: Partial<LogRequestFilters>) => {
    setVisible(PAGE_SIZE);
    setFilters((current) => ({ ...current, ...patch }));
  };
  const toggleClass = (cls: LogRequestStatusClass) => {
    const next = new Set(filters.statusClasses);
    if (next.has(cls)) next.delete(cls);
    else next.add(cls);
    update({ statusClasses: next });
  };
  const hasFilters =
    filters.statusClasses.size > 0 ||
    Boolean(filters.provider || filters.account || filters.model || filters.text) ||
    filters.errorsOnly ||
    filters.slowOnly;

  // Standard is the default for nearly every request; only name the others.
  const tierLabel = (row: LogRequestJoined): string => {
    const tier = describeServiceTier(row.usage);
    return tier && tier !== 'standard' ? t(`logs.requests_tier_${tier}`) : '';
  };

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
        <input
          type="search"
          className={styles.search}
          value={filters.text}
          onChange={(event) => update({ text: event.target.value })}
          placeholder={t('logs.requests_search_placeholder')}
          aria-label={t('logs.requests_search_placeholder')}
        />
        <div className={styles.chips} role="group" aria-label={t('logs.requests_status')}>
          {STATUS_CLASSES.map((cls) => (
            <button
              key={cls}
              type="button"
              className={`${styles.chip} ${filters.statusClasses.has(cls) ? styles.chipActive : ''}`}
              aria-pressed={filters.statusClasses.has(cls)}
              onClick={() => toggleClass(cls)}
            >
              {cls === 'pending' ? t('logs.requests_in_flight') : cls}
              <span className={styles.chipCount}>{counts.byClass[cls] ?? 0}</span>
            </button>
          ))}
          <button
            type="button"
            className={`${styles.chip} ${styles.chipDanger} ${filters.errorsOnly ? styles.chipActive : ''}`}
            aria-pressed={filters.errorsOnly}
            onClick={() => update({ errorsOnly: !filters.errorsOnly })}
          >
            {t('logs.requests_errors_only')}
            <span className={styles.chipCount}>{counts.errors}</span>
          </button>
          <button
            type="button"
            className={`${styles.chip} ${styles.chipWarn} ${filters.slowOnly ? styles.chipActive : ''}`}
            aria-pressed={filters.slowOnly}
            onClick={() => update({ slowOnly: !filters.slowOnly })}
            title={t('logs.requests_slow_hint', { seconds: SLOW_FIRST_TOKEN_MS / 1000 })}
          >
            {t('logs.requests_slow_only', { seconds: SLOW_FIRST_TOKEN_MS / 1000 })}
            <span className={styles.chipCount}>{counts.slow}</span>
          </button>
        </div>
        <div className={styles.selects}>
          <select
            className={styles.select}
            value={filters.provider}
            onChange={(event) => update({ provider: event.target.value })}
            aria-label={t('logs.requests_provider')}
          >
            <option value="">{t('logs.requests_all_providers')}</option>
            {providers.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            value={filters.account}
            onChange={(event) => update({ account: event.target.value })}
            aria-label={t('logs.requests_account')}
          >
            <option value="">{t('logs.requests_all_accounts')}</option>
            {accountsSeen.map((value) => (
              <option key={value} value={value}>
                {accountLabel(value, accounts)}
              </option>
            ))}
          </select>
          <select
            className={styles.select}
            value={filters.model}
            onChange={(event) => update({ model: event.target.value })}
            aria-label={t('logs.requests_model')}
          >
            <option value="">{t('logs.requests_all_models')}</option>
            {models.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button
              type="button"
              className={styles.clear}
              onClick={() => update({ ...EMPTY_LOG_REQUEST_FILTERS, statusClasses: new Set() })}
            >
              {t('logs.requests_clear')}
            </button>
          )}
        </div>
      </div>

      <p className={styles.summary}>
        {t('logs.requests_summary', { shown: shown.length, total: joined.length })}
        {' · '}
        {usageState === 'unavailable'
          ? t('logs.requests_usage_unavailable')
          : usageState === 'ready'
            ? t('logs.requests_usage_joined', {
                count: joined.filter((row) => row.usage).length,
              })
            : t('logs.requests_usage_loading')}
      </p>

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('logs.requests_col_time')}</th>
              <th scope="col">{t('logs.requests_col_status')}</th>
              <th scope="col" className={styles.num}>
                {t('logs.requests_col_latency')}
              </th>
              <th scope="col" className={styles.num}>
                {t('logs.requests_col_ttft')}
              </th>
              <th scope="col">{t('logs.requests_col_client')}</th>
              <th scope="col">{t('logs.requests_col_account')}</th>
              <th scope="col">{t('logs.requests_col_model')}</th>
              <th scope="col">{t('logs.requests_col_speed')}</th>
              <th scope="col" className={styles.num}>
                {t('logs.requests_col_tokens')}
              </th>
              <th scope="col">{t('logs.requests_col_request')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, visible).map((row) => {
              const { record, usage } = row;
              const status = row.finished ? row.status : null;
              const client = clientLabel(row, devices);
              const isOpen = expanded === record.id;
              const rowClass = [
                styles.row,
                row.isError ? styles.rowError : '',
                !row.isError && (record.rateLimited || record.hasWarn) ? styles.rowWarn : '',
                !row.finished ? styles.rowPending : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <Fragment key={record.id}>
                  <tr
                    className={rowClass}
                    onClick={() => setExpanded(isOpen ? null : record.id)}
                    aria-expanded={isOpen}
                  >
                    <td className={styles.time}>
                      {record.atMs !== null ? formatLogInstant(record.atMs) : '--'}
                    </td>
                    <td>
                      <span
                        className={[
                          styles.status,
                          status === null
                            ? styles.statusPending
                            : status >= 500
                              ? styles.statusError
                              : status === 429
                                ? styles.statusWarn
                                : status >= 400
                                  ? styles.statusWarn
                                  : styles.statusOk,
                        ].join(' ')}
                      >
                        {status ?? t('logs.requests_in_flight')}
                      </span>
                      {record.rateLimited && (
                        <span className={styles.flag}>{t('logs.requests_flag_limited')}</span>
                      )}
                    </td>
                    <td className={styles.num}>
                      {record.latencyMs !== null
                        ? formatUsageDuration(record.latencyMs)
                        : (record.latencyText ?? '')}
                    </td>
                    <td className={`${styles.num} ${row.slowFirstToken ? styles.slow : ''}`}>
                      {row.ttftMs !== null ? formatUsageDuration(row.ttftMs) : ''}
                    </td>
                    <td>
                      <span className={styles.primary}>{client.primary}</span>
                      {client.secondary && (
                        <span className={styles.secondary}>{client.secondary}</span>
                      )}
                    </td>
                    <td>{accountLabel(row.authId, accounts)}</td>
                    <td>
                      <span className={styles.primary}>{row.alias ?? row.model ?? ''}</span>
                      {row.alias && row.model && (
                        <span className={styles.secondary}>{row.model}</span>
                      )}
                    </td>
                    <td>
                      {tierLabel(row) && (
                        <span
                          className={
                            describeServiceTier(usage) === 'ultrafast'
                              ? styles.tierUltrafast
                              : styles.tier
                          }
                        >
                          {tierLabel(row)}
                        </span>
                      )}
                    </td>
                    <td className={styles.num}>
                      {usage ? formatUsageCount(usage.total_tokens) : ''}
                    </td>
                    <td className={styles.request}>
                      {record.method && <span className={styles.method}>{record.method}</span>}
                      <span className={styles.path} title={record.path ?? ''}>
                        {record.path ?? ''}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className={styles.detailRow}>
                      <td colSpan={10}>
                        <dl className={styles.details}>
                          <dt>{t('logs.requests_detail_id')}</dt>
                          <dd>{usage?.request_id ?? record.id}</dd>
                          {usage && (
                            <>
                              <dt>{t('logs.requests_detail_effort')}</dt>
                              <dd>{usage.reasoning_effort || '--'}</dd>
                              <dt>{t('logs.requests_detail_tokens')}</dt>
                              <dd>
                                {t('logs.requests_detail_token_split', {
                                  input: formatUsageCount(usage.input_tokens),
                                  cacheRead: formatUsageCount(usage.cache_read_tokens),
                                  cacheWrite: formatUsageCount(usage.cache_creation_tokens),
                                  output: formatUsageCount(usage.output_tokens),
                                  reasoning: formatUsageCount(usage.reasoning_tokens),
                                })}
                              </dd>
                              <dt>{t('logs.requests_detail_session')}</dt>
                              <dd>{usage.session_id || '--'}</dd>
                              <dt>{t('logs.requests_detail_agent')}</dt>
                              <dd>{usage.user_agent || '--'}</dd>
                            </>
                          )}
                        </dl>
                        {record.events.length > 0 && (
                          <ol className={styles.events}>
                            {record.events.map((event, index) => (
                              <li
                                key={index}
                                className={
                                  event.level === 'error' || event.level === 'fatal'
                                    ? styles.eventError
                                    : event.level === 'warn'
                                      ? styles.eventWarn
                                      : undefined
                                }
                              >
                                <span className={styles.eventTime}>
                                  {event.atMs !== null ? formatLogInstant(event.atMs) : ''}
                                </span>
                                <span className={styles.eventSource}>{event.source}</span>
                                <span>{event.message}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className={styles.empty}>{t('logs.requests_empty')}</p>}
      </div>
      {shown.length > visible && (
        <button
          type="button"
          className={styles.more}
          onClick={() => setVisible((count) => count + PAGE_SIZE)}
        >
          {t('logs.requests_more', { count: Math.min(PAGE_SIZE, shown.length - visible) })}
        </button>
      )}
    </div>
  );
}
