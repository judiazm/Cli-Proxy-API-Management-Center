/**
 * Typed fixtures for the usage store's wire shapes.
 *
 * Built from the contract in `../CLIProxyAPI/PATCHES.md` rather than from a
 * recorded response, because the endpoints do not exist yet. Typing them to the
 * exported interfaces is what makes that safe: the day the backend lands, a
 * field that was invented here stops compiling in the service layer.
 */

import type {
  UsageMetaResponse,
  UsageMetrics,
  UsageRequestRow,
  UsageSummaryResponse,
  UsageSummaryRow,
} from '@/services/api';
import type { ApiKeyEntry } from '@/services/api';
import type { AuthFileItem } from '@/types';

export const metrics = (overrides: Partial<UsageMetrics> = {}): UsageMetrics => ({
  requests: 0,
  failed: 0,
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cached_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  latency_ms_avg: 0,
  latency_ms_p95: null,
  ttft_ms_avg: 0,
  ...overrides,
});

export const summaryRow = (
  keys: Record<string, string>,
  overrides: Partial<UsageMetrics> = {},
  stamps: { first_at?: string; last_at?: string } = {}
): UsageSummaryRow => ({
  ...metrics(overrides),
  keys,
  first_at: stamps.first_at ?? '2026-09-12T00:00:00Z',
  last_at: stamps.last_at ?? '2026-09-13T00:00:00Z',
});

export const summaryResponse = (
  rows: UsageSummaryRow[],
  totals: Partial<UsageMetrics> = {}
): UsageSummaryResponse => ({
  from: '2026-09-06T00:00:00Z',
  to: '2026-09-13T00:00:00Z',
  tz: 'UTC',
  group_by: [],
  rows,
  totals: metrics(totals),
});

export const requestRow = (overrides: Partial<UsageRequestRow> = {}): UsageRequestRow => ({
  id: 1,
  ts: '2026-09-13T09:00:00Z',
  api_key: 'sk-test-key-abc123',
  model: 'gpt-5.6-sol',
  alias: '',
  auth_id: 'codex-one@example.com.json',
  auth_index: 'a1b2c3d4e5f60718',
  provider: 'codex',
  auth_type: 'oauth',
  executor_type: 'codex',
  endpoint: '/v1/responses',
  request_id: 'req-1',
  session_id: 'sess-1',
  parent_session_id: '',
  reasoning_effort: 'high',
  service_tier: '',
  response_service_tier: '',
  stream: true,
  generate: false,
  failed: false,
  status_code: 0,
  latency_ms: 1200,
  ttft_ms: 300,
  input_tokens: 1000,
  output_tokens: 500,
  reasoning_tokens: 200,
  cached_tokens: 0,
  cache_read_tokens: 3000,
  cache_creation_tokens: 100,
  total_tokens: 4800,
  client_ip: '10.23.10.4',
  user_agent: 'codex-cli/2.0',
  ...overrides,
});

export const metaResponse = (overrides: Partial<UsageMetaResponse> = {}): UsageMetaResponse => ({
  enabled: true,
  path: '~/.cli-proxy-api/usage.db',
  retention_days: 0,
  rows: 4820,
  oldest: '2026-08-01T00:00:00Z',
  newest: '2026-09-13T09:00:00Z',
  size_bytes: 1_048_576,
  dimensions: {
    api_key: ['sk-test-key-abc123', 'sk-test-key-def456'],
    model: ['gpt-5.6-sol', 'claude-opus-5'],
    auth_id: ['codex-one@example.com.json'],
    provider: ['codex', 'claude'],
    reasoning_effort: ['high', 'xhigh'],
  },
  ...overrides,
});

export const apiKeyEntry = (overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry => ({
  key: 'sk-test-key-abc123',
  label: '',
  allowedModels: [],
  ...overrides,
});

export const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'codex-one@example.com.json',
  type: 'codex',
  email: 'one@example.com',
  ...overrides,
});
