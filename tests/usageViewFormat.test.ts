/**
 * The window, the view state, the CSV and the numbers on screen.
 *
 * All four are pure and all four have an edge that only shows up once: a bucket
 * chosen one hour either side of a threshold, a number that rounds up into the
 * next unit, a model id starting with a minus sign that a spreadsheet reads as
 * a formula, a filter that survives a round trip through the URL.
 */

import { describe, expect, test } from 'bun:test';
import {
  autoUsageBucket,
  previousUsageRange,
  resolveUsageRange,
} from '@/features/usage/logic/timeRange';
import { escapeCsvValue, serializeCsv, usageCsvFilename } from '@/features/usage/logic/csv';
import {
  formatUsageCount,
  formatUsageDelta,
  formatUsageDuration,
  formatUsageRatio,
} from '@/features/usage/logic/formatUsage';
import {
  applyUsageDrilldown,
  readUsageViewState,
  removeUsageFilter,
  usageFilterChips,
  writeUsageViewParams,
  DEFAULT_USAGE_VIEW,
} from '@/features/usage/logic/viewState';
import {
  resolveAccountName,
  resolveDeviceName,
  resolveModelName,
  buildAccountIndex,
  buildDeviceIndex,
  keyFingerprint,
} from '@/features/usage/logic/naming';
import { apiKeyEntry, authFile } from './usageFixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('bucket auto-selection', () => {
  const range = (spanMs: number) => ({ fromMs: 0, toMs: spanMs });

  test('hourly up to and including 48 hours', () => {
    expect(autoUsageBucket(range(HOUR))).toBe('hour');
    expect(autoUsageBucket(range(48 * HOUR))).toBe('hour');
  });

  test('daily past 48 hours, up to and including 90 days', () => {
    expect(autoUsageBucket(range(48 * HOUR + 1))).toBe('day');
    expect(autoUsageBucket(range(90 * DAY))).toBe('day');
  });

  test('weekly beyond 90 days', () => {
    expect(autoUsageBucket(range(90 * DAY + 1))).toBe('week');
    expect(autoUsageBucket(range(365 * DAY))).toBe('week');
  });

  test('a zero-length range still picks a bucket rather than throwing', () => {
    expect(autoUsageBucket(range(0))).toBe('hour');
  });
});

describe('range resolution', () => {
  // 2026-09-13T14:30 local, whatever the runner's zone is.
  const nowMs = new Date(2026, 8, 13, 14, 30, 0, 0).getTime();

  test('relative presets end at now and run back by their span', () => {
    expect(resolveUsageRange('24h', { nowMs })).toEqual({ fromMs: nowMs - DAY, toMs: nowMs });
    expect(resolveUsageRange('7d', { nowMs })).toEqual({ fromMs: nowMs - 7 * DAY, toMs: nowMs });
  });

  test('today starts at local midnight, which is not 24 hours ago', () => {
    const resolved = resolveUsageRange('today', { nowMs });
    const midnight = new Date(2026, 8, 13, 0, 0, 0, 0).getTime();

    expect(resolved.fromMs).toBe(midnight);
    expect(resolved.toMs).toBe(nowMs);
    expect(resolved.fromMs).toBeGreaterThan(nowMs - DAY);
  });

  test('all runs from the store oldest row, or from the epoch without one', () => {
    const oldestMs = nowMs - 200 * DAY;
    expect(resolveUsageRange('all', { nowMs, oldestMs })).toEqual({
      fromMs: oldestMs,
      toMs: nowMs,
    });
    expect(resolveUsageRange('all', { nowMs }).fromMs).toBe(0);
  });

  test('a backwards custom range is read the way round that returns data', () => {
    const resolved = resolveUsageRange('custom', {
      nowMs,
      customFromMs: nowMs,
      customToMs: nowMs - DAY,
    });

    expect(resolved).toEqual({ fromMs: nowMs - DAY, toMs: nowMs });
  });

  test('the previous window is the same length, ending where this one starts', () => {
    const current = { fromMs: nowMs - 7 * DAY, toMs: nowMs };

    expect(previousUsageRange(current)).toEqual({
      fromMs: nowMs - 14 * DAY,
      toMs: nowMs - 7 * DAY,
    });
  });

  test('a zero-length window has no comparable predecessor', () => {
    expect(previousUsageRange({ fromMs: nowMs, toMs: nowMs })).toBeNull();
  });
});

describe('compact number formatting', () => {
  test('under a thousand the exact figure is kept', () => {
    expect(formatUsageCount(0)).toBe('0');
    expect(formatUsageCount(948)).toBe('948');
    expect(formatUsageCount(999)).toBe('999');
  });

  test('thousands and millions get one decimal and a unit', () => {
    expect(formatUsageCount(1000)).toBe('1k');
    expect(formatUsageCount(12_400)).toBe('12.4k');
    expect(formatUsageCount(3_148_220)).toBe('3.1M');
    expect(formatUsageCount(2_400_000_000)).toBe('2.4B');
  });

  test('three digits and up drop the decimal, keeping the column width', () => {
    expect(formatUsageCount(120_500)).toBe('121k');
  });

  test('a value that rounds up into the next unit is promoted, not printed as 1000k', () => {
    expect(formatUsageCount(999_999)).toBe('1M');
    expect(formatUsageCount(999_999_999)).toBe('1B');
  });

  test('negatives keep their sign', () => {
    expect(formatUsageCount(-12_400)).toBe('-12.4k');
  });

  test('durations switch unit where a human sense of fast does', () => {
    expect(formatUsageDuration(0)).toBe('0ms');
    expect(formatUsageDuration(840)).toBe('840ms');
    expect(formatUsageDuration(1400)).toBe('1.4s');
    expect(formatUsageDuration(45_200)).toBe('45s');
    expect(formatUsageDuration(125_000)).toBe('2m 05s');
  });

  test('ratios render as percentages, and an unknown ratio as a dash', () => {
    expect(formatUsageRatio(0.75)).toBe('75%');
    expect(formatUsageRatio(0.0345)).toBe('3.5%');
    expect(formatUsageRatio(0)).toBe('0%');
    expect(formatUsageRatio(null)).toBe('--');
  });

  test('deltas carry a sign, and no baseline renders as nothing at all', () => {
    expect(formatUsageDelta(0.18)).toBe('+18%');
    expect(formatUsageDelta(-0.042)).toBe('-4.2%');
    expect(formatUsageDelta(null)).toBe('');
  });
});

describe('CSV serialisation', () => {
  test('separators, quotes and newlines are quoted per RFC 4180', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('line\nbreak')).toBe('"line\nbreak"');
  });

  test('a leading operator is defused so a spreadsheet does not run it', () => {
    expect(escapeCsvValue('=cmd()')).toBe("'=cmd()");
    expect(escapeCsvValue('-o3-mini')).toBe("'-o3-mini");
    expect(escapeCsvValue('@handle')).toBe("'@handle");
  });

  test('numbers are written raw, and null as an empty field', () => {
    expect(escapeCsvValue(12_400)).toBe('12400');
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  test('rows are CRLF-separated, header first', () => {
    const csv = serializeCsv({
      header: ['Device', 'Total tokens'],
      rows: [
        ['mac', 12_400],
        ['vostro, spare', 900],
      ],
    });

    expect(csv).toBe('Device,Total tokens\r\nmac,12400\r\n"vostro, spare",900');
  });

  test('the filename is sortable and carries the minute', () => {
    expect(usageCsvFilename(new Date(2026, 8, 13, 14, 22))).toBe('usage-2026-09-13-1422.csv');
  });
});

describe('view state in the URL', () => {
  test('defaults are omitted, so a default view has a clean URL', () => {
    expect(writeUsageViewParams(DEFAULT_USAGE_VIEW).toString()).toBe('');
  });

  test('a view survives a round trip through the query string', () => {
    const view = {
      ...DEFAULT_USAGE_VIEW,
      tab: 'matrix' as const,
      range: '30d' as const,
      primary: 'model' as const,
      secondary: null,
      metric: 'output_tokens' as const,
      bucket: 'day' as const,
      matrixRow: 'auth_id' as const,
      matrixColumn: 'provider' as const,
      sortColumn: { kind: 'metric' as const, id: 'requests' as const },
      sortDirection: 'asc' as const,
      filters: { api_key: ['key-a', 'key-b'], model: ['gpt'], failed: true },
    };

    const restored = readUsageViewState(writeUsageViewParams(view));
    expect(restored).toEqual(view);
  });

  test('repeatable filters are repeated in the URL, not joined', () => {
    const params = writeUsageViewParams({
      ...DEFAULT_USAGE_VIEW,
      filters: { api_key: ['key-a', 'key-b'] },
    });

    expect(params.getAll('api_key')).toEqual(['key-a', 'key-b']);
  });

  test('a hand-edited or stale value falls back to the default', () => {
    const restored = readUsageViewState(
      new URLSearchParams('tab=nonsense&g=not_a_dimension&m=not_a_metric&range=eternity')
    );

    expect(restored.tab).toBe(DEFAULT_USAGE_VIEW.tab);
    expect(restored.primary).toBe(DEFAULT_USAGE_VIEW.primary);
    expect(restored.metric).toBe(DEFAULT_USAGE_VIEW.metric);
    expect(restored.range).toBe(DEFAULT_USAGE_VIEW.range);
  });

  test('a secondary matching the primary is dropped rather than grouped twice', () => {
    const restored = readUsageViewState(new URLSearchParams('g=model&g2=model'));
    expect(restored.secondary).toBeNull();
  });

  test('an explicitly cleared secondary is preserved across the round trip', () => {
    const params = writeUsageViewParams({ ...DEFAULT_USAGE_VIEW, secondary: null });
    expect(params.get('g2')).toBe('none');
    expect(readUsageViewState(params).secondary).toBeNull();
  });
});

describe('filter chips', () => {
  test('every active filter becomes one removable chip', () => {
    const chips = usageFilterChips({ api_key: ['key-a', 'key-b'], failed: true });

    expect(chips).toEqual([
      { name: 'api_key', value: 'key-a' },
      { name: 'api_key', value: 'key-b' },
      { name: 'failed', value: 'true' },
    ]);
  });

  test('removing one value keeps its siblings; removing the last drops the name', () => {
    const filters = { api_key: ['key-a', 'key-b'] };

    const afterOne = removeUsageFilter(filters, { name: 'api_key', value: 'key-a' });
    expect(afterOne.api_key).toEqual(['key-b']);

    const afterBoth = removeUsageFilter(afterOne, { name: 'api_key', value: 'key-b' });
    expect('api_key' in afterBoth).toBe(false);
  });

  test('clicking a row narrows to that value without dropping other filters', () => {
    const filters = applyUsageDrilldown({ model: ['gpt'] }, 'api_key', 'key-a');

    expect(filters).toEqual({ model: ['gpt'], api_key: ['key-a'] });
  });

  test('clicking the same value twice does not stack a duplicate', () => {
    const once = applyUsageDrilldown({}, 'api_key', 'key-a');
    expect(applyUsageDrilldown(once, 'api_key', 'key-a')).toEqual({ api_key: ['key-a'] });
  });

  test('the boolean dimensions drill down to a boolean, not a repeated value', () => {
    expect(applyUsageDrilldown({}, 'failed', 'true')).toEqual({ failed: true });
    expect(applyUsageDrilldown({}, 'stream', '0')).toEqual({ stream: false });
  });
});

describe('naming', () => {
  test('a key is never shown whole; the last six characters identify it', () => {
    expect(keyFingerprint('sk-test-key-abc123')).toBe('abc123');
    expect(keyFingerprint('short')).toBe('short');
  });

  test('a labelled key is shown by its label, with the fingerprint underneath', () => {
    const index = buildDeviceIndex([apiKeyEntry({ label: 'mac' })]);
    expect(resolveDeviceName('sk-test-key-abc123', index)).toEqual({
      kind: 'label',
      label: 'mac',
      fingerprint: 'abc123',
    });
  });

  test('an unlabelled key falls back to its fingerprint, never to allowed-models', () => {
    const index = buildDeviceIndex([apiKeyEntry({ allowedModels: ['gpt-*'] })]);
    expect(resolveDeviceName('sk-test-key-abc123', index)).toEqual({
      kind: 'fingerprint',
      fingerprint: 'abc123',
    });
  });

  test('a key the config no longer lists is marked as such', () => {
    expect(resolveDeviceName('sk-gone-xyz789', buildDeviceIndex([]))).toEqual({
      kind: 'unknown',
      fingerprint: 'xyz789',
    });
  });

  test('auth_id resolves to the auth file address, matching the file name', () => {
    const index = buildAccountIndex([authFile()]);

    expect(resolveAccountName('codex-one@example.com.json', index)).toEqual({
      kind: 'email',
      email: 'one@example.com',
      file: 'codex-one@example.com.json',
    });
  });

  test('the match is case-insensitive and tolerates a subdirectory path', () => {
    const index = buildAccountIndex([authFile({ name: 'sub/codex-two@example.com.json' })]);

    expect(resolveAccountName('SUB/CODEX-TWO@EXAMPLE.COM.JSON', index).kind).toBe('email');
    expect(resolveAccountName('codex-two@example.com.json', index).kind).toBe('email');
  });

  test('a credential with no address shows its file name', () => {
    const index = buildAccountIndex([authFile({ email: undefined, name: 'apikey-a.json' })]);

    expect(resolveAccountName('apikey-a.json', index)).toEqual({
      kind: 'file',
      file: 'apikey-a.json',
    });
  });

  test('a UUID auth_id matches nothing and is shown raw rather than hidden', () => {
    const index = buildAccountIndex([authFile()]);

    expect(resolveAccountName('0b3f2a14-9d77-4f63-8f10-1c2e5a7b9d40', index)).toEqual({
      kind: 'raw',
      authId: '0b3f2a14-9d77-4f63-8f10-1c2e5a7b9d40',
    });
  });

  test('an alias is shown in front of the model it stood in for', () => {
    expect(resolveModelName('gpt-5.6-sol', 'natacha/fast')).toEqual({
      primary: 'natacha/fast',
      secondary: 'gpt-5.6-sol',
    });
    expect(resolveModelName('gpt-5.6-sol', 'gpt-5.6-sol')).toEqual({
      primary: 'gpt-5.6-sol',
      secondary: '',
    });
    expect(resolveModelName('gpt-5.6-sol')).toEqual({ primary: 'gpt-5.6-sol', secondary: '' });
  });
});

describe('device fingerprints in the address bar', () => {
  test('writeUsageViewParams stores the fingerprint, never the key', async () => {
    const { writeUsageViewParams, readUsageViewState, DEFAULT_USAGE_VIEW } = await import(
      '@/features/usage/logic/viewState'
    );
    const params = writeUsageViewParams({
      ...DEFAULT_USAGE_VIEW,
      filters: { api_key: ['b6d3936911cd06b46b2efbd89d324f46c722f437a0a3a357'] },
    });
    expect(params.getAll('api_key')).toEqual(['a3a357']);
    expect(params.toString()).not.toContain('b6d39369');
    expect(readUsageViewState(params).filters.api_key).toEqual(['a3a357']);
  });

  test('expandDeviceFilterValues turns a fingerprint back into the key', async () => {
    const { buildDeviceIndex, expandDeviceFilterValues, resolveDeviceName } = await import(
      '@/features/usage/logic/naming'
    );
    const index = buildDeviceIndex([
      { key: 'b6d3936911cd06b46b2efbd89d324f46c722f437a0a3a357', label: 'hermes' },
      { key: '89b757000000000000000000000000000000000000eebeea', label: 'mac' },
    ] as never);
    expect(expandDeviceFilterValues(['a3a357'], index)).toEqual([
      'b6d3936911cd06b46b2efbd89d324f46c722f437a0a3a357',
    ]);
    expect(expandDeviceFilterValues(['nomatch'], index)).toEqual(['nomatch']);
    expect(resolveDeviceName('a3a357', index)).toMatchObject({ kind: 'label', label: 'hermes' });
  });
});

test('a repeated device drill-down does not add a second chip', async () => {
  const { addUsageFilter } = await import('@/features/usage/logic/viewState');
  const key = 'b6d3936911cd06b46b2efbd89d324f46c722f437a0a3a357';
  const once = addUsageFilter({}, 'api_key', key);
  expect(once.api_key).toEqual(['a3a357']);
  expect(addUsageFilter(once, 'api_key', key)).toBe(once);
});
