/**
 * The three reads a pool is derived from.
 *
 * Two of them are cheap list calls. The third is not: a credential's `prefix`
 * lives inside the auth file and the list endpoint does not surface it, so the
 * prefix is read the same way the auth-file editor reads it — by fetching the
 * file — and that is one request per credential. Hence the small worker pool,
 * the `prefix`-on-the-entry short circuit for the day the backend does expose
 * it, and the decision to treat a failed fetch as "no prefix" rather than
 * failing the page: an unreadable credential is still a member of its family's
 * unprefixed pool, which is where the gateway would place it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiKeysApi, authFilesApi } from '@/services/api';
import { readAuthFilePrefix } from '@/features/authFiles/constants';
import type { AuthFileItem } from '@/types';
import {
  toPoolClientKey,
  toPoolCredential,
  type PoolClientKey,
  type PoolCredential,
} from '../logic';

/** Enough to keep a 20-credential vault snappy without flooding the gateway. */
const PREFIX_FETCH_CONCURRENCY = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The prefix already on the list entry, when the backend sends one. */
const entryPrefix = (file: AuthFileItem): string | null => {
  const value = file.prefix;
  return typeof value === 'string' ? value : null;
};

const fetchPrefix = async (file: AuthFileItem): Promise<string> => {
  const known = entryPrefix(file);
  if (known !== null) return known;

  try {
    const text = await authFilesApi.downloadText(file.name);
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? readAuthFilePrefix(parsed) : '';
  } catch {
    return '';
  }
};

/** Resolve prefixes a few at a time, keeping the result aligned with `files`. */
const fetchPrefixes = async (files: readonly AuthFileItem[]): Promise<string[]> => {
  const prefixes = new Array<string>(files.length).fill('');
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      prefixes[index] = await fetchPrefix(files[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PREFIX_FETCH_CONCURRENCY, files.length) }, () => worker())
  );
  return prefixes;
};

export interface PoolsData {
  credentials: PoolCredential[];
  clientKeys: PoolClientKey[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

export function usePoolsData(): PoolsData {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState<PoolCredential[]>([]);
  const [clientKeys, setClientKeys] = useState<PoolClientKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // A reconnect or a second refresh must not let the earlier, slower answer
  // land on top of the newer one.
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = (requestRef.current += 1);
    setLoading(true);
    setError('');

    // A failed client-key read is reported rather than swallowed: without the
    // keys every pool would render as "no client key reaches this pool", which
    // reads as a misconfiguration instead of as a missing answer.
    let clientKeysError = '';

    try {
      const [files, entries] = await Promise.all([
        authFilesApi.list().then((data) => data?.files ?? []),
        apiKeysApi.listEntries().catch((err: unknown) => {
          clientKeysError = err instanceof Error ? err.message : String(err);
          return [];
        }),
      ]);
      const prefixes = await fetchPrefixes(files);
      if (requestRef.current !== requestId) return;

      setCredentials(files.map((file, index) => toPoolCredential(file, prefixes[index] ?? '')));
      setClientKeys(
        entries.map((entry) => toPoolClientKey(entry.key, entry.label, entry.allowedModels))
      );
      if (clientKeysError) {
        setError(t('pools.client_keys_error', { message: clientKeysError }));
      }
    } catch (err: unknown) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : t('notification.refresh_failed'));
      setCredentials([]);
      setClientKeys([]);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { credentials, clientKeys, loading, error, reload };
}
