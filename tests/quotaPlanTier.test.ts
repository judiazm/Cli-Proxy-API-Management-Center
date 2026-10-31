import { describe, expect, test } from 'bun:test';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import { resolvePlanTier } from '@/utils/quota';
import vi from '@/i18n/locales/vi.json';
import ko from '@/i18n/locales/ko.json';
import tr from '@/i18n/locales/tr.json';
import { claudePlanBadge, codexPlanBadge } from '@/utils/quota/rowModel';

describe('Codex Pro display names', () => {
  for (const [locale, messages] of Object.entries({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    test(`${locale} labels Pro plans as Pro 100 and Pro 200`, () => {
      expect(messages.codex_quota.plan_prolite).toBe('Pro 100');
      expect(messages.codex_quota.plan_pro).toBe('Pro 200');
    });
  }

  for (const [locale, messages] of Object.entries({
    en,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ru,
    vi,
    ko,
    tr,
  })) {
    test(`${locale} labels Pro Max as Pro 500`, () => {
      expect(messages.codex_quota.plan_promax).toBe('Pro 500');
    });
  }
});

describe('resolvePlanTier', () => {
  test('Pro 500 and Pro 200 keep the fork elite finish, including Pro 500 aliases', () => {
    expect(resolvePlanTier('promax')).toBe('elite');
    expect(resolvePlanTier('  ProMax  ')).toBe('elite');
    expect(resolvePlanTier('pro-max')).toBe('elite');
    expect(resolvePlanTier('pro_max')).toBe('elite');
  });

  test('Pro 100 keeps the premium tier while Pro 200 stays elite', () => {
    expect(resolvePlanTier('pro')).toBe('elite');
    expect(resolvePlanTier('  PRO  ')).toBe('elite');
    expect(resolvePlanTier('prolite')).toBe('premium');
    expect(resolvePlanTier('Pro-Lite')).toBe('premium');
    expect(resolvePlanTier('pro_lite')).toBe('premium');
  });

  test('Business Premium retains the fork premium badge; other business plans stay plain', () => {
    expect(resolvePlanTier('self_serve_business_prolite')).toBe('premium');
    expect(resolvePlanTier('  SELF_SERVE_BUSINESS_PROLITE  ')).toBe('premium');
    expect(resolvePlanTier('self_serve_business_usage_based')).toBe('plain');
  });

  test('maps ordinary and unknown plans to plain', () => {
    expect(resolvePlanTier('plus')).toBe('plain');
    expect(resolvePlanTier('team')).toBe('plain');
    expect(resolvePlanTier('free')).toBe('plain');
    expect(resolvePlanTier('enterprise')).toBe('plain');
  });

  test('maps missing values to plain', () => {
    expect(resolvePlanTier(null)).toBe('plain');
    expect(resolvePlanTier(undefined)).toBe('plain');
    expect(resolvePlanTier('')).toBe('plain');
    expect(resolvePlanTier('   ')).toBe('plain');
  });
});

describe('Codex Pro 500 (plan=promax)', () => {
  test('shares the top finish with Pro 200 and gets its own label', () => {
    expect(resolvePlanTier('promax')).toBe('elite');
    expect(resolvePlanTier('ProMax')).toBe('elite');
    expect(codexPlanBadge('promax')).toEqual({
      labelKey: 'codex_quota.plan_promax',
      tier: 'elite',
    });
    expect(codexPlanBadge('pro')).toEqual({ labelKey: 'codex_quota.plan_pro', tier: 'elite' });
  });

  for (const [locale, messages] of Object.entries({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    test(`${locale} labels promax as Pro 500`, () => {
      expect(messages.codex_quota.plan_promax).toBe('Pro 500');
    });
  }
});

test('Claude Max 20x takes the top finish, Max 5x the gold one, other plans stay plain', () => {
  expect(claudePlanBadge('plan_max20')).toEqual({
    labelKey: 'claude_quota.plan_max20',
    tier: 'elite',
  });
  expect(claudePlanBadge('plan_max5')?.tier).toBe('premium');
  expect(claudePlanBadge('plan_pro')?.tier).toBe('plain');
  expect(claudePlanBadge('plan_team')?.tier).toBe('plain');
  expect(claudePlanBadge(null)).toBeNull();
});
