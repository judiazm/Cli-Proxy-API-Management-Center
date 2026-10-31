import { normalizePlanType } from './parsers';

/**
 * Codex 套餐档位的纯映射（卡面档位见 features/quota/cardTier.ts）。
 *
 * - elite   → 液态铂金徽章（Pro 500，plan=promax；Pro 200，plan=pro）
 * - premium → 金卡徽章（Pro 100；Antigravity ultra / xAI paid 亦复用金卡类名）
 * - plain   → 普通文字徽章（plus/team/free/未知）
 */
export type CodexPlanTier = 'elite' | 'premium' | 'plain';

export const PREMIUM_CODEX_PLAN_TYPES = new Set([
  'promax',
  'pro',
  'prolite',
  'pro-lite',
  'pro_lite',
  'self_serve_business_prolite',
]);

// Pro 200 retains the fork's top badge finish.
export const ELITE_CODEX_PLAN_TYPE = 'pro';

/** Pro 100 的各种写法。 */
export const PRO_LITE_CODEX_PLAN_TYPES = new Set(['prolite', 'pro-lite', 'pro_lite']);

/** Pro 200。 */
export const PRO_CODEX_PLAN_TYPE = 'pro';

/** Pro 500 (plan=promax, OpenAI 2026-09-29) sits above Pro 200 and shares its finish. */
export const ELITE_CODEX_PLAN_TYPES = new Set([
  ELITE_CODEX_PLAN_TYPE,
  'promax',
  'pro-max',
  'pro_max',
]);

/**
 * 顺序敏感：'pro' 同时命中 PREMIUM_CODEX_PLAN_TYPES，elite 判断必须在最前，
 * 否则 Pro 200 会静默退回金卡。契约由 tests/quotaPlanTier.test.ts 守护。
 */
export function resolvePlanTier(planType: string | null | undefined): CodexPlanTier {
  const normalized = normalizePlanType(planType);
  if (!normalized) return 'plain';
  if (ELITE_CODEX_PLAN_TYPES.has(normalized)) return 'elite';
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized)) return 'premium';
  return 'plain';
}
