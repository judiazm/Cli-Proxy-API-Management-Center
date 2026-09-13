/**
 * The two side tables that turn stored identifiers into names.
 *
 * Both are small, both are already cached-shaped list endpoints, and neither is
 * required for the page to render: a usage table with raw fingerprints and raw
 * `auth_id`s is degraded, not broken. So a failure here is swallowed rather than
 * surfaced, and the resolvers fall back on their own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiKeysApi, authFilesApi, type ApiKeyEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  buildAccountIndex,
  buildDeviceIndex,
  type AccountIndex,
  type DeviceIndex,
} from '../logic/naming';

export interface UsageNames {
  devices: DeviceIndex;
  accounts: AccountIndex;
  /** Config order, for the filter menu. */
  deviceEntries: ApiKeyEntry[];
  authFiles: AuthFileItem[];
  reload: () => Promise<void>;
}

export function useUsageNames(): UsageNames {
  const [deviceEntries, setDeviceEntries] = useState<ApiKeyEntry[]>([]);
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [devices, setDevices] = useState<DeviceIndex>(() => new Map());
  const [accounts, setAccounts] = useState<AccountIndex>(() => new Map());

  // A reconnect must not let the previous gateway's answer land on the new one.
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = (requestRef.current += 1);

    const [entries, files] = await Promise.all([
      apiKeysApi.listEntries().catch(() => [] as ApiKeyEntry[]),
      authFilesApi
        .list()
        .then((data) => data?.files ?? [])
        .catch(() => [] as AuthFileItem[]),
    ]);

    if (requestRef.current !== requestId) return;

    setDeviceEntries(entries);
    setAuthFiles(files);
    setDevices(buildDeviceIndex(entries));
    setAccounts(buildAccountIndex(files));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { devices, accounts, deviceEntries, authFiles, reload };
}
