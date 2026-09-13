/**
 * The rows the store does not return.
 *
 * Two of the four views show numbers no endpoint sends: the parent row over a
 * secondary grouping, and the row and column totals of the pivot. Both are
 * built from the flat response, so both can be wrong in ways that still look
 * plausible on screen. In particular the averages: summing two averages is the
 * obvious mistake and the one nobody notices, so the weighting is pinned here.
 */

import { describe, expect, test } from 'bun:test';
import { buildUsageGroupTree, sortUsageGroups } from '@/features/usage/logic/groupTree';
import {
  buildUsageMatrix,
  sortUsageMatrixAxis,
  usageHeatIntensity,
  usageMatrixCell,
  usageMatrixMaxCell,
} from '@/features/usage/logic/matrix';
import { cacheHitRatio, combineUsageMetrics, relativeDelta } from '@/features/usage/logic/metrics';
import { metrics, summaryRow } from './usageFixtures';

describe('group tree', () => {
  const rows = [
    summaryRow(
      { api_key: 'key-a', model: 'gpt-5.6-sol' },
      { requests: 30, total_tokens: 3000, latency_ms_avg: 1000, latency_ms_p95: 4000 },
      { first_at: '2026-09-10T00:00:00Z', last_at: '2026-09-12T00:00:00Z' }
    ),
    summaryRow(
      { api_key: 'key-a', model: 'claude-opus-5' },
      { requests: 10, total_tokens: 500, latency_ms_avg: 5000, latency_ms_p95: 9000 },
      { first_at: '2026-09-08T00:00:00Z', last_at: '2026-09-13T00:00:00Z' }
    ),
    summaryRow({ api_key: 'key-b', model: 'gpt-5.6-sol' }, { requests: 5, total_tokens: 100 }),
  ];

  test('one node per primary value, children in server order', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'model' });

    expect(tree.map((node) => node.key)).toEqual(['key-a', 'key-b']);
    expect(tree[0].children.map((child) => child.key)).toEqual(['gpt-5.6-sol', 'claude-opus-5']);
    expect(tree[1].children.map((child) => child.key)).toEqual(['gpt-5.6-sol']);
  });

  test('counts add on the parent', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'model' });

    expect(tree[0].metrics.requests).toBe(40);
    expect(tree[0].metrics.total_tokens).toBe(3500);
  });

  test('the parent average is weighted by requests, not averaged again', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'model' });

    // (30 x 1000 + 10 x 5000) / 40 = 2000. A plain mean of the two averages
    // would be 3000, which would blame a busy fast model for a quiet slow one.
    expect(tree[0].metrics.latency_ms_avg).toBe(2000);
  });

  test('p95 survives a single child and is dropped once there are two', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'model' });

    expect(tree[0].metrics.latency_ms_p95).toBeNull();
    expect(tree[1].metrics.latency_ms_p95).toBeNull();

    const single = buildUsageGroupTree(
      [summaryRow({ api_key: 'key-c' }, { requests: 2, latency_ms_p95: 1234 })],
      { primary: 'api_key', secondary: null }
    );
    expect(single[0].metrics.latency_ms_p95).toBe(1234);
  });

  test('the parent window spans its children', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'model' });

    expect(tree[0].firstAt).toBe('2026-09-08T00:00:00Z');
    expect(tree[0].lastAt).toBe('2026-09-13T00:00:00Z');
  });

  test('no secondary means no children', () => {
    const flat = buildUsageGroupTree(
      [
        summaryRow({ api_key: 'key-a' }, { requests: 40 }),
        summaryRow({ api_key: 'key-b' }, { requests: 5 }),
      ],
      { primary: 'api_key', secondary: null }
    );

    expect(flat.map((node) => node.children.length)).toEqual([0, 0]);
  });

  test('a secondary equal to the primary is ignored rather than duplicated', () => {
    const tree = buildUsageGroupTree(rows, { primary: 'api_key', secondary: 'api_key' });

    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe('sorting groups', () => {
  const tree = buildUsageGroupTree(
    [
      summaryRow({ api_key: 'key-a', model: 'b-model' }, { requests: 1, total_tokens: 10 }),
      summaryRow({ api_key: 'key-a', model: 'a-model' }, { requests: 9, total_tokens: 90 }),
      summaryRow({ api_key: 'key-b', model: 'a-model' }, { requests: 50, total_tokens: 500 }),
    ],
    { primary: 'api_key', secondary: 'model' }
  );

  const labelOf = (key: string) => key;

  test('a metric sorts descending and ascending', () => {
    const desc = sortUsageGroups(tree, {
      column: { kind: 'metric', id: 'total_tokens' },
      direction: 'desc',
      labelOf,
    });
    expect(desc.map((node) => node.key)).toEqual(['key-b', 'key-a']);

    const asc = sortUsageGroups(tree, {
      column: { kind: 'metric', id: 'total_tokens' },
      direction: 'asc',
      labelOf,
    });
    expect(asc.map((node) => node.key)).toEqual(['key-a', 'key-b']);
  });

  test('children sort by their own labels, not the parent dimension', () => {
    const sorted = sortUsageGroups(tree, {
      column: { kind: 'key' },
      direction: 'asc',
      labelOf: () => 'same',
      childLabelOf: (key) => key,
    });

    const keyA = sorted.find((node) => node.key === 'key-a');
    expect(keyA?.children.map((child) => child.key)).toEqual(['a-model', 'b-model']);
  });

  test('sorting by key uses the display label, not the stored value', () => {
    const sorted = sortUsageGroups(tree, {
      column: { kind: 'key' },
      direction: 'asc',
      // Renaming key-b to "aaa" must put it first, because that is what a
      // reader sorting the name column sees.
      labelOf: (key) => (key === 'key-b' ? 'aaa' : 'zzz'),
    });

    expect(sorted.map((node) => node.key)).toEqual(['key-b', 'key-a']);
  });
});

describe('matrix pivot', () => {
  const rows = [
    summaryRow({ api_key: 'key-a', model: 'gpt' }, { total_tokens: 100, requests: 4 }),
    summaryRow({ api_key: 'key-a', model: 'claude' }, { total_tokens: 300, requests: 2 }),
    summaryRow({ api_key: 'key-b', model: 'gpt' }, { total_tokens: 600, requests: 9 }),
  ];

  const matrix = buildUsageMatrix(rows, {
    rowDimension: 'api_key',
    columnDimension: 'model',
    metric: 'total_tokens',
  });

  test('axes are ordered by the selected metric, heaviest first', () => {
    expect(matrix.rows.map((row) => row.key)).toEqual(['key-b', 'key-a']);
    expect(matrix.columns.map((column) => column.key)).toEqual(['gpt', 'claude']);
  });

  test('cells hold the crossing, and a pair that never occurred is absent', () => {
    expect(usageMatrixCell(matrix, 'key-a', 'gpt')?.metrics.total_tokens).toBe(100);
    expect(usageMatrixCell(matrix, 'key-b', 'claude')).toBeUndefined();
  });

  test('margins total their axis, and the grand total totals the margins', () => {
    const keyA = matrix.rows.find((row) => row.key === 'key-a');
    const gpt = matrix.columns.find((column) => column.key === 'gpt');

    expect(keyA?.totals.total_tokens).toBe(400);
    expect(gpt?.totals.total_tokens).toBe(700);
    expect(matrix.totals.total_tokens).toBe(1000);
    expect(matrix.totals.requests).toBe(15);
  });

  test('a duplicated pair adds rather than overwriting', () => {
    const doubled = buildUsageMatrix(
      [
        summaryRow({ api_key: 'key-a', model: 'gpt' }, { total_tokens: 100 }),
        summaryRow({ api_key: 'key-a', model: 'gpt' }, { total_tokens: 50 }),
      ],
      { rowDimension: 'api_key', columnDimension: 'model', metric: 'total_tokens' }
    );

    expect(usageMatrixCell(doubled, 'key-a', 'gpt')?.metrics.total_tokens).toBe(150);
  });

  test('the heat scale runs against the busiest cell', () => {
    expect(usageMatrixMaxCell(matrix, 'total_tokens')).toBe(600);
    expect(usageHeatIntensity(600, 600)).toBe(1);
    expect(usageHeatIntensity(0, 600)).toBe(0);
    // Square-rooted: a cell at a quarter of the peak still reads as half-lit.
    expect(usageHeatIntensity(150, 600)).toBeCloseTo(0.5, 6);
  });

  test('an axis can be re-sorted without rebuilding the grid', () => {
    const ascending = sortUsageMatrixAxis(matrix.rows, 'total_tokens', 'asc');
    expect(ascending.map((row) => row.key)).toEqual(['key-a', 'key-b']);
  });
});

describe('derived ratios', () => {
  test('cache hit is reads over prompt tokens, and null without either', () => {
    expect(cacheHitRatio(metrics({ input_tokens: 1000, cache_read_tokens: 3000 }))).toBe(0.75);
    expect(cacheHitRatio(metrics({ input_tokens: 0, cache_read_tokens: 0 }))).toBeNull();
    // Cache writes are the cost of filling the cache, not evidence of a hit.
    expect(cacheHitRatio(metrics({ input_tokens: 100, cache_creation_tokens: 900 }))).toBe(0);
  });

  test('a delta against an empty window is reported as unknown, not as +100%', () => {
    expect(relativeDelta(50, 25)).toBe(1);
    expect(relativeDelta(25, 50)).toBe(-0.5);
    expect(relativeDelta(50, 0)).toBeNull();
  });

  test('combining nothing yields a zeroed row rather than NaN averages', () => {
    const empty = combineUsageMetrics([]);
    expect(empty.requests).toBe(0);
    expect(empty.latency_ms_avg).toBe(0);
    expect(empty.latency_ms_p95).toBeNull();
  });
});
