import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import {
  AnthropicResetGrantError,
  anthropicResetGrantBlocker,
  claimClaudeResetGrantDetailed,
  readClaudeOrganization,
  readClaudeResetGrants,
  type AnthropicResetGrantStatus,
  type AnthropicResetSettledCode,
} from '@/services/api/claudeResetGrants';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;
/** A grant status this recent gates the claim without another read; Anthropic rechecks it. */
export const STATUS_FRESH_MS = 2 * 60 * 1000;
const ORGANIZATION_CACHE_MS = 10 * 60 * 1000;
export type ResetClaimAnswer =
  | AnthropicResetSettledCode
  | { code: AnthropicResetSettledCode; reason: string | null };
type Operation = {
  grantId: string;
  organization: string;
  requestId: string;
  createdAt: number;
  code?: AnthropicResetSettledCode;
};
const defaultDependencies = {
  revision: () => apiClient.getConnectionRevision(),
  readStatus: readClaudeResetGrants,
  readOrganization: readClaudeOrganization,
  claim: claimClaudeResetGrantDetailed as (
    authIndex: string,
    organization: string,
    grantId: string,
    requestId: string
  ) => Promise<ResetClaimAnswer>,
  // A spent reset only helps once the gateway stops routing around the account.
  clearCooldown: async (authIndex: string) => {
    const result = await authFilesApi.resetCooldown(authIndex);
    return result.status === 'ok' && result.auth_index === authIndex;
  },
  now: () => Date.now(),
  requestId: () => crypto.randomUUID() as string,
};

/** Tab-memory journal: survives dialog/card unmounts, never crosses connections.
 * No automatic retry. Expired ambiguous operations stay blocked until session end.
 * This is not a cross-tab or durable backend spending ledger.
 */
export function createResetGrantOperations(deps = defaultDependencies) {
  let revision = deps.revision();
  const operations = new Map<string, Operation>();
  const organizations = new Map<string, { uuid: string; at: number }>();
  const busy = new Set<string>();
  const syncSession = () => {
    if (revision !== deps.revision()) {
      revision = deps.revision();
      operations.clear();
      organizations.clear();
      busy.clear();
    }
    return revision;
  };
  // Anthropic throttles these OAuth reads per account; say so instead of a generic block.
  const throttleAware = <T>(read: () => Promise<T>) =>
    read().then(undefined, (error: unknown) =>
      Promise.reject(
        error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
          ? new Error('rate_limited')
          : error
      )
    );
  return {
    inspect(key: string) {
      syncSession();
      return operations.get(key);
    },
    async run(
      key: string,
      authIndex: string,
      grantId: string,
      known?: { status: AnthropicResetGrantStatus; readAt: number }
    ) {
      const session = syncSession();
      const assertSession = () => {
        if (deps.revision() !== session) throw new Error('session');
      };
      if (busy.has(key)) throw new Error('busy');
      busy.add(key);
      try {
        let operation = operations.get(key);
        if (operation?.code) operation = undefined;
        if (
          operation &&
          (operation.grantId !== grantId || deps.now() - operation.createdAt >= RETRY_WINDOW_MS)
        )
          throw new Error('expired');
        const wasRetry = Boolean(operation);
        // A fresh claim reuses a recent profile read: each extra Anthropic call before the claim
        // raised the odds of the 429s that refused three dashboard claims on 2026-10-07. A retry
        // always re-reads it, to prove the ambiguous claim still targets the same account.
        const cached = organizations.get(authIndex);
        const organization =
          !operation && cached && deps.now() - cached.at < ORGANIZATION_CACHE_MS
            ? cached.uuid
            : await throttleAware(() => deps.readOrganization(authIndex));
        assertSession();
        organizations.set(authIndex, { uuid: organization, at: deps.now() });
        if (operation && operation.organization !== organization) throw new Error('identity');
        if (!operation) {
          const age = known ? deps.now() - known.readAt : Infinity;
          const status =
            known && age >= 0 && age <= STATUS_FRESH_MS
              ? known.status
              : await throttleAware(() => deps.readStatus(authIndex));
          assertSession();
          const grant = status.grants.find((item) => item.id === grantId);
          const now = deps.now();
          if (
            anthropicResetGrantBlocker(status, grantId) ||
            !grant ||
            (grant.startsAt && Date.parse(grant.startsAt) > now) ||
            (grant.endsAt && Date.parse(grant.endsAt) <= now) ||
            (status.cooldownUntil && Date.parse(status.cooldownUntil) > now)
          ) {
            throw new Error('blocked');
          }
          operation = { grantId, organization, requestId: deps.requestId(), createdAt: now };
          operations.set(key, operation);
        }
        // Re-check immediately before dispatch; never send against a replacement connection.
        assertSession();
        if (wasRetry && deps.now() - operation.createdAt >= RETRY_WINDOW_MS) {
          throw new Error('expired');
        }
        const answer = await deps.claim(authIndex, organization, grantId, operation.requestId);
        const code = typeof answer === 'string' ? answer : answer.code;
        const reason = typeof answer === 'string' ? null : answer.reason;
        assertSession();
        // A refusal on a retry cannot prove that the earlier ambiguous POST did not spend.
        if (!wasRetry || code === 'reset' || code === 'already_used') operation.code = code;
        let cooldownCleared = false;
        if (code === 'reset' || code === 'already_used') {
          try {
            // Never clear a replacement connection's cooldown after awaiting the claim.
            assertSession();
            cooldownCleared = await deps.clearCooldown(authIndex);
          } catch {
            cooldownCleared = false;
          }
        }
        return { code, reason, unresolved: !operation.code, cooldownCleared };
      } finally {
        if (deps.revision() === session) busy.delete(key);
      }
    },
  };
}

export const resetGrantOperations = createResetGrantOperations();
