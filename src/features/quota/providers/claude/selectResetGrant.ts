import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** Prefer the upstream recommendation; otherwise use stable ID ordering. */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return undefined;
  const usable = status.grants.filter(
    (grant) =>
      !anthropicResetGrantBlocker(status, grant.id) &&
      (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
      (!grant.endsAt || Date.parse(grant.endsAt) > now)
  );
  return (
    usable.find((grant) => grant.id === status.nextGrantId) ??
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  );
}

/**
 * Why no grant can be spent, as a `claude_reset.*` message key, or null when one can.
 * Read-only: explains the button state; spending still rechecks everything upstream.
 */
export function describeResetGrantState(status: AnthropicResetGrantStatus, now: number) {
  if (selectResetGrant(status, now)) return null;
  if (!status.eligible) return 'state_ineligible';
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return 'cooldown';
  const live = status.grants.filter((grant) => !grant.endsAt || Date.parse(grant.endsAt) > now);
  if (live.length === 0) return 'empty';
  if (live.every((grant) => grant.resetsLeft <= 0)) return 'state_spent';
  const open = live.filter((grant) => grant.resetsLeft > 0 && !grant.paused && grant.usableNow);
  if (open.length > 0 && open.every((grant) => grant.useRequiresLimit && !status.atLimit))
    return 'state_waiting_limit';
  return 'unavailable';
}
