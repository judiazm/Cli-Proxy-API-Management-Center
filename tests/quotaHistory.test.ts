import { describe, expect, test } from 'bun:test';
import { buildQuotaHistoryQuery, normalizeQuotaHistory } from '@/services/api/quotaHistory';

describe('quota observation API contract', () => {
  test('encodes identity and range using backend field names', () => {
    const query = buildQuotaHistoryQuery({
      from: '2026-10-01T00:00:00Z',
      to: 1790899200000,
      provider: 'codex',
      authId: 'a.json',
      authIndex: 'opaque',
      limit: 99999,
    });
    expect(query.get('from')).toBe('2026-10-01T00:00:00Z');
    expect(query.get('to')).toBe('1790899200000');
    expect(query.get('provider')).toBe('codex');
    expect(query.get('auth_id')).toBe('a.json');
    expect(query.get('auth_index')).toBe('opaque');
    expect(query.get('limit')).toBe('10000');
  });
  test('preserves a complete normalized observation without adding raw data', () => {
    const row = {
      id: 1,
      provider: 'codex',
      auth_id: 'a.json',
      auth_index: 'opaque',
      window_id: 'weekly',
      observed_at_ms: 1000,
      used_percent: 50,
      reset_at_ms: 2000,
      period_hours: 168,
      source: 'passive-response',
    };
    expect(
      normalizeQuotaHistory({ rows: [{ ...row, raw_headers: 'excluded' }], truncated: false })
    ).toEqual({ rows: [row], truncated: false });
  });
  test('keeps truncation explicit and rejects missing diagnostics or malformed numeric fields', () => {
    expect(normalizeQuotaHistory({ rows: [], truncated: true }).truncated).toBe(true);
    for (const raw of [
      null,
      {},
      { rows: [] },
      { rows: [{ used_percent: '50' }], truncated: false },
    ]) {
      expect(() => normalizeQuotaHistory(raw)).toThrow();
    }
  });
});
