import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import {
  resetGrantOperations,
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { describeResetGrantState } from './selectResetGrant';
import { canChooseResetGrant } from './resetGrantChoice';
import { readResetGrantsForCard, scheduleResetGrantRead } from './resetGrantReads';

/** Row-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow(enabled);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [statusReadAt, setStatusReadAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<{ key: string; selected: string | null } | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    const cancelRead = scheduleResetGrantRead(() => {
      void readResetGrantsForCard(authIndex).then(
        (result) => {
          if (current()) {
            setStatus(result);
            setStatusReadAt(Date.now());
            setMessage('');
          }
        },
        (error: unknown) => {
          if (current()) {
            setMessage(
              error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                ? 'read_throttled'
                : 'read_error'
            );
          }
        }
      );
    }, current);
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const grants = [...(status?.grants ?? [])];
  if (pending && !grants.some((grant) => grant.id === pending.grantId)) grants.push(pending.grant);
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const blocked = !enabled || disabled || !sessionActive || !authIndex || busy || expired;
  const canRedeemGrant = (grantId: unknown) =>
    !blocked && canChooseResetGrant(status, pending?.grantId, grantId, now);
  const open = Boolean(dialog && dialog.key === key && sessionActive && enabled);
  const selected = open ? (dialog?.selected ?? null) : null;
  const confirm = async () => {
    if (!open || !selected || !canRedeemGrant(selected) || lock.current || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    if (!current() || useAuthStore.getState().connectionStatus !== 'connected') return;
    lock.current = true;
    setBusy(true);
    try {
      const answer = await resetGrantOperations.run(
        key,
        authIndex,
        selected,
        status ? { status, readAt: statusReadAt } : undefined
      );
      if (!current()) return;
      const spent =
        !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used');
      if (spent) setDialog(null);
      // Anthropic's bounded reason explains a refusal such as `not_next_grant`.
      const reason =
        !spent && !answer.unresolved && answer.reason && answer.reason !== answer.code
          ? ` (${answer.reason})`
          : '';
      showNotification(
        t(
          spent && !answer.cooldownCleared
            ? 'claude_reset.cooldown_failed'
            : `claude_reset.${answer.unresolved ? 'unknown' : answer.code}`
        ) + reason,
        spent && answer.cooldownCleared ? 'success' : 'error'
      );
    } catch (error: unknown) {
      if (!current()) return;
      const unresolved = resetGrantOperations.inspect(key);
      showNotification(
        t(
          unresolved && !unresolved.code
            ? 'claude_reset.unknown'
            : error instanceof ResetGrantPreflightError &&
                (error.stage === 'organization' || error.stage === 'status') &&
                error.reason === 'rate_limited'
              ? 'claude_reset.read_throttled'
              : resetGrantFailureMessageKey(error),
          { code: error instanceof ResetGrantPreflightError ? error.reason : '' }
        ),
        'error'
      );
    } finally {
      lock.current = false;
      // A concurrent page-wide refresh can invalidate this read generation.
      // Release the local lock regardless, but never refresh a replacement account.
      setBusy(false);
      setReload((value) => value + 1);
      if (current()) onRefresh();
    }
  };
  // Soonest expiry among grants that still hold a reset.
  const expiresAtMs =
    status?.grants
      .filter((grant) => grant.resetsLeft > 0 && grant.endsAt)
      .map((grant) => Date.parse(grant.endsAt as string))
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b)[0] ?? null;
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    expiresAtMs,
    grants,
    loading: !status && !message && !pending,
    open,
    selected,
    openDialog: () => {
      if (!blocked && !lock.current) setDialog({ key, selected: null });
    },
    closeDialog: () => {
      if (!lock.current) setDialog(null);
    },
    selectGrant: (grantId: string) => {
      if (open && canRedeemGrant(grantId) && !lock.current) setDialog({ key, selected: grantId });
    },
    blocked,
    buttonLabel: pending ? 'retry' : 'use',
    pendingGrantId: pending?.grantId,
    canRedeemGrant,
    busy,
    confirm,
    message: pending
      ? expired
        ? 'expired'
        : 'unknown'
      : message || (status ? (describeResetGrantState(status, now) ?? '') : ''),
  };
}
