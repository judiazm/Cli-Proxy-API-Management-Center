/**
 * Codex rows for the 2026-09 plan lineup.
 *
 * Pro (Pro 200) and Pro 500 report one weekly window and no 5-hour window;
 * Team reports both. Manual resets only apply when usage needs one, which the
 * usage payload states as `applicable_available_count`.
 */

import { describe, expect, test } from 'bun:test';
import { buildQuotaRowModel } from '@/utils/quota';
import type { CodexQuotaState } from '@/types';

const weekly = {
  id: 'weekly',
  label: 'Weekly limit',
  labelKey: 'codex_quota.secondary_window',
  usedPercent: 2,
  resetLabel: '10/12, 00:21',
  resetAtMs: Date.UTC(2026, 9, 12, 4, 21),
  periodHours: 168,
};

const codex = (overrides: Partial<CodexQuotaState>): CodexQuotaState => ({
  status: 'success',
  windows: [weekly],
  planType: 'promax',
  creditBalance: '62332.1032200000',
  creditsUnlimited: false,
  rateLimitResetCreditsAvailableCount: 2,
  rateLimitResetCreditsApplicableAvailableCount: 0,
  rateLimitResetCredits: [],
  rateLimitResetCreditsError: '',
  ...overrides,
});

describe('Codex plan rows', () => {
  test('Pro 500 is labelled, notes Ultrafast and shows its credit balance', () => {
    const model = buildQuotaRowModel('codex', codex({}));
    expect(model.plan).toEqual({ labelKey: 'codex_quota.plan_promax', tier: 'elite' });
    expect(model.notes).toContainEqual({
      labelKey: 'codex_quota.speed_label',
      valueKey: 'codex_quota.ultrafast',
    });
    const credit = model.notes.find((note) => note.labelKey === 'codex_quota.credit_balance_label');
    expect(credit?.value?.replace(/\D/g, '')).toBe('62332');
  });

  test('a weekly-only plan explains the missing 5-hour column instead of "not reported"', () => {
    const model = buildQuotaRowModel('codex', codex({ planType: 'pro' }));
    expect(model.absentLabelKeys).toEqual({
      'codex_quota.primary_window': 'codex_quota.no_five_hour_limit',
    });
    const team = buildQuotaRowModel(
      'codex',
      codex({
        planType: 'team',
        creditBalance: '0',
        windows: [
          { ...weekly, id: 'five-hour', labelKey: 'codex_quota.primary_window', periodHours: 5 },
          weekly,
        ],
      })
    );
    expect(team.absentLabelKeys).toEqual({});
    expect(team.notes.some((note) => note.labelKey === 'codex_quota.credit_balance_label')).toBe(
      false
    );
  });

  test('manual resets carry how many would apply now', () => {
    expect(buildQuotaRowModel('codex', codex({})).manualResets).toMatchObject({
      count: 2,
      applicable: 0,
    });
    expect(
      buildQuotaRowModel('codex', codex({ rateLimitResetCreditsApplicableAvailableCount: 1 }))
        .manualResets?.applicable
    ).toBe(1);
    expect(
      buildQuotaRowModel('codex', codex({ rateLimitResetCreditsApplicableAvailableCount: null }))
        .manualResets?.applicable
    ).toBeNull();
  });
});
