/** Client access keys are a direct config list, not upstream provider groups. */
import { apiClient } from './client';
import { getConfigValue, guardConfigConnection } from './configValue';

const PATH = '/config/access/api-keys';

const assertIndex = (keys: unknown[], index: number): void => {
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    throw new RangeError('API key index out of range');
  }
};

/**
 * One `api-keys` entry as the fork's proxy accepts it.
 *
 * The list is heterogeneous by design: a plain string is a key that sees every
 * model, while an object carries `allowed-models` wildcards that restrict it
 * (`internal/config/api_key_entry.go`). `list()` below flattens both to the key
 * string; `listEntries()` keeps the restriction, which is what makes it
 * possible to say which client keys can reach which credentials.
 */
export interface ApiKeyEntry {
  key: string;
  /**
   * A human label for the key, if the config carries one. The upstream entry
   * has no such field today, so this is read defensively across the names a
   * config is likely to use rather than assumed present.
   */
  label: string;
  /** Raw `allowed-models` patterns, in config order. Empty means unrestricted. */
  allowedModels: string[];
}

const LABEL_FIELDS = ['comment', 'label', 'name', 'note', 'description'];

const readEntryKey = (record: Record<string, unknown>): string => {
  const value = record['api-key'] ?? record.apiKey ?? record.key ?? record.Key;
  return typeof value === 'string' ? value.trim() : '';
};

const readEntryLabel = (record: Record<string, unknown>): string => {
  for (const field of LABEL_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const readAllowedModels = (record: Record<string, unknown>): string[] => {
  const value = record['allowed-models'] ?? record.allowedModels;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

export const normalizeApiKeyEntries = (payload: unknown): ApiKeyEntry[] => {
  if (!Array.isArray(payload)) return [];

  return payload.reduce<ApiKeyEntry[]>((entries, item) => {
    if (typeof item === 'string') {
      const key = item.trim();
      if (key) entries.push({ key, label: '', allowedModels: [] });
      return entries;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return entries;

    const record = item as Record<string, unknown>;
    const key = readEntryKey(record);
    if (!key) return entries;
    entries.push({
      key,
      label: readEntryLabel(record),
      allowedModels: readAllowedModels(record),
    });
    return entries;
  }, []);
};

export const apiKeysApi = {
  async list(): Promise<string[]> {
    const data = await getConfigValue<unknown>(PATH, []);
    return normalizeApiKeyEntries(data).map((entry) => entry.key);
  },

  async listEntries(): Promise<ApiKeyEntry[]> {
    const data = await getConfigValue<unknown>(PATH, []);
    return normalizeApiKeyEntries(data);

  },

  replace: (keys: unknown[]) => apiClient.put(PATH, keys),

  async update(index: number, value: string) {
    const assertConnection = guardConfigConnection();
    const raw = await getConfigValue<unknown>(PATH, []);
    assertConnection();
    const keys = Array.isArray(raw) ? [...raw] : [];
    assertIndex(keys, index);
    const entry = keys[index];
    keys[index] = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry, 'api-key': value }
      : value;
    return apiKeysApi.replace(keys);
  },

  async delete(index: number) {
    const assertConnection = guardConfigConnection();
    const raw = await getConfigValue<unknown>(PATH, []);
    assertConnection();
    const keys = Array.isArray(raw) ? [...raw] : [];
    assertIndex(keys, index);
    keys.splice(index, 1);
    return apiKeysApi.replace(keys);
  },
};
