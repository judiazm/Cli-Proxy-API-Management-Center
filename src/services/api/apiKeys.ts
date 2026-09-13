/**
 * API 密钥管理
 */

import { apiClient } from './client';

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
    const data = await apiClient.get<Record<string, unknown>>('/api-keys');
    const keys = data['api-keys'] ?? data.apiKeys;
    return normalizeApiKeyEntries(keys).map((entry) => entry.key);
  },

  async listEntries(): Promise<ApiKeyEntry[]> {
    const data = await apiClient.get<Record<string, unknown>>('/api-keys');
    return normalizeApiKeyEntries(data['api-keys'] ?? data.apiKeys);
  },

  replace: (keys: string[]) => apiClient.put('/api-keys', keys),

  update: (index: number, value: string) => apiClient.patch('/api-keys', { index, value }),

  delete: (index: number) => apiClient.delete(`/api-keys?index=${index}`),
};
