/**
 * Remaining share → bar colour.
 *
 * The quota list is scanned, not read: a column of bars should say which
 * accounts are nearly out before any number is parsed. Three bands is what a
 * glance can resolve — comfortable, watch it, nearly gone.
 *
 * Thresholds are on *remaining* capacity, not used, so higher is always
 * better and green always means "go".
 */

/** Above this much left, the account is comfortable. */
export const QUOTA_TONE_HIGH_THRESHOLD = 60;

/** Below this much left, the account is effectively spent. */
export const QUOTA_TONE_LOW_THRESHOLD = 25;

export type QuotaTone = 'high' | 'medium' | 'low' | 'unknown';

/**
 * `unknown` is deliberately its own band rather than folding into `medium`:
 * a credential that has not been loaded yet must not be painted as if it had
 * reported a middling number.
 */
export function quotaRemainingTone(percent: number | null | undefined): QuotaTone {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'unknown';
  if (percent > QUOTA_TONE_HIGH_THRESHOLD) return 'high';
  if (percent >= QUOTA_TONE_LOW_THRESHOLD) return 'medium';
  return 'low';
}

/** Clamp a percentage into the 0–100 the bars and figures assume. */
export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Used-percent payloads become the remaining share every row renders. */
export const remainingFromUsed = (used: number | null | undefined): number | null =>
  used === null || used === undefined || !Number.isFinite(used) ? null : clampPercent(100 - used);
