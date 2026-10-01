import { apiClient } from './client';
import { UsageStoreDisabledError, type UsageRangeParams } from './usageStore';

export interface QuotaObservation {
  id: number;
  provider: string;
  auth_id: string;
  auth_index: string;
  window_id: string;
  observed_at_ms: number;
  used_percent: number;
  reset_at_ms: number;
  period_hours: number;
  source: string;
}

export interface QuotaHistoryResponse {
  rows: QuotaObservation[];
  truncated: boolean;
}

export interface QuotaHistoryParams extends Pick<UsageRangeParams, 'from' | 'to'> {
  provider?: string;
  authId?: string;
  authIndex?: string;
  limit?: number;
}

export const buildQuotaHistoryQuery = (params: QuotaHistoryParams): URLSearchParams => {
  const search = new URLSearchParams();
  if (params.from !== undefined) search.set('from', String(params.from));
  if (params.to !== undefined) search.set('to', String(params.to));
  for (const [key, value] of [
    ['provider', params.provider],
    ['auth_id', params.authId],
    ['auth_index', params.authIndex],
  ]) {
    if (value?.trim()) search.set(key!, value.trim());
  }
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    search.set('limit', String(Math.min(10_000, Math.max(1, Math.trunc(params.limit)))));
  }
  return search;
};

/** Reject incomplete diagnostics instead of silently turning bad observations into zeroes. */
export const normalizeQuotaHistory = (raw: unknown): QuotaHistoryResponse => {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid quota history response');
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.rows) || typeof record.truncated !== 'boolean') {
    throw new Error('Invalid quota history response');
  }
  const rows = record.rows.map((rawRow): QuotaObservation => {
    if (!rawRow || typeof rawRow !== 'object') throw new Error('Invalid quota observation');
    const row = rawRow as Record<string, unknown>;
    for (const key of ['id', 'observed_at_ms', 'used_percent', 'reset_at_ms', 'period_hours']) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) {
        throw new Error('Invalid quota observation');
      }
    }
    for (const key of ['provider', 'auth_id', 'auth_index', 'window_id', 'source']) {
      if (typeof row[key] !== 'string') throw new Error('Invalid quota observation');
    }
    return {
      id: row.id as number,
      provider: row.provider as string,
      auth_id: row.auth_id as string,
      auth_index: row.auth_index as string,
      window_id: row.window_id as string,
      observed_at_ms: row.observed_at_ms as number,
      used_percent: row.used_percent as number,
      reset_at_ms: row.reset_at_ms as number,
      period_hours: row.period_hours as number,
      source: row.source as string,
    };
  });
  return { rows, truncated: record.truncated };
};

export const quotaHistoryApi = {
  async getHistory(params: QuotaHistoryParams = {}): Promise<QuotaHistoryResponse> {
    const query = buildQuotaHistoryQuery(params).toString();
    try {
      const raw = await apiClient.get<unknown>(
        `/usage-store/quota-history${query ? `?${query}` : ''}`
      );
      return normalizeQuotaHistory(raw);
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 503) {
        throw new UsageStoreDisabledError();
      }
      throw error;
    }
  },
};
