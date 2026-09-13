/**
 * 额度渲染层的类型化样式契约。
 *
 * 额度 body 在两个宿主穿不同外衣：额度页（QuotaBody.module.scss）与
 * 认证文件卡片（AuthFileQuota.module.scss）。宿主通过 bindQuotaClasses
 * 把自己的 CSS Module 绑定成 QuotaClassMap —— 缺任何一个类名会在模块
 * 初始化时抛错并列出缺失清单，替代旧字符串 styleMap 的静默 class="undefined"。
 */

export interface QuotaClassMap {
  // 额度行（五个提供商共用）
  quotaRow: string;
  quotaRowHeader: string;
  quotaModel: string;
  quotaMeta: string;
  quotaPercent: string;
  quotaReset: string;
  quotaResetRelative: string;
  quotaResetRelativeSoon: string;
  quotaAmount: string;
  quotaMessage: string;
  // 套餐 chip 行（codex 命名，claude/antigravity/kimi/xai 复用；
  // premium=金卡、elite=Pro 20x 液态铂金 —— 均为定稿资产，样式不可改）
  codexPlan: string;
  codexPlanItem: string;
  codexPlanLabel: string;
  codexPlanValue: string;
  premiumPlanValue: string;
  elitePlanValue: string;
  // Codex 重置积分
  codexResetCredits: string;
  codexResetCreditsTitle: string;
  codexResetCreditRow: string;
  codexResetCreditRowSoon: string;
  codexResetCreditLabel: string;
  codexResetCreditTime: string;
  codexResetCreditsError: string;
  // Antigravity 分组
  antigravityQuotaGroup: string;
  antigravityQuotaGroupHeader: string;
  antigravityQuotaGroupTitle: string;
  antigravityQuotaGroupDescription: string;
  // 水位条（QuotaMeter）
  quotaBar: string;
  quotaBarFill: string;
  quotaBarFillHigh: string;
  quotaBarFillMedium: string;
  quotaBarFillLow: string;
}

export const QUOTA_CLASS_KEYS: readonly (keyof QuotaClassMap)[] = [
  'quotaRow',
  'quotaRowHeader',
  'quotaModel',
  'quotaMeta',
  'quotaPercent',
  'quotaReset',
  'quotaResetRelative',
  'quotaResetRelativeSoon',
  'quotaAmount',
  'quotaMessage',
  'codexPlan',
  'codexPlanItem',
  'codexPlanLabel',
  'codexPlanValue',
  'premiumPlanValue',
  'elitePlanValue',
  'codexResetCredits',
  'codexResetCreditsTitle',
  'codexResetCreditRow',
  'codexResetCreditRowSoon',
  'codexResetCreditLabel',
  'codexResetCreditTime',
  'codexResetCreditsError',
  'antigravityQuotaGroup',
  'antigravityQuotaGroupHeader',
  'antigravityQuotaGroupTitle',
  'antigravityQuotaGroupDescription',
  'quotaBar',
  'quotaBarFill',
  'quotaBarFillHigh',
  'quotaBarFillMedium',
  'quotaBarFillLow',
];

/**
 * 宿主 CSS Module → 类型化契约。缺键即抛（fail-loud），`source` 用于报错定位。
 *
 * A CSS Module import is typed as an open string index, so nothing at compile
 * time says a host actually defines the class a component asks for. Binding an
 * explicit key list converts that into one loud failure at module init, with
 * every missing key named at once.
 */
export function bindClassMap<K extends string>(
  keys: readonly K[],
  module: Record<string, string>,
  source: string
): Record<K, string> {
  const missing = keys.filter((key) => !module[key]);
  if (missing.length > 0) {
    throw new Error(`[quota] ${source} 缺少额度契约类名: ${missing.join(', ')}`);
  }
  const bound = {} as Record<K, string>;
  for (const key of keys) {
    bound[key] = module[key];
  }
  return bound;
}

export function bindQuotaClasses(module: Record<string, string>, source: string): QuotaClassMap {
  return bindClassMap(QUOTA_CLASS_KEYS, module, source);
}

export interface QuotaBodyProps<TState> {
  quota: TState;
  classes: QuotaClassMap;
}
