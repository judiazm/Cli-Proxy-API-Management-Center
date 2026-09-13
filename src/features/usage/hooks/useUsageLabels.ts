/**
 * One place that decides what a group key is called.
 *
 * The table, the matrix, the timeline legend and the CSV all render the same
 * keys, and they have to agree: a legend that says "mac" over a column the
 * table calls "key abc123" is worse than either name on its own. So the naming
 * lives here and every view reads it.
 *
 * `label` is for the screen and carries a muted second line where there is one.
 * `plainLabel` is the same name flattened for sorting and for CSV, where a
 * two-line value has nowhere to go.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageGroupColumn, UsageTimeBucket } from '@/services/api';
import { formatBucketLabel } from '../logic/formatUsage';
import { resolveAccountName, resolveDeviceName, resolveModelName } from '../logic/naming';
import type { AccountIndex, DeviceIndex } from '../logic/naming';

export interface UsageKeyLabel {
  primary: string;
  /** A fingerprint, a real model id behind an alias, or the empty string. */
  secondary: string;
  /** Render the secondary line in the monospace face. */
  monoSecondary: boolean;
}

export interface UsageLabeller {
  label: (dimension: UsageGroupColumn, key: string, bucket?: UsageTimeBucket) => UsageKeyLabel;
  plainLabel: (dimension: UsageGroupColumn, key: string, bucket?: UsageTimeBucket) => string;
}

/** Session ids are opaque and long; enough of one to tell two apart. */
const SESSION_ID_VISIBLE = 12;

export function useUsageLabels(devices: DeviceIndex, accounts: AccountIndex): UsageLabeller {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const label = useCallback(
    (dimension: UsageGroupColumn, key: string, bucket?: UsageTimeBucket): UsageKeyLabel => {
      const plain = (primary: string): UsageKeyLabel => ({
        primary,
        secondary: '',
        monoSecondary: false,
      });

      if (dimension === 'api_key') {
        const name = resolveDeviceName(key, devices);
        if (name.kind === 'label') {
          return { primary: name.label, secondary: name.fingerprint, monoSecondary: true };
        }
        if (name.kind === 'unknown') {
          return {
            primary: t('usage.device_unknown', { fingerprint: name.fingerprint }),
            secondary: name.fingerprint,
            monoSecondary: true,
          };
        }
        return {
          primary: t('usage.device_fallback', { fingerprint: name.fingerprint }),
          secondary: '',
          monoSecondary: true,
        };
      }

      if (dimension === 'auth_id') {
        const name = resolveAccountName(key, accounts);
        if (name.kind === 'email') {
          return { primary: name.email, secondary: name.file, monoSecondary: true };
        }
        if (name.kind === 'file') return plain(name.file);
        return name.authId ? plain(name.authId) : plain(t('usage.value_none'));
      }

      if (dimension === 'model' || dimension === 'alias') {
        if (!key) return plain(t('usage.value_none'));
        const name = resolveModelName(key);
        return { primary: name.primary, secondary: name.secondary, monoSecondary: true };
      }

      if (dimension === 'failed') {
        const isFailure = key === 'true' || key === '1';
        return plain(t(isFailure ? 'usage.status_failed' : 'usage.status_ok'));
      }

      if (dimension === 'stream') {
        const isStream = key === 'true' || key === '1';
        return plain(t(isStream ? 'usage.stream_on' : 'usage.stream_off'));
      }

      if (dimension === 'session_id') {
        if (!key) return plain(t('usage.value_none'));
        const short =
          key.length > SESSION_ID_VISIBLE ? `${key.slice(0, SESSION_ID_VISIBLE)}…` : key;
        return { primary: short, secondary: '', monoSecondary: true };
      }

      if (
        dimension === 'hour' ||
        dimension === 'day' ||
        dimension === 'week' ||
        dimension === 'month'
      ) {
        return plain(formatBucketLabel(key, bucket ?? dimension, locale));
      }

      return key ? plain(key) : plain(t('usage.value_none'));
    },
    [devices, accounts, t, locale]
  );

  const plainLabel = useCallback(
    (dimension: UsageGroupColumn, key: string, bucket?: UsageTimeBucket): string => {
      const resolved = label(dimension, key, bucket);
      return resolved.secondary && resolved.secondary !== resolved.primary
        ? `${resolved.primary} (${resolved.secondary})`
        : resolved.primary;
    },
    [label]
  );

  return useMemo(() => ({ label, plainLabel }), [label, plainLabel]);
}
