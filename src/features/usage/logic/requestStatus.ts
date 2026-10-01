import type { UsageRequestRow } from '@/services/api';

/** HTTP status is response evidence; it does not identify the failing machine or service. */
export const requestStatusKey = (row: Pick<UsageRequestRow, 'failed' | 'status_code'>): string => {
  if (row.status_code === 429) return 'usage.status_rate_limit';
  if (row.status_code === 401 || row.status_code === 403) return 'usage.status_auth_rejection';
  if (row.status_code >= 500 && row.status_code < 600) return 'usage.status_http_5xx';
  if (row.status_code >= 400 && row.status_code < 500) return 'usage.status_http_4xx';
  if (row.failed && row.status_code === 0) return 'usage.status_no_http';
  return row.failed ? 'usage.status_failed' : 'usage.status_ok';
};
