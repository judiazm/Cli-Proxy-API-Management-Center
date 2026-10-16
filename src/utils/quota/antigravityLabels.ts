/** Resolve Antigravity's English display names and structured windows to i18n keys. */

const GROUP_LABEL_KEYS = new Map<string, string>([
  ['gemini models', 'group_gemini_models'],
  ['claude and gpt models', 'group_claude_gpt_models'],
]);

const BUCKET_LABEL_KEYS = new Map<string, string>([
  ['weekly limit', 'weekly_limit'],
  ['daily limit', 'daily_limit'],
  ['5 hour limit', 'five_hour_limit'],
  ['5-hour limit', 'five_hour_limit'],
  ['five hour limit', 'five_hour_limit'],
  ['five-hour limit', 'five_hour_limit'],
  ['monthly limit', 'monthly_limit'],
]);

const BUCKET_WINDOW_KEYS = new Map<string, string>([
  ['5h', 'five_hour_limit'],
  ['five-hour', 'five_hour_limit'],
  ['five_hour', 'five_hour_limit'],
  ['daily', 'daily_limit'],
  ['day', 'daily_limit'],
  ['weekly', 'weekly_limit'],
  ['week', 'weekly_limit'],
  ['monthly', 'monthly_limit'],
  ['month', 'monthly_limit'],
]);

export const normalizeAntigravityText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/** Ignore upstream's "Remaining" suffix, such as "Weekly Limit Remaining". */
const stripRemainingSuffix = (value: string): string =>
  value.replace(/\s*(?:-|:)?\s*remaining$/, '').trim();

export function resolveAntigravityGroupLabelKey(label: string): string | null {
  return GROUP_LABEL_KEYS.get(normalizeAntigravityText(label)) ?? null;
}

export function resolveAntigravityBucketLabelKey(
  label: string,
  window: string | undefined
): string | null {
  const normalized = normalizeAntigravityText(label);
  const byLabel =
    BUCKET_LABEL_KEYS.get(normalized) ?? BUCKET_LABEL_KEYS.get(stripRemainingSuffix(normalized));
  if (byLabel) return byLabel;
  if (!window) return null;
  return BUCKET_WINDOW_KEYS.get(normalizeAntigravityText(window)) ?? null;
}
