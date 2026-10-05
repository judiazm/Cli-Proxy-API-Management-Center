import { describe, expect, test } from 'bun:test';
import { resolveLayerKey } from '@/components/common/pageTransitionKey';

describe('page transition layer identity', () => {
  test('router-created navigations keep their own key', () => {
    expect(resolveLayerKey({ key: 'k1abc', pathname: '/usage' })).toBe('k1abc');
  });

  test('hand-edited hashes (key "default") stay distinct per page', () => {
    const quota = resolveLayerKey({ key: 'default', pathname: '/quota' });
    const usage = resolveLayerKey({ key: 'default', pathname: '/usage' });
    expect(quota).not.toBe(usage);
    expect(resolveLayerKey({ key: 'default', pathname: '/usage' })).toBe(usage);
  });
});
