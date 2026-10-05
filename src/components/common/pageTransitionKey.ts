import type { Location } from 'react-router-dom';

/**
 * Layer identity for a location.
 *
 * Navigations the router did not create itself (a hand-edited hash, or
 * back/forward onto one) all arrive with `key: 'default'`. Keyed on that alone,
 * the second such navigation matched the current layer and was dropped: the
 * sidebar moved, the page did not. Those locations take a path-derived key.
 */
export const resolveLayerKey = (location: Pick<Location, 'key' | 'pathname'>): string =>
  location.key && location.key !== 'default' ? location.key : `default:${location.pathname}`;
