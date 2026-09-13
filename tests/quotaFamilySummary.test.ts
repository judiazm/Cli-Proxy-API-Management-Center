/**
 * Family aggregation and the fixed columns the quota table is built on.
 *
 * Two properties carry the whole layout: the binding window leads the column
 * order and drives the headline figure, and the column set is the *union* over
 * the family, so a credential that reports fewer windows leaves a hole rather
 * than shifting everything after it one column left.
 */

import { describe, expect, test } from 'bun:test';
import {
  MANUAL_RESETS_COLUMN_ID,
  buildQuotaColumns,
  buildQuotaFamilySummary,
  buildQuotaRowModel,
  type QuotaFamilyMember,
  type QuotaProviderFamily,
} from '@/utils/quota';
import type { ClaudeQuotaState, CodexQuotaState, DevinQuotaState } from '@/types';
import { DAY_MS } from '@/utils/time/durations';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const claudeCredential = (
  fable: number,
  sevenDay: number,
  resetAtMs: number
): ClaudeQuotaState => ({
  status: 'success',
  planType: 'plan_max',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      labelKey: 'claude_quota.five_hour',
      usedPercent: 0,
      resetLabel: '-',
      resetAtMs: null,
      periodHours: 5,
    },
    {
      id: 'seven-day',
      label: '7-day limit',
      labelKey: 'claude_quota.seven_day',
      usedPercent: 100 - sevenDay,
      resetLabel: '09/17, 21:00',
      resetAtMs: resetAtMs + DAY_MS,
      periodHours: 168,
    },
    {
      id: 'seven-day-fable',
      label: '7-day Fable 5',
      labelKey: 'claude_quota.seven_day_fable',
      usedPercent: 100 - fable,
      resetLabel: '09/14, 21:00',
      resetAtMs,
      periodHours: 168,
    },
  ],
});

const memberOf = (
  key: string,
  state: unknown,
  family: QuotaProviderFamily
): QuotaFamilyMember => ({
  key,
  model: buildQuotaRowModel(family, state),
});

const devinCredential = (): DevinQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'daily',
      remainingPercent: 25,
      resetAtMs: NOW + DAY_MS,
      periodHours: 24,
    },
    {
      id: 'weekly',
      remainingPercent: 80,
      resetAtMs: NOW + 7 * DAY_MS,
      periodHours: 168,
    },
  ],
  observedAtMs: NOW,
  plan: 'Pro',
  planStartMs: NOW - DAY_MS,
  planEndMs: NOW + 30 * DAY_MS,
});

describe('buildQuotaColumns', () => {
  test('leads with the binding window, then first-seen order', () => {
    const members = [
      memberOf('a', claudeCredential(58, 79, NOW + DAY_MS), 'claude'),
      memberOf('b', claudeCredential(100, 100, NOW + 4 * DAY_MS), 'claude'),
    ];

    expect(buildQuotaColumns('claude', members).map((column) => column.columnId)).toEqual([
      'claude_quota.seven_day_fable',
      'claude_quota.five_hour',
      'claude_quota.seven_day',
    ]);
  });

  test('takes the union so a credential reporting fewer windows leaves a hole', () => {
    const full = claudeCredential(58, 79, NOW + DAY_MS);
    const partial: ClaudeQuotaState = {
      ...full,
      windows: full.windows.filter((window) => window.id === 'seven-day-fable'),
    };

    const columns = buildQuotaColumns('claude', [
      memberOf('a', partial, 'claude'),
      memberOf('b', full, 'claude'),
    ]);

    expect(columns.map((column) => column.columnId)).toEqual([
      'claude_quota.seven_day_fable',
      'claude_quota.five_hour',
      'claude_quota.seven_day',
    ]);
  });

  test('per-model Codex limits share one column regardless of payload order', () => {
    const codex = (order: readonly string[]): CodexQuotaState => ({
      status: 'success',
      planType: 'pro',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          labelKey: 'codex_quota.secondary_window',
          usedPercent: 2,
          resetLabel: '09/19, 04:10',
          resetAtMs: NOW + 6 * DAY_MS,
          periodHours: 168,
        },
        ...order.map((name, index) => ({
          // The positional suffix is exactly what a row id would split on.
          id: `${name.toLowerCase()}-weekly-${index}`,
          label: `${name} weekly limit`,
          labelKey: 'codex_quota.additional_secondary_window',
          labelParams: { name },
          usedPercent: 0,
          resetLabel: '09/20, 00:11',
          resetAtMs: NOW + 6 * DAY_MS,
          periodHours: 168,
        })),
      ],
      rateLimitResetCredits: [],
    });

    const columns = buildQuotaColumns('codex', [
      memberOf('a', codex(['Spark', 'Swift']), 'codex'),
      memberOf('b', codex(['Swift', 'Spark']), 'codex'),
    ]);

    expect(columns.map((column) => column.columnId)).toEqual([
      'codex_quota.secondary_window',
      'codex_quota.additional_secondary_window|spark',
      'codex_quota.additional_secondary_window|swift',
    ]);
  });

  test('appends the manual-reset ledger last when any credential has one', () => {
    const withCredits: CodexQuotaState = {
      status: 'success',
      windows: [
        {
          id: 'weekly',
          label: 'Weekly limit',
          labelKey: 'codex_quota.secondary_window',
          usedPercent: 83,
          resetLabel: '09/14, 18:42',
          resetAtMs: NOW + 2 * DAY_MS,
          periodHours: 168,
        },
      ],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [],
    };

    const columns = buildQuotaColumns('codex', [memberOf('a', withCredits, 'codex')]);
    expect(columns[columns.length - 1].columnId).toBe(MANUAL_RESETS_COLUMN_ID);
  });

  test('models Devin in the compact layout with weekly quota as the binding window', () => {
    const member = memberOf('devin', devinCredential(), 'devin');
    const model = member.model;

    expect(model?.plan).toEqual({ text: 'Pro', tier: 'plain' });
    expect(model?.renewal).toEqual({
      labelKey: 'devin_quota.plan_end',
      label: '',
      atMs: NOW + 30 * DAY_MS,
    });
    expect(buildQuotaColumns('devin', [member]).map((column) => column.columnId)).toEqual([
      'devin_quota.weekly',
      'devin_quota.daily',
    ]);
    expect(buildQuotaFamilySummary('devin', [member], NOW).binding?.totalRemainingPercent).toBe(
      80
    );
  });
});

describe('buildQuotaFamilySummary', () => {
  const members = [
    memberOf('a', claudeCredential(58, 79, NOW + DAY_MS), 'claude'),
    memberOf('b', claudeCredential(100, 100, NOW + 4 * DAY_MS), 'claude'),
    memberOf('c', claudeCredential(100, 100, NOW + 4 * DAY_MS), 'claude'),
    memberOf('d', claudeCredential(51, 75, NOW + DAY_MS), 'claude'),
    memberOf('e', claudeCredential(100, 100, NOW + 5 * DAY_MS), 'claude'),
  ];

  test('totals the Fable bucket against the whole family', () => {
    const summary = buildQuotaFamilySummary('claude', members, NOW);

    expect(summary.binding?.column.columnId).toBe('claude_quota.seven_day_fable');
    expect(summary.binding?.totalRemainingPercent).toBe(409);
    expect(summary.binding?.maxRemainingPercent).toBe(500);
    expect(summary.bars).toEqual([58, 100, 100, 51, 100]);
  });

  test('keeps the plain 7-day total as the secondary line', () => {
    const summary = buildQuotaFamilySummary('claude', members, NOW);

    expect(summary.secondary?.column.columnId).toBe('claude_quota.seven_day');
    expect(summary.secondary?.totalRemainingPercent).toBe(454);
  });

  test('reports the soonest binding reset still ahead, ignoring past ones', () => {
    const summary = buildQuotaFamilySummary('claude', members, NOW);
    expect(summary.soonestResetAtMs).toBe(NOW + DAY_MS);

    const afterwards = buildQuotaFamilySummary('claude', members, NOW + 2 * DAY_MS);
    expect(afterwards.soonestResetAtMs).toBe(NOW + 4 * DAY_MS);
  });

  test('an unloaded family keeps its denominator and reports no reading', () => {
    const unloaded: QuotaFamilyMember[] = [
      { key: 'a', model: null },
      { key: 'b', model: null },
    ];
    const summary = buildQuotaFamilySummary('claude', unloaded, NOW);

    expect(summary.binding).toBeNull();
    expect(summary.credentialCount).toBe(2);
    expect(summary.bars).toEqual([null, null]);
  });

  test('a partly loaded family counts every credential in the denominator', () => {
    const partial = [members[0], { key: 'b', model: null }];
    const summary = buildQuotaFamilySummary('claude', partial, NOW);

    expect(summary.binding?.totalRemainingPercent).toBe(58);
    expect(summary.binding?.maxRemainingPercent).toBe(200);
    expect(summary.binding?.readingCount).toBe(1);
  });
});
