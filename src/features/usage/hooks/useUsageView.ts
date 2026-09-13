/**
 * The view state, bound to the URL.
 *
 * `useSearchParams` is the store; there is no second copy in React state, so
 * the back button, a pasted link and a control click all go through one path
 * and cannot disagree. Updates replace the history entry rather than pushing
 * one, except when the tab changes: a reader who ticks four filters in a row
 * should not have to press back four times to leave, but moving between tabs
 * is a navigation and behaves like one.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  hasUsageViewParams,
  readStoredUsageView,
  readUsageViewState,
  writeStoredUsageView,
  writeUsageViewParams,
  type UsageViewState,
} from '../logic/viewState';

export interface UsageViewController {
  view: UsageViewState;
  /** Replace the view. A function receives the current state. */
  setView: (next: UsageViewState | ((current: UsageViewState) => UsageViewState)) => void;
  /** Patch a few fields, leaving the rest alone. */
  patchView: (patch: Partial<UsageViewState>) => void;
  /** The current view as a query string, for the shareable-link affordance. */
  searchString: string;
}

export function useUsageView(): UsageViewController {
  const [searchParams, setSearchParams] = useSearchParams();

  const view = useMemo(() => readUsageViewState(searchParams), [searchParams]);

  // On the first render of a session with a bare URL, restore what was last
  // looked at. Guarded by a ref rather than by comparing state, so a reader who
  // deliberately clears every filter is not handed their old view back.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (hasUsageViewParams(searchParams)) return;

    const stored = readStoredUsageView();
    if (!stored) return;
    const restored = writeUsageViewParams(stored);
    if (restored.toString()) setSearchParams(restored, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    writeStoredUsageView(view);
  }, [view]);

  const setView = useCallback(
    (next: UsageViewState | ((current: UsageViewState) => UsageViewState)) => {
      setSearchParams(
        (current) => {
          const currentView = readUsageViewState(current);
          const nextView = typeof next === 'function' ? next(currentView) : next;
          return writeUsageViewParams(nextView);
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const patchView = useCallback(
    (patch: Partial<UsageViewState>) => {
      const isNavigation = patch.tab !== undefined;
      setSearchParams(
        (current) => {
          const currentView = readUsageViewState(current);
          return writeUsageViewParams({ ...currentView, ...patch });
        },
        { replace: !isNavigation }
      );
    },
    [setSearchParams]
  );

  const searchString = useMemo(() => writeUsageViewParams(view).toString(), [view]);

  return { view, setView, patchView, searchString };
}
