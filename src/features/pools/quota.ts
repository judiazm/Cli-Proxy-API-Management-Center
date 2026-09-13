/**
 * A pool's remaining capacity, borrowed from the quota page's cache.
 *
 * The quota store is filled on demand — a credential is only probed when
 * someone asks for it on the quota page — so this reads whatever is already
 * there and reports nothing when nothing has been loaded. Probing from here
 * would turn opening a read-only overview into a burst of upstream calls.
 *
 * The aggregation itself is the quota page's: same binding-window choice, same
 * "409% of a possible 500%" denominator, so the two pages cannot disagree about
 * how much is left.
 */

import {
  buildQuotaFamilySummary,
  buildQuotaRowModel,
  type QuotaFamilyMember,
  type QuotaProviderFamily,
} from '@/utils/quota';
import { QUOTA_PROVIDER_TYPES } from '@/features/authFiles/constants';
import type { PoolCredential } from './logic';

export interface PoolQuotaAggregate {
  /** Sum of remaining percentages across the members that reported one. */
  totalRemainingPercent: number;
  /** 100 per member, reported or not. */
  maxRemainingPercent: number;
  readingCount: number;
}

export const isQuotaFamily = (family: string): family is QuotaProviderFamily =>
  QUOTA_PROVIDER_TYPES.has(family as QuotaProviderFamily);

/** Quota states keyed by credential file name, as the store holds them. */
export type QuotaLookup = (family: string, credentialName: string) => unknown;

export function buildPoolQuotaAggregate(
  family: string,
  members: readonly PoolCredential[],
  quotaFor: QuotaLookup
): PoolQuotaAggregate | null {
  if (!isQuotaFamily(family) || members.length === 0) return null;

  const familyMembers: QuotaFamilyMember[] = members.map((member) => ({
    key: member.name,
    model: buildQuotaRowModel(family, quotaFor(family, member.name)),
  }));

  // nowMs only drives the soonest-reset field, which this view does not show.
  const summary = buildQuotaFamilySummary(family, familyMembers, 0);
  const binding = summary.binding;
  if (!binding || binding.readingCount === 0 || binding.totalRemainingPercent === null) return null;

  return {
    totalRemainingPercent: binding.totalRemainingPercent,
    maxRemainingPercent: binding.maxRemainingPercent,
    readingCount: binding.readingCount,
  };
}
