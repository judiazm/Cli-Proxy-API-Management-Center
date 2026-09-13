/**
 * 额度提供商数据层契约。
 *
 * data.ts 模块只做「取数 + 状态构造」：不 import React、不 import SCSS，
 * 因此可以被 bun:test 纯逻辑测试直接消费。渲染由同目录的 *QuotaBody 组件承担。
 */

import type { TFunction } from 'i18next';
import type { QuotaProviderFamily } from '@/utils/quota';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  XaiQuotaState,
} from '@/types';

export type QuotaUpdater<T> = T | ((prev: T) => T);

/**
 * Alias of the family union declared in `@/utils/quota` — the row model and the
 * family summary are pure helpers that sit below this feature, so the union
 * lives there and this is the feature-local name for it.
 */
export type QuotaProviderType = QuotaProviderFamily;

/** useQuotaStore 的结构契约（storeSelector/storeSetter 依赖）。 */
export interface QuotaStore {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  devinQuota: Record<string, DevinQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setDevinQuota: (updater: QuotaUpdater<Record<string, DevinQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  clearQuotaCache: () => void;
}

export interface QuotaProviderData<TState, TData> {
  type: QuotaProviderType;
  i18nPrefix: string;
  filterFn: (file: AuthFileItem) => boolean;
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  canResetQuota?: (quota: TState) => boolean;
  storeSelector: (state: QuotaStore) => Record<string, TState>;
  storeSetter: keyof QuotaStore;
  buildLoadingState: () => TState;
  buildSuccessState: (data: TData) => TState;
  buildErrorState: (message: string, status?: number) => TState;
}
