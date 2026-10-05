/**
 * Request rows assembled from proxy log lines and joined to the usage store.
 */

import { describe, expect, test } from 'bun:test';
import { parseLogLine } from '@/features/logs/model/logParsing';
import type { LogEntry } from '@/features/logs/model/logSelectors';
import {
  EMPTY_LOG_REQUEST_FILTERS,
  buildLogRequestRecords,
  describeServiceTier,
  filterLogRequests,
  indexUsageRowsByShortId,
  joinLogRequests,
  parseLatencyMs,
} from '@/features/logs/model/logRequestTable';
import type { UsageRequestRow } from '@/services/api';

const lines = [
  '[2026-10-05 18:28:13] [5a1ce9d0] [info ] [selector.go:1063] session-affinity: cache hit | session=claude:7... auth=claude-aaaa-owner@example.com.json provider=claude model=claude-opus-5-5',
  '[2026-10-05 18:29:55] [5a1ce9d0] [info ] [gin_logger.go:108] 200 |         1m42s |   100.64.0.7 | POST    "/v1/messages?beta=true"',
  '[2026-10-05 18:30:01] [e172906b] [warn ] [conductor_selection.go:2367] auth unavailable: 1 of 1 candidate(s) for model "claude-haiku-4-5" are in cooldown',
  '[2026-10-05 18:30:01] [e172906b] [warn ] [gin_logger.go:106] 429 |           2ms |       127.0.0.1 | POST    "/v1/messages?beta=true"',
  '[2026-10-05 18:30:02] [-------- ] [info ] [gin_logger.go:108] 200 |        51ms |       127.0.0.1 | GET     "/v0/management/auth-files"',
  '[2026-10-05 18:30:05] [77aa00ff] [info ] [selector.go:1063] session-affinity: cache hit | session=codex:01... auth=codex-bbbb-pro.json provider=mixed model=gpt-6.1-sol',
];

const entries: LogEntry[] = lines.map((raw, id) => ({ ...parseLogLine(raw), id }));

const usageRow = (requestId: string, overrides: Partial<UsageRequestRow> = {}): UsageRequestRow =>
  ({
    id: 1,
    ts: '2026-10-05T18:29:55Z',
    api_key: 'sk-test-0000000000000000000000000000000000abcdef',
    model: 'claude-opus-5-5',
    alias: 'claude-opus-latest',
    auth_id: 'claude-aaaa-owner@example.com.json',
    auth_index: '0123456789abcdef',
    provider: 'claude',
    auth_type: 'oauth',
    executor_type: 'ClaudeExecutor',
    endpoint: 'POST /v1/messages',
    request_id: requestId,
    session_id: 's',
    parent_session_id: '',
    reasoning_effort: 'xhigh',
    service_tier: '',
    response_service_tier: '',
    stream: true,
    generate: true,
    failed: false,
    status_code: 200,
    latency_ms: 102000,
    ttft_ms: 24000,
    input_tokens: 1,
    output_tokens: 2,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 3,
    cache_creation_tokens: 4,
    total_tokens: 10,
    client_ip: '100.64.0.7',
    user_agent: 'claude-cli/2.1.289',
    ...overrides,
  }) as UsageRequestRow;

describe('parseLatencyMs', () => {
  test('reads gin durations', () => {
    expect(parseLatencyMs('851ms')).toBe(851);
    expect(parseLatencyMs('18.825s')).toBe(18825);
    expect(parseLatencyMs('1m42s')).toBe(102000);
    expect(parseLatencyMs('1h2m3s')).toBe(3723000);
    expect(parseLatencyMs('0s')).toBe(0);
    expect(parseLatencyMs('fast')).toBeNull();
    expect(parseLatencyMs(undefined)).toBeNull();
  });
});

describe('buildLogRequestRecords', () => {
  const records = buildLogRequestRecords(entries);

  test('one record per real request id, newest first, management lines skipped', () => {
    expect(records.map((record) => record.id)).toEqual(['77aa00ff', 'e172906b', '5a1ce9d0']);
  });

  test('merges routing and access lines', () => {
    const done = records.find((record) => record.id === '5a1ce9d0')!;
    expect(done).toMatchObject({
      finished: true,
      status: 200,
      latencyMs: 102000,
      method: 'POST',
      path: '/v1/messages?beta=true',
      ip: '100.64.0.7',
      auth: 'claude-aaaa-owner@example.com.json',
      provider: 'claude',
      model: 'claude-opus-5-5',
    });
    expect(done.atMs).toBe(Date.UTC(2026, 9, 5, 18, 29, 55));
  });

  test('flags cooldown refusals and keeps in-flight requests', () => {
    const refused = records.find((record) => record.id === 'e172906b')!;
    expect(refused.status).toBe(429);
    expect(refused.rateLimited).toBe(true);
    expect(refused.hasWarn).toBe(true);
    const inFlight = records.find((record) => record.id === '77aa00ff')!;
    expect(inFlight.finished).toBe(false);
    expect(inFlight.status).toBeNull();
  });
});

describe('joinLogRequests', () => {
  const records = buildLogRequestRecords(entries);
  const usage = indexUsageRowsByShortId([
    usageRow('01a10d2d-e8d4-7c29-8e63-90915a1ce9d0'),
    usageRow('01a10d2d-0000-7c29-8e63-9091e172906b', {
      failed: true,
      status_code: 429,
      ttft_ms: 0,
    }),
  ]);
  const joined = joinLogRequests(records, usage);

  test('matches the log id to the stored request by suffix', () => {
    const row = joined.find((item) => item.record.id === '5a1ce9d0')!;
    expect(row.usage?.request_id.endsWith('5a1ce9d0')).toBe(true);
    expect(row.alias).toBe('claude-opus-latest');
    expect(row.ttftMs).toBe(24000);
    expect(row.slowFirstToken).toBe(true);
    expect(row.isError).toBe(false);
  });

  test('a stored record finishes a request whose access line has not landed yet', () => {
    const late = joinLogRequests(
      buildLogRequestRecords(entries),
      indexUsageRowsByShortId([
        usageRow('01a10d2d-1111-7c29-8e63-909177aa00ff', { status_code: 0 }),
      ])
    ).find((item) => item.record.id === '77aa00ff')!;
    expect(late.finished).toBe(true);
    expect(late.status).toBe(200);
  });

  test('rows without a stored record keep the log fields', () => {
    const row = joined.find((item) => item.record.id === '77aa00ff')!;
    expect(row.usage).toBeNull();
    expect(row.model).toBe('gpt-6.1-sol');
    expect(row.authId).toBe('codex-bbbb-pro.json');
  });

  test('filters by errors, slow first token, status class and text', () => {
    const errors = filterLogRequests(joined, { ...EMPTY_LOG_REQUEST_FILTERS, errorsOnly: true });
    expect(errors.map((row) => row.record.id)).toEqual(['e172906b']);
    const slow = filterLogRequests(joined, { ...EMPTY_LOG_REQUEST_FILTERS, slowOnly: true });
    expect(slow.map((row) => row.record.id)).toEqual(['5a1ce9d0']);
    const pending = filterLogRequests(joined, {
      ...EMPTY_LOG_REQUEST_FILTERS,
      statusClasses: new Set(['pending']),
    });
    expect(pending.map((row) => row.record.id)).toEqual(['77aa00ff']);
    const text = filterLogRequests(joined, { ...EMPTY_LOG_REQUEST_FILTERS, text: 'cooldown' });
    expect(text.map((row) => row.record.id)).toEqual(['e172906b']);
  });
});

describe('describeServiceTier', () => {
  test('names Codex speed tiers', () => {
    expect(describeServiceTier({ service_tier: 'priority', response_service_tier: '' })).toBe(
      'fast'
    );
    expect(describeServiceTier({ service_tier: 'ultrafast', response_service_tier: '' })).toBe(
      'ultrafast'
    );
    expect(describeServiceTier({ service_tier: '', response_service_tier: 'default' })).toBe(
      'standard'
    );
    expect(describeServiceTier({ service_tier: '', response_service_tier: '' })).toBeNull();
  });
});
