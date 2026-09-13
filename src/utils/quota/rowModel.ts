/**
 * One credential, flattened into the shape the quota list renders.
 *
 * The list is a table now: every credential in a provider family is one row,
 * and a given window occupies the same column in every row so a column can be
 * scanned top to bottom. That only works if the six provider states, which
 * disagree about where a window lives, what it is called, and whether the
 * number is used or remaining, are read into one vocabulary first. This is
 * that reading.
 *
 * Pure, React-free and i18n-free: labels come back as keys plus params, so the
 * component decides the language and this stays directly testable. Every
 * number is *remaining* capacity, matching the bars.
 */

import type {
  AntigravityQuotaState,
  AntigravityQuotaSubscription,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiBillingSummary,
  XaiQuotaState,
} from '@/types';
import { formatDateTimeValue } from '@/utils/format';
import { normalizePlanType } from './parsers';
import { PREMIUM_CODEX_PLAN_TYPES, resolvePlanTier, type CodexPlanTier } from './planTier';
import { parseIsoToMs, resolveResetMs } from './resetInstants';
import { clampPercent, remainingFromUsed } from './tone';

/**
 * The provider families that report a quota. Declared here rather than in the
 * feature so this module stays at the bottom of the import graph;
 * `QuotaProviderType` is an alias of it.
 */
export type QuotaProviderFamily =
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'devin'
  | 'kimi'
  | 'meta'
  | 'xai';

/** Column key for the manual-reset ledger, which is not a usage window. */
export const MANUAL_RESETS_COLUMN_ID = '__manual_resets__';

export interface QuotaWindowCell {
  /**
   * Column identity, shared by the same window across every credential in a
   * family. Derived from the label rather than the row id because Codex mints
   * per-model ids with a positional suffix, which would split one column into
   * several the moment two accounts list their extra limits in a different
   * order.
   */
  columnId: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  label?: string;
  /** Remaining capacity, 0–100. Null when the provider reported none. */
  remainingPercent: number | null;
  /** Absolute reset label baked at fetch time; null when there is none. */
  resetLabel: string | null;
  resetAtMs: number | null;
  /** Free-text countdown for providers that only report a relative hint. */
  resetHint?: string;
  /** Secondary figure beside the percentage (xAI dollar amounts). */
  amountLabel?: string;
  /** Tooltip text — model lists, group names. */
  description?: string;
  /** Window length in hours, used to pick a family's binding window. */
  periodHours?: number | null;
}

export interface QuotaPlanBadge {
  labelKey?: string;
  text?: string;
  /** Drives the badge finish: `elite` platinum, `premium` gold, `plain` text. */
  tier: CodexPlanTier;
}

export interface QuotaRowNote {
  labelKey: string;
  value?: string;
  valueKey?: string;
}

export interface QuotaManualResetCredit {
  id: string;
  expiresAtMs: number | null;
  expiresAtLabel: string;
}

export interface QuotaManualResets {
  count: number | null;
  credits: QuotaManualResetCredit[];
  error: string;
}

export interface QuotaCredentialRowModel {
  plan: QuotaPlanBadge | null;
  /** Subscription renewal — a billing date, never a capacity reset. */
  renewal: { labelKey: string; label: string; atMs: number | null } | null;
  notes: QuotaRowNote[];
  manualResets: QuotaManualResets | null;
  windows: QuotaWindowCell[];
  /** Shown in place of the cells when a credential reports nothing usable. */
  messageKey: string | null;
}

const EMPTY_MODEL: QuotaCredentialRowModel = {
  plan: null,
  renewal: null,
  notes: [],
  manualResets: null,
  windows: [],
  messageKey: null,
};

/** Providers bake `'-'` for "no timestamp"; the list wants a real absence. */
const normalizeResetLabel = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed !== '-' ? trimmed : null;
};

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Label-derived column key — stable across credentials, unlike the row id. */
const columnIdFrom = (
  labelKey: string | undefined,
  labelParams: Record<string, string | number> | undefined,
  fallback: string
): string => {
  if (!labelKey) return slug(fallback) || fallback;
  const name = labelParams?.name;
  return name === undefined ? labelKey : `${labelKey}|${slug(String(name))}`;
};

/* ---------- plan labels (shared with the provider bodies) ---------- */

/** Codex plan chip. Falls back to the raw payload value when unrecognized. */
export function codexPlanBadge(planType: string | null | undefined): QuotaPlanBadge | null {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  const tier = resolvePlanTier(planType);
  if (normalized === 'pro') return { labelKey: 'codex_quota.plan_pro', tier };
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized))
    return { labelKey: 'codex_quota.plan_prolite', tier };
  if (normalized === 'plus') return { labelKey: 'codex_quota.plan_plus', tier };
  if (normalized === 'team') return { labelKey: 'codex_quota.plan_team', tier };
  if (normalized === 'free') return { labelKey: 'codex_quota.plan_free', tier };
  return { text: planType || normalized, tier };
}

const XAI_SUPERGROK_LIMIT_CENTS = 15_000;
const XAI_SUPERGROK_HEAVY_LIMIT_CENTS = 150_000;

/** xAI reports no plan name — the monthly allowance is what identifies it. */
export function xaiPlanBadge(monthlyLimitCents: number | null): QuotaPlanBadge | null {
  if (monthlyLimitCents === XAI_SUPERGROK_LIMIT_CENTS) {
    return { labelKey: 'xai_quota.plan_supergrok', tier: 'plain' };
  }
  if (monthlyLimitCents === XAI_SUPERGROK_HEAVY_LIMIT_CENTS) {
    return { labelKey: 'xai_quota.plan_supergrok_heavy', tier: 'premium' };
  }
  return null;
}

export function antigravityPlanBadge(
  subscription: AntigravityQuotaSubscription | null | undefined
): QuotaPlanBadge | null {
  if (!subscription) return null;
  const plan = subscription.plan;
  const premium = plan === 'ultra' || plan === 'ultra-lite';
  const tier: CodexPlanTier = premium ? 'premium' : 'plain';
  if (plan === 'free') return { labelKey: 'antigravity_subscription.plan_free', tier };
  if (plan === 'pro') return { labelKey: 'antigravity_subscription.plan_pro', tier };
  if (plan === 'ultra') return { labelKey: 'antigravity_subscription.plan_ultra', tier };
  if (plan === 'ultra-lite') return { labelKey: 'antigravity_subscription.plan_ultra_lite', tier };
  const fallback = subscription.tierName || subscription.tierId;
  if (fallback) return { text: fallback, tier };
  if (plan === 'unknown') return { labelKey: 'antigravity_subscription.plan_unknown', tier };
  return null;
}

/* ---------- Antigravity label lookup (shared with its body) ---------- */

const ANTIGRAVITY_GROUP_LABEL_KEYS = new Map<string, string>([
  ['gemini models', 'group_gemini_models'],
  ['claude and gpt models', 'group_claude_gpt_models'],
]);

const ANTIGRAVITY_BUCKET_LABEL_KEYS = new Map<string, string>([
  ['weekly limit', 'weekly_limit'],
  ['daily limit', 'daily_limit'],
  ['5 hour limit', 'five_hour_limit'],
  ['5-hour limit', 'five_hour_limit'],
  ['five hour limit', 'five_hour_limit'],
  ['monthly limit', 'monthly_limit'],
]);

/** Antigravity sends English display names; map the known ones onto keys. */
export function antigravityLabelKey(value: string, scope: 'group' | 'bucket'): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const keys = scope === 'group' ? ANTIGRAVITY_GROUP_LABEL_KEYS : ANTIGRAVITY_BUCKET_LABEL_KEYS;
  const key = keys.get(normalized);
  return key ? `antigravity_quota.${key}` : null;
}

/* ---------- xAI money formatting ---------- */

const formatUsdFromCents = (cents: number | null): string =>
  cents === null
    ? '--'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);

const formatRemainingAmount = (capCents: number | null, usedCents: number | null): string => {
  const remainingCents =
    capCents !== null && usedCents !== null ? Math.max(0, capCents - usedCents) : null;
  const remaining = formatUsdFromCents(remainingCents);
  if (capCents === null) return remaining;
  return `${remaining} / ${formatUsdFromCents(capCents)}`;
};

/* ---------- per-family builders ---------- */

const buildClaudeModel = (quota: ClaudeQuotaState): QuotaCredentialRowModel => {
  const extraUsage = quota.extraUsage ?? null;
  const notes: QuotaRowNote[] = [];
  if (extraUsage?.is_enabled) {
    notes.push({
      labelKey: 'claude_quota.extra_usage_label',
      value: `$${(extraUsage.used_credits / 100).toFixed(2)} / $${(extraUsage.monthly_limit / 100).toFixed(2)}`,
    });
  }

  const windows = (quota.windows ?? []).map<QuotaWindowCell>((window) => ({
    columnId: columnIdFrom(window.labelKey, undefined, window.id),
    labelKey: window.labelKey,
    label: window.label,
    remainingPercent: remainingFromUsed(window.usedPercent),
    resetLabel: normalizeResetLabel(window.resetLabel),
    resetAtMs: window.resetAtMs ?? null,
    periodHours: window.periodHours ?? null,
  }));

  return {
    ...EMPTY_MODEL,
    plan: quota.planType ? { labelKey: `claude_quota.${quota.planType}`, tier: 'plain' } : null,
    notes,
    windows,
    messageKey: windows.length === 0 ? 'claude_quota.empty_windows' : null,
  };
};

const buildCodexModel = (quota: CodexQuotaState): QuotaCredentialRowModel => {
  const activeUntil = quota.subscriptionActiveUntil ?? null;
  const renewalMs = resolveResetMs([activeUntil]);
  const renewal =
    activeUntil === null
      ? null
      : {
          labelKey: 'codex_quota.expires_label',
          label: renewalMs === null ? formatDateTimeValue(activeUntil) : '',
          atMs: renewalMs,
        };

  const credits = (quota.rateLimitResetCredits ?? []).map<QuotaManualResetCredit>(
    (credit, index) => ({
      id: credit.id || `${credit.expiresAt}-${index}`,
      expiresAtMs: parseIsoToMs(credit.expiresAt),
      expiresAtLabel: credit.expiresAt,
    })
  );

  const availableCount = quota.rateLimitResetCreditsAvailableCount ?? null;
  const error = quota.rateLimitResetCreditsError ?? '';
  const manualResets =
    availableCount === null && credits.length === 0 && !error
      ? null
      : { count: availableCount, credits, error };

  const windows = (quota.windows ?? []).map<QuotaWindowCell>((window) => ({
    columnId: columnIdFrom(window.labelKey, window.labelParams, window.id),
    labelKey: window.labelKey,
    labelParams: window.labelParams,
    label: window.label,
    remainingPercent: remainingFromUsed(window.usedPercent),
    resetLabel: normalizeResetLabel(window.resetLabel),
    resetAtMs: window.resetAtMs ?? null,
    periodHours: window.periodHours ?? null,
  }));

  return {
    ...EMPTY_MODEL,
    plan: codexPlanBadge(quota.planType),
    renewal,
    manualResets,
    windows,
    messageKey: windows.length === 0 ? 'codex_quota.empty_windows' : null,
  };
};

const buildDevinModel = (quota: DevinQuotaState): QuotaCredentialRowModel => {
  const windows = (quota.windows ?? []).map<QuotaWindowCell>((window) => ({
    columnId: `devin_quota.${window.id}`,
    labelKey: `devin_quota.${window.id}`,
    remainingPercent:
      window.remainingPercent === null ? null : clampPercent(window.remainingPercent),
    resetLabel: null,
    resetAtMs: window.resetAtMs ?? null,
    periodHours: window.periodHours,
  }));

  return {
    ...EMPTY_MODEL,
    plan: quota.plan ? { text: quota.plan, tier: 'plain' } : null,
    renewal:
      quota.planEndMs === null
        ? null
        : {
            labelKey: 'devin_quota.plan_end',
            label: '',
            atMs: quota.planEndMs,
          },
    windows,
    messageKey: windows.length === 0 ? 'devin_quota.empty_data' : null,
  };
};

const buildKimiModel = (quota: KimiQuotaState): QuotaCredentialRowModel => {
  const windows = (quota.rows ?? []).map<QuotaWindowCell>((row) => {
    const remaining =
      row.limit > 0
        ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100))
        : row.used > 0
          ? 0
          : null;
    return {
      columnId: columnIdFrom(row.labelKey, row.labelParams, row.label ?? row.id),
      labelKey: row.labelKey,
      labelParams: row.labelParams,
      label: row.label,
      remainingPercent: remaining,
      resetLabel: null,
      resetAtMs: row.resetAtMs ?? null,
      resetHint: row.resetAtMs == null ? row.resetHint : undefined,
      periodHours: row.periodHours ?? null,
    };
  });

  return {
    ...EMPTY_MODEL,
    windows,
    messageKey: windows.length === 0 ? 'kimi_quota.empty_data' : null,
  };
};

const buildMetaModel = (quota: MetaQuotaState): QuotaCredentialRowModel => {
  const windows = (quota.data?.windows ?? []).map<QuotaWindowCell>((window) => ({
    columnId: `meta_quota.${window.id}`,
    labelKey:
      window.id === 'window' && window.durationMinutes
        ? 'meta_quota.window_duration'
        : `meta_quota.${window.id}`,
    labelParams:
      window.id === 'window' && window.durationMinutes
        ? { minutes: window.durationMinutes }
        : undefined,
    remainingPercent: remainingFromUsed(window.usedPercent),
    resetLabel: null,
    resetAtMs: window.resetAt === undefined ? null : window.resetAt * 1000,
    periodHours:
      window.durationMinutes === undefined
        ? window.id === 'weekly'
          ? 24 * 7
          : null
        : window.durationMinutes / 60,
  }));

  const notes: QuotaRowNote[] =
    quota.data?.isSubscriptionActive === undefined
      ? []
      : [
          {
            labelKey: quota.data.isSubscriptionActive
              ? 'meta_quota.active'
              : 'meta_quota.inactive',
          },
        ];

  return {
    ...EMPTY_MODEL,
    plan: quota.data?.planName ? { text: quota.data.planName, tier: 'plain' } : null,
    notes,
    windows,
    messageKey: windows.length === 0 ? 'meta_quota.empty_data' : null,
  };
};

const buildXaiModel = (quota: XaiQuotaState): QuotaCredentialRowModel => {
  const billing: XaiBillingSummary | null = quota.billing;
  if (!billing) return { ...EMPTY_MODEL, messageKey: 'xai_quota.empty_data' };

  if (billing.mode === 'paid-health') {
    return {
      ...EMPTY_MODEL,
      plan: { labelKey: 'xai_quota.plan_paid', tier: 'premium' },
      messageKey: 'xai_quota.paid_health',
    };
  }

  const windows: QuotaWindowCell[] = [];
  const notes: QuotaRowNote[] = [];

  const hasWeeklyData =
    billing.periodType === 'weekly' &&
    (billing.usagePercent !== null ||
      Boolean(billing.periodEnd) ||
      billing.productUsage.length > 0);
  if (hasWeeklyData) {
    windows.push({
      columnId: 'xai_quota.weekly_limit',
      labelKey: 'xai_quota.weekly_limit',
      remainingPercent: remainingFromUsed(billing.usagePercent),
      resetLabel: null,
      resetAtMs: billing.resetAtMs ?? null,
      periodHours: billing.periodHours ?? null,
    });
  }

  billing.productUsage.forEach((item) => {
    windows.push({
      columnId: `xai_quota.product_usage|${slug(item.product)}`,
      labelKey: 'xai_quota.product_usage',
      labelParams: { product: item.product },
      remainingPercent: remainingFromUsed(item.usagePercent),
      resetLabel: null,
      resetAtMs: null,
    });
  });

  if ((billing.onDemandCapCents ?? 0) > 0) {
    windows.push({
      columnId: 'xai_quota.pay_as_you_go_label',
      labelKey: 'xai_quota.pay_as_you_go_label',
      remainingPercent: remainingFromUsed(billing.onDemandUsedPercent),
      resetLabel: null,
      resetAtMs: null,
      amountLabel: formatRemainingAmount(billing.onDemandCapCents, billing.onDemandUsedCents),
    });
  } else {
    notes.push({
      labelKey: 'xai_quota.pay_as_you_go_label',
      valueKey: 'xai_quota.pay_as_you_go_disabled',
    });
  }

  const hasMonthlyData =
    billing.monthlyLimitCents !== null ||
    billing.usedCents !== null ||
    Boolean(billing.billingPeriodEnd);
  if (hasMonthlyData) {
    windows.push({
      columnId: 'xai_quota.monthly_credits',
      labelKey: 'xai_quota.monthly_credits',
      remainingPercent: remainingFromUsed(billing.usedPercent),
      // A billing cycle rolling over, not capacity returning — it is shown but
      // never ranked as a recovery.
      resetLabel: null,
      resetAtMs: parseIsoToMs(billing.billingPeriodEnd),
      amountLabel: formatRemainingAmount(billing.monthlyLimitCents, billing.includedUsedCents),
    });
  }

  return {
    ...EMPTY_MODEL,
    plan: xaiPlanBadge(billing.monthlyLimitCents),
    notes,
    windows,
    messageKey: windows.length === 0 ? 'xai_quota.empty_data' : null,
  };
};

const buildAntigravityModel = (quota: AntigravityQuotaState): QuotaCredentialRowModel => {
  const windows: QuotaWindowCell[] = [];
  (quota.groups ?? []).forEach((group) => {
    const groupLabelKey = antigravityLabelKey(group.label, 'group');
    group.buckets.forEach((bucket) => {
      const labelKey = antigravityLabelKey(bucket.label, 'bucket');
      windows.push({
        columnId: columnIdFrom(
          labelKey ?? undefined,
          undefined,
          `${group.id}-${bucket.label || bucket.id}`
        ),
        labelKey: labelKey ?? undefined,
        label: labelKey ? undefined : bucket.label,
        remainingPercent: clampPercent(bucket.remainingFraction * 100),
        resetLabel: null,
        resetAtMs: bucket.resetAtMs ?? null,
        // The group is what the bucket applies to; it rides along as the
        // column's tooltip rather than as a header row the table has no
        // place for.
        description: bucket.description ?? (groupLabelKey ? undefined : group.label),
        periodHours: bucket.periodHours ?? null,
      });
    });
  });

  return {
    ...EMPTY_MODEL,
    plan: antigravityPlanBadge(quota.subscription),
    windows,
    messageKey: windows.length === 0 ? 'antigravity_quota.empty_models' : null,
  };
};

/**
 * Flatten one credential's loaded quota. Returns null for anything that is not
 * a settled success — idle, loading and error rows render their own state and
 * have no cells to place.
 */
export function buildQuotaRowModel(
  family: QuotaProviderFamily,
  quota: unknown
): QuotaCredentialRowModel | null {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return null;

  switch (family) {
    case 'claude':
      return buildClaudeModel(quota as ClaudeQuotaState);
    case 'codex':
      return buildCodexModel(quota as CodexQuotaState);
    case 'devin':
      return buildDevinModel(quota as DevinQuotaState);
    case 'kimi':
      return buildKimiModel(quota as KimiQuotaState);
    case 'meta':
      return buildMetaModel(quota as MetaQuotaState);
    case 'xai':
      return buildXaiModel(quota as XaiQuotaState);
    case 'antigravity':
      return buildAntigravityModel(quota as AntigravityQuotaState);
    default:
      return null;
  }
}
