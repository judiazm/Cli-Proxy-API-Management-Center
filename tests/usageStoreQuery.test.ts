/**
 * Query encoding is where a contract is honoured or quietly broken.
 *
 * The store reads repeatable filters as OR within a name and AND across names,
 * which on the wire means the same parameter repeated. Comma-joining them would
 * not fail loudly: it would ask for one device literally named "a,b" and return
 * an empty, believable table. So the repetition is pinned by a test.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildUsageRequestsQuery,
  buildUsageSummaryQuery,
  UsageStoreDisabledError,
} from '@/services/api/usageStore';

describe('summary query encoding', () => {
  test('a repeatable filter repeats its name instead of joining values', () => {
    const params = buildUsageSummaryQuery({
      filters: { api_key: ['key-a', 'key-b'], model: ['gpt-5.6-sol'] },
    });

    expect(params.getAll('api_key')).toEqual(['key-a', 'key-b']);
    expect(params.getAll('model')).toEqual(['gpt-5.6-sol']);
    expect(params.toString()).toBe('api_key=key-a&api_key=key-b&model=gpt-5.6-sol');
  });

  test('group_by is the one comma-separated parameter', () => {
    const params = buildUsageSummaryQuery({ groupBy: ['api_key', 'model'] });

    expect(params.getAll('group_by')).toEqual(['api_key,model']);
  });

  test('an empty group_by is omitted, which the store reads as one totals row', () => {
    expect(buildUsageSummaryQuery({ groupBy: [] }).has('group_by')).toBe(false);
    expect(buildUsageSummaryQuery({}).has('group_by')).toBe(false);
  });

  test('blank filter values are dropped rather than asking for the empty string', () => {
    const params = buildUsageSummaryQuery({
      filters: { api_key: ['  ', 'key-a', ''], provider: ['   '] },
    });

    expect(params.getAll('api_key')).toEqual(['key-a']);
    expect(params.has('provider')).toBe(false);
  });

  test('failed and stream are single booleans, and absent when undefined', () => {
    const both = buildUsageSummaryQuery({ filters: { failed: true, stream: false } });
    expect(both.getAll('failed')).toEqual(['true']);
    expect(both.getAll('stream')).toEqual(['false']);

    const neither = buildUsageSummaryQuery({ filters: { api_key: ['key-a'] } });
    expect(neither.has('failed')).toBe(false);
    expect(neither.has('stream')).toBe(false);
  });

  test('range, ordering and limit ride along as the contract names them', () => {
    const params = buildUsageSummaryQuery({
      from: 1_757_000_000_000,
      to: '2026-09-13T00:00:00Z',
      tz: 'America/New_York',
      orderBy: 'total_tokens',
      order: 'asc',
      limit: 250.7,
    });

    expect(params.get('from')).toBe('1757000000000');
    expect(params.get('to')).toBe('2026-09-13T00:00:00Z');
    expect(params.get('tz')).toBe('America/New_York');
    expect(params.get('order_by')).toBe('total_tokens');
    expect(params.get('order')).toBe('asc');
    // A fractional limit is a caller bug, not a request the store should see.
    expect(params.get('limit')).toBe('250');
  });
});

describe('requests query encoding', () => {
  test('the cursor is sent as before, and filters encode the same way', () => {
    const params = buildUsageRequestsQuery({
      from: 1,
      to: 2,
      limit: 200,
      before: 4812,
      filters: { model: ['a', 'b'], failed: true },
    });

    expect(params.get('before')).toBe('4812');
    expect(params.get('limit')).toBe('200');
    expect(params.getAll('model')).toEqual(['a', 'b']);
    expect(params.get('failed')).toBe('true');
  });

  test('no cursor on the first page', () => {
    expect(buildUsageRequestsQuery({ limit: 200 }).has('before')).toBe(false);
  });
});

describe('the disabled store', () => {
  test('is an error type the page can branch on, not a message to match', () => {
    const error = new UsageStoreDisabledError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UsageStoreDisabledError);
    expect(error.status).toBe(503);
    expect(error.name).toBe('UsageStoreDisabledError');
    expect(error.message).toBe('usage store disabled');
  });

  test('keeps the gateway wording when the response carried one', () => {
    expect(new UsageStoreDisabledError('usage store disabled').message).toBe(
      'usage store disabled'
    );
  });
});
