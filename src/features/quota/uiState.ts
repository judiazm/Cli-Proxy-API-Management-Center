import {
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/**
 * Whether credential e-mail addresses are shown in full.
 *
 * Kept in localStorage rather than beside the session preferences above: this
 * one is about who can see the screen, not about where you were in the page,
 * and having it silently re-mask on every new tab would train people to ignore
 * the toggle. Masked is the default — a fresh browser reveals nothing.
 */
const QUOTA_SHOW_EMAILS_KEY = 'quotaPage.showEmails';

export const readQuotaShowEmails = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(QUOTA_SHOW_EMAILS_KEY) === '1';
  } catch {
    return false;
  }
};

export const writeQuotaShowEmails = (value: boolean) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUOTA_SHOW_EMAILS_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
};
