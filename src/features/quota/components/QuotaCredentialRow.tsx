/**
 * One credential, one row.
 *
 * The card grid this replaces put every window of every credential in its own
 * little stack, so comparing the 5-hour limit across five accounts meant five
 * separate reads at five different vertical positions. Here each window owns a
 * column for the whole provider family: the same limit sits at the same x for
 * every row, and a family's weak account is found by looking down, not around.
 *
 * A credential that does not report one of the family's windows gets an empty
 * cell rather than a shifted one — the alignment is the whole point.
 *
 * Behaviour carried over from the card unchanged: click-to-load for existing
 * providers, one automatic load for visible Devin credentials, per-credential
 * refresh, and the Codex manual reset with its confirmation flow.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import {
  MANUAL_RESETS_COLUMN_ID,
  displayCredentialName,
  formatInstantShort,
  resolveQuotaErrorMessage,
  type QuotaColumn,
  type QuotaCredentialRowModel,
  type QuotaWindowCell,
} from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { HOUR_MS } from '@/utils/time/durations';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { bindClassMap } from '../types';
import { QUOTA_BAR_CLASS_KEYS, QuotaBar } from './QuotaBar';
import { QUOTA_COUNTDOWN_CLASS_KEYS, QuotaCountdown } from './QuotaCountdown';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaCredentialRow.module.scss';

const SOURCE = 'QuotaCredentialRow.module.scss';
const barClasses = bindClassMap(QUOTA_BAR_CLASS_KEYS, styles, SOURCE);
const countdownClasses = bindClassMap(QUOTA_COUNTDOWN_CLASS_KEYS, styles, SOURCE);

export interface QuotaCredentialRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  /** Flattened cells; null unless the credential loaded successfully. */
  model: QuotaCredentialRowModel | null;
  /** The family's column order — identical for every row in the section. */
  columns: QuotaColumn[];
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  canRefresh: boolean;
  resetting: boolean;
  nowMs: number;
  onRefresh: () => void;
  onReset: () => void;
}

/** Plan badge finishes are finalized assets; borrow them, never re-cut them. */
const planBadgeClass = (tier: 'elite' | 'premium' | 'plain'): string => {
  if (tier === 'elite') return bodyStyles.elitePlanValue;
  if (tier === 'premium') return bodyStyles.premiumPlanValue;
  return styles.planPlain;
};

/**
 * The cell whose capacity returns first, and only inside the final hour.
 *
 * A reset three days out is information; one in forty minutes changes what you
 * do next, and that is the only case worth pulling the eye to.
 */
const urgentColumnId = (cells: QuotaWindowCell[], nowMs: number): string | null => {
  let bestId: string | null = null;
  let bestMs = Infinity;
  for (const cell of cells) {
    const atMs = cell.resetAtMs;
    if (atMs === null || atMs === undefined) continue;
    const delta = atMs - nowMs;
    if (delta <= 0 || delta >= HOUR_MS) continue;
    if (atMs < bestMs) {
      bestMs = atMs;
      bestId = cell.columnId;
    }
  }
  return bestId;
};

export function QuotaCredentialRow(props: QuotaCredentialRowProps) {
  const {
    entry,
    quota,
    model,
    columns,
    resolvedTheme,
    showEmails,
    canRefresh,
    resetting,
    nowMs,
    onRefresh,
    onReset,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, entry.type);
  const displayName = displayCredentialName(getQuotaDisplayName(file), showEmails);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  const cellsById = new Map((model?.windows ?? []).map((cell) => [cell.columnId, cell]));
  const urgentId = urgentColumnId(model?.windows ?? [], nowMs);
  // Never fewer than one cell track, so the idle/loading/error block always has
  // a column to span and `repeat(0, …)` can never invalidate the template.
  const trackCount = Math.max(1, columns.length);

  const columnLabel = (column: QuotaColumn | QuotaWindowCell): string =>
    column.labelKey
      ? t(column.labelKey, column.labelParams as Record<string, string | number>)
      : (column.label ?? '');

  const renderWindowCell = (column: QuotaColumn) => {
    const cell = cellsById.get(column.columnId);
    if (!cell) {
      return (
        <div key={column.columnId} className={`${styles.cell} ${styles.cellAbsent}`}>
          <span className={styles.cellLabel} title={columnLabel(column)}>
            {columnLabel(column)}
          </span>
          <span className={styles.cellNone}>{t('quota_management.not_reported')}</span>
        </div>
      );
    }

    const percentLabel =
      cell.remainingPercent === null ? '--' : `${Math.round(cell.remainingPercent)}%`;
    const urgent = cell.columnId === urgentId;

    return (
      <div
        key={column.columnId}
        className={styles.cell}
        title={cell.description || (urgent ? t('quota_management.soonest_row_hint') : undefined)}
      >
        <div className={styles.cellHead}>
          <span className={styles.cellLabel} title={columnLabel(cell)}>
            {columnLabel(cell)}
          </span>
          <span className={styles.cellValue}>{percentLabel}</span>
        </div>
        <QuotaBar percent={cell.remainingPercent} classes={barClasses} />
        {cell.amountLabel && <span className={styles.cellAmount}>{cell.amountLabel}</span>}
        <span className={urgent ? styles.cellResetSoon : styles.cellReset}>
          <QuotaCountdown
            absoluteLabel={cell.resetLabel}
            atMs={cell.resetAtMs}
            nowMs={nowMs}
            locale={locale}
            classes={countdownClasses}
            emptyLabel={t('quota_management.no_reset_pending')}
            hint={cell.resetHint}
          />
        </span>
      </div>
    );
  };

  const renderManualResetsCell = (column: QuotaColumn) => {
    const manualResets = model?.manualResets;
    if (!manualResets) {
      return (
        <div key={column.columnId} className={`${styles.cell} ${styles.cellAbsent}`}>
          <span className={styles.cellLabel} title={columnLabel(column)}>
            {columnLabel(column)}
          </span>
          <span className={styles.cellNone}>{t('quota_management.not_reported')}</span>
        </div>
      );
    }

    return (
      <div key={column.columnId} className={styles.cell}>
        <div className={styles.cellHead}>
          <span className={styles.cellLabel} title={columnLabel(column)}>
            {columnLabel(column)}
          </span>
          <span className={styles.cellValue}>{manualResets.count ?? '--'}</span>
        </div>
        {manualResets.credits.length > 0 && (
          <div
            className={styles.credits}
            title={t('codex_quota.reset_credits_expiry_label', {
              timezone: resolveTimeZoneLabel(),
            })}
          >
            {manualResets.credits.map((credit, index) => (
              <div key={credit.id} className={styles.creditRow}>
                <span className={styles.creditLabel}>
                  {t('codex_quota.reset_credit_number', { index: index + 1 })}
                </span>
                <QuotaCountdown
                  absoluteLabel={
                    credit.expiresAtMs === null
                      ? credit.expiresAtLabel
                      : formatInstantShort(credit.expiresAtMs)
                  }
                  atMs={credit.expiresAtMs}
                  nowMs={nowMs}
                  locale={locale}
                  classes={countdownClasses}
                  emptyLabel={t('quota_management.no_reset_pending')}
                />
              </div>
            ))}
          </div>
        )}
        {manualResets.error && (
          <span className={styles.cellError}>
            {t('codex_quota.reset_credits_expiry_failed', { message: manualResets.error })}
          </span>
        )}
      </div>
    );
  };

  const renderState = () => {
    if (status === 'idle') {
      return (
        <button
          type="button"
          className={styles.idleCell}
          style={{ gridColumn: `span ${trackCount}` }}
          onClick={onRefresh}
          disabled={!canRefresh}
        >
          <IconRefreshCw size={14} aria-hidden="true" />
          <span>{t(`${adapter.i18nPrefix}.idle`)}</span>
        </button>
      );
    }
    if (loading) {
      return (
        <div
          className={styles.loadingCell}
          style={{ gridColumn: `span ${trackCount}` }}
          aria-busy="true"
        >
          <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
          <span className={styles.skeletonBar} aria-hidden="true" />
          <span className={styles.skeletonBar} aria-hidden="true" />
        </div>
      );
    }
    if (status === 'error') {
      return (
        <div className={styles.errorCell} style={{ gridColumn: `span ${trackCount}` }} role="alert">
          {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
        </div>
      );
    }
    if (model && model.windows.length === 0 && model.messageKey) {
      return (
        <div className={styles.messageCell} style={{ gridColumn: `span ${trackCount}` }}>
          {t(model.messageKey)}
        </div>
      );
    }
    return columns.map((column) =>
      column.columnId === MANUAL_RESETS_COLUMN_ID
        ? renderManualResetsCell(column)
        : renderWindowCell(column)
    );
  };

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <span
          className={styles.iconWrap}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(entry.type)
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
        <div className={styles.identityText}>
          <span className={styles.name} title={displayName}>
            {displayName}
          </span>
          {(model?.plan || model?.renewal || (model?.notes.length ?? 0) > 0) && (
            <div className={styles.sub}>
              {model?.plan && (
                <span className={planBadgeClass(model.plan.tier)}>
                  {model.plan.labelKey ? t(model.plan.labelKey) : model.plan.text}
                </span>
              )}
              {model?.renewal && (
                <span className={styles.renewal}>
                  <span className={styles.renewalLabel}>{t(model.renewal.labelKey)}</span>
                  <QuotaCountdown
                    absoluteLabel={model.renewal.label || null}
                    atMs={model.renewal.atMs}
                    nowMs={nowMs}
                    locale={locale}
                    classes={countdownClasses}
                    emptyLabel="--"
                  />
                </span>
              )}
              {model?.notes.map((note) => (
                <span key={note.labelKey} className={styles.note}>
                  <span className={styles.noteLabel}>{t(note.labelKey)}</span>
                  <span className={styles.noteValue}>
                    {note.valueKey ? t(note.valueKey) : note.value}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {renderState()}

      <div className={styles.actions}>
        {showReset && (
          <button
            type="button"
            className={styles.actionPill}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            title={t('codex_quota.reset_button')}
          >
            <IconRefreshCw size={12} className={resetting ? styles.spinning : undefined} />
            {t('codex_quota.reset_button')}
          </button>
        )}
        <button
          type="button"
          className={styles.actionPill}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw size={12} className={loading ? styles.spinning : undefined} />
          {t('auth_files.quota_refresh_single')}
        </button>
      </div>
    </li>
  );
}
