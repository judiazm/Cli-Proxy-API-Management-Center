/**
 * Turning stored identifiers into names a person recognises.
 *
 * The store keeps what the proxy had: a full client API key, an `auth_id`, a
 * model id. None of those is what the owner of the gateway calls the thing. The
 * panel already holds both side tables needed to translate, so it translates
 * here rather than asking the backend for a join it has no reason to do.
 *
 * One hard rule runs through all of it: a full client key never reaches the
 * screen. The page exists to be looked at, often with someone else in the room,
 * and a key is a credential. What is shown instead is the label the config gave
 * it, with the last six characters as a fingerprint so two unlabelled keys stay
 * distinguishable.
 *
 * These functions return a shape rather than a string so the caller does the
 * translating; nothing here embeds user-visible English.
 */

import type { ApiKeyEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';

/** How many trailing characters identify a key without revealing it. */
export const KEY_FINGERPRINT_LENGTH = 6;

export const keyFingerprint = (apiKey: string): string => {
  const trimmed = apiKey.trim();
  if (!trimmed) return '';
  return trimmed.length <= KEY_FINGERPRINT_LENGTH
    ? trimmed
    : trimmed.slice(-KEY_FINGERPRINT_LENGTH);
};

export type UsageDeviceName =
  /** The config named this key with `label`. */
  | { kind: 'label'; label: string; fingerprint: string }
  /**
   * No label. The caller renders the fingerprint as the name.
   *
   * `allowed-models` is deliberately not used as a fallback name: a list of
   * globs describes what a key may reach, not what it is, and two Codex clients
   * with the same allowlist would come out with the same name.
   */
  | { kind: 'fingerprint'; fingerprint: string }
  /** The store has a key the config no longer lists (revoked, or rotated). */
  | { kind: 'unknown'; fingerprint: string };

export type DeviceIndex = ReadonlyMap<string, ApiKeyEntry>;

export const buildDeviceIndex = (entries: readonly ApiKeyEntry[]): DeviceIndex => {
  const index = new Map<string, ApiKeyEntry>();
  entries.forEach((entry) => {
    if (entry.key) index.set(entry.key, entry);
  });
  return index;
};

/**
 * Entries whose key ends with the given fingerprint. A full key resolves to
 * itself. Used so the address bar and filter chips can carry a fingerprint
 * instead of the secret while the request to the store still uses the key.
 */
export const expandDeviceFingerprint = (value: string, index: DeviceIndex): string[] => {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (index.has(trimmed)) return [trimmed];
  if (trimmed.length !== KEY_FINGERPRINT_LENGTH) return [trimmed];
  const matches: string[] = [];
  index.forEach((_entry, key) => {
    if (key.endsWith(trimmed)) matches.push(key);
  });
  return matches.length > 0 ? matches : [trimmed];
};

export const expandDeviceFilterValues = (
  values: readonly string[] | undefined,
  index: DeviceIndex
): string[] | undefined => {
  if (!values || values.length === 0) return values ? [...values] : values;
  const out: string[] = [];
  values.forEach((value) => {
    expandDeviceFingerprint(value, index).forEach((key) => {
      if (!out.includes(key)) out.push(key);
    });
  });
  return out;
};

export const resolveDeviceName = (apiKey: string, index: DeviceIndex): UsageDeviceName => {
  const fingerprint = keyFingerprint(apiKey);
  let entry = index.get(apiKey);
  if (!entry && apiKey.trim().length === KEY_FINGERPRINT_LENGTH) {
    const candidates = expandDeviceFingerprint(apiKey, index);
    if (candidates.length === 1) entry = index.get(candidates[0]);
  }
  if (!entry) return { kind: 'unknown', fingerprint };
  if (entry.label) return { kind: 'label', label: entry.label, fingerprint };
  return { kind: 'fingerprint', fingerprint };
};

export type UsageAccountName =
  /** The auth file carries an address, which is the name people actually use. */
  | { kind: 'email'; email: string; file: string }
  /** Matched a file but it has no address (an API-key credential, say). */
  | { kind: 'file'; file: string }
  /** Nothing matched; the raw `auth_id` is shown rather than nothing. */
  | { kind: 'raw'; authId: string };

export type AccountIndex = ReadonlyMap<string, AuthFileItem>;

const readIdField = (file: AuthFileItem, field: string): string => {
  const value = file[field];
  return typeof value === 'string' ? value.trim() : '';
};

const stripJsonSuffix = (name: string): string =>
  name.toLowerCase().endsWith('.json') ? name.slice(0, -'.json'.length) : name;

/** Last path segment, for a credential the store names by a relative path. */
const basename = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut === -1 ? normalized : normalized.slice(cut + 1);
};

/**
 * Every spelling of a credential that `auth_id` may arrive as.
 *
 * PATCHES.md settles what it holds: for a file-based OAuth credential it is the
 * auth file's path relative to the auth dir, extension included, lower-cased on
 * Windows, and a relative path with separators when the file sits in a
 * subdirectory. A credential that never came from a file carries a UUID
 * instead, which matches nothing here and falls through to the raw value.
 *
 * So the index is keyed case-insensitively, and on the basename as well as the
 * full name, because the auth-file list and the usage row can disagree about
 * how much of the path they carry.
 */
const accountAliases = (file: AuthFileItem): string[] => {
  const aliases = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    aliases.add(trimmed.toLowerCase());
  };

  add(file.name);
  add(stripJsonSuffix(file.name));
  add(basename(file.name));
  add(stripJsonSuffix(basename(file.name)));
  add(readIdField(file, 'id'));
  add(readIdField(file, 'auth_id'));
  if (file.authIndex !== null && file.authIndex !== undefined) add(String(file.authIndex));
  if (file.email) add(file.email);

  return Array.from(aliases);
};

export const buildAccountIndex = (files: readonly AuthFileItem[]): AccountIndex => {
  const index = new Map<string, AuthFileItem>();
  files.forEach((file) => {
    accountAliases(file).forEach((alias) => {
      // First writer wins: a later credential must not steal an identifier an
      // earlier one owns more specifically (its own file name).
      if (!index.has(alias)) index.set(alias, file);
    });
  });
  return index;
};

export const resolveAccountName = (authId: string, index: AccountIndex): UsageAccountName => {
  const trimmed = authId.trim();
  if (!trimmed) return { kind: 'raw', authId: '' };

  const normalized = trimmed.toLowerCase();
  const file =
    index.get(normalized) ??
    index.get(stripJsonSuffix(normalized)) ??
    index.get(basename(normalized));

  if (!file) return { kind: 'raw', authId: trimmed };
  if (file.email) return { kind: 'email', email: file.email, file: file.name };
  return { kind: 'file', file: file.name };
};

export interface UsageModelName {
  /** What to show large. */
  primary: string;
  /** The real model id when an alias is standing in for it, else empty. */
  secondary: string;
}

/**
 * An alias is what the client asked for; the model is what answered.
 *
 * When they differ both are worth seeing: the alias is the name in the client's
 * config, the model is the thing that actually consumed quota.
 */
export const resolveModelName = (model: string, alias?: string): UsageModelName => {
  const modelId = model.trim();
  const aliasId = (alias ?? '').trim();
  if (aliasId && aliasId !== modelId) return { primary: aliasId, secondary: modelId };
  return { primary: modelId, secondary: '' };
};
