/**
 * A provider family, read as one position rather than N cards.
 *
 * Five Claude accounts with 58, 100, 100, 51 and 100 percent left are not five
 * facts — they are "409% of a possible 500%, and the first of them comes back
 * tomorrow evening". That aggregate is what decides whether there is headroom
 * today, and no per-credential card shows it.
 *
 * Two things have to agree for the table below the summary to be scannable:
 * which window governs the family (the *binding* window) and which columns
 * exist at all. Both are decided here, once, for every credential in the
 * family — a column a credential does not report becomes a blank cell rather
 * than a shifted one.
 *
 * Pure and clock-free: `nowMs` is passed in.
 */

import {
  MANUAL_RESETS_COLUMN_ID,
  type QuotaCredentialRowModel,
  type QuotaProviderFamily,
  type QuotaWindowCell,
} from './rowModel';

export interface QuotaColumn {
  columnId: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  label?: string;
}

export interface QuotaFamilyMember {
  /** Unique within the family — the credential's file name. */
  key: string;
  /** Null until the credential has been loaded successfully. */
  model: QuotaCredentialRowModel | null;
}

export interface QuotaFamilyAggregate {
  column: QuotaColumn;
  /** Sum of remaining percentages across credentials that reported one. */
  totalRemainingPercent: number | null;
  /** 100 per credential in the family, reported or not. */
  maxRemainingPercent: number;
  /** How many credentials actually contributed a reading. */
  readingCount: number;
}

export interface QuotaFamilySummary {
  family: QuotaProviderFamily;
  credentialCount: number;
  /** The window that governs the family; null when nothing is loaded yet. */
  binding: QuotaFamilyAggregate | null;
  /** Claude's plain 7-day total, shown under the Fable headline. */
  secondary: QuotaFamilyAggregate | null;
  /** One entry per credential, in list order — the strip's sparkbars. */
  bars: (number | null)[];
  /** Soonest binding-window reset still ahead of `nowMs`. */
  soonestResetAtMs: number | null;
}

/**
 * Preferred binding window per family, most-governing first.
 *
 * Claude's weekly Fable bucket is the one that actually runs out; Codex and
 * xAI are governed by the weekly limit. Anything not listed falls back to the
 * longest window a credential reports, because a weekly cap binds harder than
 * a five-hour one.
 */
const BINDING_PREFERENCE: Record<QuotaProviderFamily, readonly string[]> = {
  claude: ['claude_quota.seven_day_fable', 'claude_quota.seven_day', 'claude_quota.five_hour'],
  codex: [
    'codex_quota.secondary_window',
    'codex_quota.team_secondary_window',
    'codex_quota.primary_window',
  ],
  devin: ['devin_quota.weekly', 'devin_quota.daily'],
  xai: ['xai_quota.weekly_limit', 'xai_quota.monthly_credits'],
  meta: ['meta_quota.weekly', 'meta_quota.window'],
  antigravity: [
    'antigravity_quota.weekly_limit',
    'antigravity_quota.daily_limit',
    'antigravity_quota.five_hour_limit',
  ],
  kimi: [],
};

/** The plain 7-day total is worth keeping beside Claude's Fable headline. */
const SECONDARY_COLUMN: Partial<Record<QuotaProviderFamily, string>> = {
  claude: 'claude_quota.seven_day',
};

const toColumn = (cell: QuotaWindowCell): QuotaColumn => ({
  columnId: cell.columnId,
  labelKey: cell.labelKey,
  labelParams: cell.labelParams,
  label: cell.label,
});

/** Every window any credential in the family reports, first-seen order. */
const collectColumns = (members: readonly QuotaFamilyMember[]): Map<string, QuotaColumn> => {
  const columns = new Map<string, QuotaColumn>();
  for (const member of members) {
    for (const cell of member.model?.windows ?? []) {
      if (!columns.has(cell.columnId)) columns.set(cell.columnId, toColumn(cell));
    }
  }
  return columns;
};

/**
 * Which column governs the family.
 *
 * The preference list wins when present. Otherwise the longest window does —
 * `periodHours` is the only comparable thing all six providers report.
 */
export function resolveBindingColumnId(
  family: QuotaProviderFamily,
  members: readonly QuotaFamilyMember[]
): string | null {
  const columns = collectColumns(members);
  for (const preferred of BINDING_PREFERENCE[family] ?? []) {
    if (columns.has(preferred)) return preferred;
  }

  let bestId: string | null = null;
  let bestHours = -Infinity;
  for (const member of members) {
    for (const cell of member.model?.windows ?? []) {
      const hours = cell.periodHours ?? 0;
      if (hours > bestHours) {
        bestHours = hours;
        bestId = cell.columnId;
      }
    }
  }
  return bestId;
}

/**
 * Column order for the family's table.
 *
 * The binding window leads — it is the one being scanned — then the rest in
 * the order the providers reported them, then the manual-reset ledger, which
 * is a different kind of fact and belongs at the end of the row.
 */
export function buildQuotaColumns(
  family: QuotaProviderFamily,
  members: readonly QuotaFamilyMember[]
): QuotaColumn[] {
  const columns = collectColumns(members);
  const bindingId = resolveBindingColumnId(family, members);

  const ordered: QuotaColumn[] = [];
  if (bindingId && columns.has(bindingId)) {
    ordered.push(columns.get(bindingId) as QuotaColumn);
  }
  for (const [columnId, column] of columns) {
    if (columnId !== bindingId) ordered.push(column);
  }
  if (members.some((member) => member.model?.manualResets)) {
    ordered.push({
      columnId: MANUAL_RESETS_COLUMN_ID,
      labelKey: 'codex_quota.reset_credits_label',
    });
  }
  return ordered;
}

const findCell = (
  model: QuotaCredentialRowModel | null,
  columnId: string
): QuotaWindowCell | null => model?.windows.find((cell) => cell.columnId === columnId) ?? null;

const aggregate = (
  members: readonly QuotaFamilyMember[],
  column: QuotaColumn
): QuotaFamilyAggregate => {
  let total = 0;
  let readingCount = 0;
  for (const member of members) {
    const cell = findCell(member.model, column.columnId);
    if (cell?.remainingPercent === null || cell?.remainingPercent === undefined) continue;
    total += cell.remainingPercent;
    readingCount += 1;
  }
  return {
    column,
    totalRemainingPercent: readingCount === 0 ? null : Math.round(total),
    // Denominator stays the whole family: "409% of 500%" is only meaningful
    // against every account, and a shrinking denominator would hide the ones
    // that failed to load.
    maxRemainingPercent: members.length * 100,
    readingCount,
  };
};

export function buildQuotaFamilySummary(
  family: QuotaProviderFamily,
  members: readonly QuotaFamilyMember[],
  nowMs: number
): QuotaFamilySummary {
  const columns = collectColumns(members);
  const bindingId = resolveBindingColumnId(family, members);
  const bindingColumn = bindingId ? (columns.get(bindingId) ?? null) : null;

  const secondaryId = SECONDARY_COLUMN[family];
  const secondaryColumn =
    secondaryId && secondaryId !== bindingId ? (columns.get(secondaryId) ?? null) : null;

  let soonestResetAtMs: number | null = null;
  const bars: (number | null)[] = members.map((member) => {
    const cell = bindingColumn ? findCell(member.model, bindingColumn.columnId) : null;
    const atMs = cell?.resetAtMs ?? null;
    if (atMs !== null && atMs > nowMs && (soonestResetAtMs === null || atMs < soonestResetAtMs)) {
      soonestResetAtMs = atMs;
    }
    return cell?.remainingPercent ?? null;
  });

  return {
    family,
    credentialCount: members.length,
    binding: bindingColumn ? aggregate(members, bindingColumn) : null,
    secondary: secondaryColumn ? aggregate(members, secondaryColumn) : null,
    bars,
    soonestResetAtMs,
  };
}
