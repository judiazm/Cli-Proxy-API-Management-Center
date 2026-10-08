import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  readClaudeResetGrants,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import { resetGrantOperations, RETRY_WINDOW_MS } from './resetGrantOperations';
import { describeResetGrantState, selectResetGrant } from './selectResetGrant';

/** Row-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void,
  displayName: string
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow(enabled);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    void readClaudeResetGrants(authIndex).then(
      (result) => {
        if (current()) {
          setStatus(result);
          setMessage('');
        }
      },
      (error: unknown) => {
        if (!current()) return;
        const throttled =
          error instanceof AnthropicResetGrantError && error.code === 'rate_limited';
        setMessage(throttled ? 'read_throttled' : 'read_error');
      }
    );
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const selected = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const blocked = disabled || !sessionActive || !authIndex || busy || expired || !selected;
  const confirm = () => {
    if (blocked || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    const grant = status?.grants.find((item) => item.id === selected);
    const used = grant?.percentUsed ?? {};
    const usage =
      !pending && (used.five_hour !== undefined || used.seven_day !== undefined)
        ? ' ' +
          t('claude_reset.confirm_usage', {
            fiveHour: used.five_hour ?? '--',
            sevenDay: used.seven_day ?? '--',
          })
        : '';
    showConfirmation({
      title: t('claude_reset.title'),
      message:
        t(pending ? 'claude_reset.retry_confirm' : 'claude_reset.confirm_text', {
          name: displayName,
        }) + usage,
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        lock.current = true;
        setBusy(true);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, selected);
          if (!current()) return;
          const spent =
            !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used');
          showNotification(
            t(
              spent && !answer.cooldownCleared
                ? 'claude_reset.cooldown_failed'
                : `claude_reset.${answer.unresolved ? 'unknown' : answer.code}`
            ),
            spent && answer.cooldownCleared ? 'success' : 'error'
          );
        } catch {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          showNotification(
            t(`claude_reset.${unresolved && !unresolved.code ? 'unknown' : 'blocked'}`),
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
      },
    });
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
    grants: status?.grants ?? [],
    busy,
    blocked,
    confirm,
    message: pending
      ? expired
        ? 'expired'
        : 'unknown'
      : message || (status ? (describeResetGrantState(status, now) ?? '') : ''),
    buttonLabel: pending ? 'retry' : 'use',
  };
}
