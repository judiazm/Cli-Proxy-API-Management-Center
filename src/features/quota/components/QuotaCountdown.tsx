/**
 * `in 1 day · 09/13, 13:00` — the countdown first, the instant second.
 *
 * The card layout led with the absolute time because a card is read one row at
 * a time. A table is scanned down a column, and what the eye is looking for is
 * "which of these comes back soonest", so the relative half goes first. The
 * absolute instant stays because that is what you put in a calendar.
 *
 * Distinct from `QuotaResetLabel`, which keeps the card ordering for the
 * credential-library host; merging them would mean one component with an order
 * flag serving two layouts that disagree on purpose.
 */

import { buildResetDisplay } from '@/utils/quota';

export const QUOTA_COUNTDOWN_CLASS_KEYS = [
  'countdown',
  'countdownRelative',
  'countdownAbsolute',
  'countdownSeparator',
  'countdownEmpty',
] as const;

export type QuotaCountdownClasses = Record<(typeof QUOTA_COUNTDOWN_CLASS_KEYS)[number], string>;

export interface QuotaCountdownProps {
  /** Absolute label baked at fetch time, when the provider supplied one. */
  absoluteLabel?: string | null;
  atMs?: number | null;
  nowMs: number;
  locale?: string;
  classes: QuotaCountdownClasses;
  /** Rendered when there is no instant at all — "No reset pending". */
  emptyLabel: string;
  /** Free-text hint from providers that report no timestamp (Kimi). */
  hint?: string;
}

export function QuotaCountdown(props: QuotaCountdownProps) {
  const { absoluteLabel, atMs, nowMs, locale, classes, emptyLabel, hint } = props;
  const display = buildResetDisplay(absoluteLabel, atMs, nowMs, locale);

  if (!display) {
    return <span className={classes.countdownEmpty}>{hint || emptyLabel}</span>;
  }

  // The separator travels with the instant rather than the countdown: in a
  // narrow table cell the two halves wrap, and a dangling "·" at the end of a
  // line reads as a typo where a leading one reads as continuation.
  return (
    <span className={classes.countdown}>
      {display.relative && <span className={classes.countdownRelative}>{display.relative}</span>}
      <span className={classes.countdownAbsolute}>
        {display.relative && (
          <span className={classes.countdownSeparator} aria-hidden="true">
            ·
          </span>
        )}
        {display.absolute}
      </span>
    </span>
  );
}
