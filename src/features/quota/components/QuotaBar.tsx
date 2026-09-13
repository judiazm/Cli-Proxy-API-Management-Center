/**
 * The remaining-capacity bar, shared by the summary strip and the credential
 * rows so one reading of "how much is left" is painted one way everywhere.
 *
 * The colour band comes from `quotaRemainingTone`; the class names come from
 * the host stylesheet, because the strip's sparkbars and the table's row bars
 * are the same semantics at two very different sizes.
 */

import type { CSSProperties } from 'react';
import { quotaRemainingTone } from '@/utils/quota';

export const QUOTA_BAR_CLASS_KEYS = [
  'bar',
  'barFill',
  'toneHigh',
  'toneMedium',
  'toneLow',
  'toneUnknown',
] as const;

export type QuotaBarClasses = Record<(typeof QUOTA_BAR_CLASS_KEYS)[number], string>;

export interface QuotaBarProps {
  /** Remaining capacity 0–100; null renders an empty track. */
  percent: number | null;
  classes: QuotaBarClasses;
  /** Staggers the fill animation down a column. */
  index?: number;
  title?: string;
}

/** Tone → host class; kept local so this file exports only the component. */
function quotaToneClass(percent: number | null, classes: QuotaBarClasses): string {
  switch (quotaRemainingTone(percent)) {
    case 'high':
      return classes.toneHigh;
    case 'medium':
      return classes.toneMedium;
    case 'low':
      return classes.toneLow;
    default:
      return classes.toneUnknown;
  }
}

export function QuotaBar({ percent, classes, index, title }: QuotaBarProps) {
  const width = percent === null ? 0 : Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
  const style: CSSProperties & { '--meter-index'?: number } = { width: `${width}%` };
  if (index !== undefined) style['--meter-index'] = index;

  return (
    <span className={classes.bar} title={title}>
      <span className={`${classes.barFill} ${quotaToneClass(percent, classes)}`} style={style} />
    </span>
  );
}
