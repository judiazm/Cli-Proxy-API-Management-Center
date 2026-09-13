/**
 * The allowlist matcher, which decides which client keys reach which pool.
 *
 * It has to agree with the gateway's `util.MatchWildcard`, because a key the
 * page shows beside a pool is a claim about what the proxy will actually serve.
 * The prefix cases are the ones that matter most: `gpt-*` and `natacha/gpt-*`
 * look interchangeable and are not.
 */

import { describe, expect, test } from 'bun:test';
import {
  matchesModelPattern,
  matchingPatterns,
  normalizeModelPatterns,
  patternsMatchAnyModel,
} from '@/features/pools/matching';

describe('matchesModelPattern', () => {
  test('a pattern without a wildcard has to equal the whole model ID', () => {
    expect(matchesModelPattern('gpt-6-astra', 'gpt-6-astra')).toBe(true);
    expect(matchesModelPattern('gpt-6', 'gpt-6-astra')).toBe(false);
  });

  test('* matches any run of characters, including none', () => {
    expect(matchesModelPattern('gpt-*', 'gpt-6-astra')).toBe(true);
    expect(matchesModelPattern('gpt-*', 'gpt-')).toBe(true);
    expect(matchesModelPattern('*', 'anything-at-all')).toBe(true);
    expect(matchesModelPattern('*astra', 'gpt-6-astra')).toBe(true);
  });

  test('matching is case-insensitive on both sides', () => {
    expect(matchesModelPattern('GPT-*', 'gpt-6-astra')).toBe(true);
    expect(matchesModelPattern('gpt-*', 'GPT-6-ASTRA')).toBe(true);
  });

  test('middle segments are consumed left to right', () => {
    expect(matchesModelPattern('gpt-*-*-sol', 'gpt-5-6-sol')).toBe(true);
    expect(matchesModelPattern('gpt-*sol*terra', 'gpt-5.6-terra-sol')).toBe(false);
  });

  test('a credential prefix is part of the ID, so an unprefixed pattern misses it', () => {
    expect(matchesModelPattern('gpt-*', 'natacha/gpt-6-astra')).toBe(false);
    expect(matchesModelPattern('natacha/*', 'natacha/gpt-6-astra')).toBe(true);
    expect(matchesModelPattern('natacha/*', 'gpt-6-astra')).toBe(false);
    expect(matchesModelPattern('*', 'natacha/gpt-6-astra')).toBe(true);
  });

  test('an empty pattern matches nothing', () => {
    expect(matchesModelPattern('', 'gpt-6-astra')).toBe(false);
    expect(matchesModelPattern('   ', 'gpt-6-astra')).toBe(false);
  });
});

describe('normalizeModelPatterns', () => {
  test('trims, lower-cases, drops blanks and de-duplicates', () => {
    expect(normalizeModelPatterns([' GPT-* ', 'gpt-*', '', '  ', 'claude-*'])).toEqual([
      'gpt-*',
      'claude-*',
    ]);
  });

  test('non-arrays and non-strings are ignored rather than throwing', () => {
    expect(normalizeModelPatterns(undefined)).toEqual([]);
    expect(normalizeModelPatterns([null, 7, {}, 'gpt-*'] as unknown[])).toEqual(['gpt-*']);
  });
});

describe('pattern sets', () => {
  const patterns = ['gpt-*', 'natacha/*'];

  test('a key reaches a pool when any pattern matches any of its model IDs', () => {
    expect(patternsMatchAnyModel(patterns, ['claude-opus-4-8', 'gpt-6-astra'])).toBe(true);
    expect(patternsMatchAnyModel(['claude-*'], ['gpt-6-astra', 'codex-auto-review'])).toBe(false);
  });

  test('the granting patterns come back in the order they were configured', () => {
    expect(matchingPatterns(patterns, ['gpt-6-astra', 'natacha/gpt-6-astra'])).toEqual([
      'gpt-*',
      'natacha/*',
    ]);
    expect(matchingPatterns(patterns, ['natacha/gpt-6-astra'])).toEqual(['natacha/*']);
  });
});
