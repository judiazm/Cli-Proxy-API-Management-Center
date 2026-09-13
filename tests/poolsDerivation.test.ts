/**
 * Pools are derived, so the derivation is the feature.
 *
 * Three properties carry the page: a prefix splits a provider into two pools,
 * a key's allowlist decides which of them it reaches, and a credential nothing
 * can reach is reported rather than quietly listed as healthy.
 */

import { describe, expect, test } from 'bun:test';
import {
  derivePools,
  describeClientKey,
  normalizePoolPrefix,
  poolSampleModelIds,
  toPoolClientKey,
  toPoolCredential,
  type PoolCredential,
} from '@/features/pools/logic';

const credential = (overrides: Partial<PoolCredential> & { name: string }): PoolCredential => ({
  family: 'codex',
  prefix: '',
  email: '',
  status: 'active',
  disabled: false,
  ...overrides,
});

const openKey = toPoolClientKey('sk-plain-key-value', '', []);
const gptKey = toPoolClientKey('sk-gpt-key-value', '', ['gpt-*']);
const natachaKey = toPoolClientKey('sk-natacha-key-value', '', ['gpt-*', 'natacha/*']);
const claudeKey = toPoolClientKey('sk-claude-key-value', '', ['claude-*']);

describe('pool grouping', () => {
  test('a prefix splits one provider into two pools, unprefixed first', () => {
    const model = derivePools(
      [
        credential({ name: 'codex-b.json', prefix: 'natacha' }),
        credential({ name: 'codex-a.json' }),
        credential({ name: 'claude-a.json', family: 'claude' }),
      ],
      [openKey]
    );

    expect(model.pools.map((pool) => pool.id)).toEqual(['claude', 'codex', 'codex/natacha']);
    expect(model.pools[1].members.map((member) => member.name)).toEqual(['codex-a.json']);
    expect(model.pools[2].members.map((member) => member.name)).toEqual(['codex-b.json']);
  });

  test('the same prefix written with separators is one pool, not three', () => {
    expect(normalizePoolPrefix('natacha')).toBe('natacha');
    expect(normalizePoolPrefix('natacha/')).toBe('natacha');
    expect(normalizePoolPrefix(' /natacha ')).toBe('natacha');
    expect(normalizePoolPrefix(undefined)).toBe('');
  });

  test('a prefixed pool is tested against prefixed model IDs', () => {
    expect(poolSampleModelIds('codex', 'natacha').every((id) => id.startsWith('natacha/'))).toBe(
      true
    );
    expect(poolSampleModelIds('codex', '').some((id) => id.startsWith('gpt-'))).toBe(true);
  });
});

describe('client reach', () => {
  const credentials = [
    credential({ name: 'codex-a.json' }),
    credential({ name: 'codex-b.json', prefix: 'natacha' }),
    credential({ name: 'claude-a.json', family: 'claude' }),
  ];

  test('a plain-string key reaches every pool and grants no named pattern', () => {
    const model = derivePools(credentials, [openKey]);
    model.pools.forEach((pool) => {
      expect(pool.clients).toHaveLength(1);
      expect(pool.clients[0].client.unrestricted).toBe(true);
      expect(pool.patterns).toEqual([]);
    });
  });

  test('an allowlisted key reaches only the pools its patterns match', () => {
    const model = derivePools(credentials, [gptKey, natachaKey, claudeKey]);
    const byId = new Map(model.pools.map((pool) => [pool.id, pool]));

    const codex = byId.get('codex');
    expect(codex?.clients.map((grant) => grant.client.key)).toEqual([gptKey.key, natachaKey.key]);
    expect(codex?.patterns).toEqual(['gpt-*']);

    const prefixed = byId.get('codex/natacha');
    expect(prefixed?.clients.map((grant) => grant.client.key)).toEqual([natachaKey.key]);
    expect(prefixed?.patterns).toEqual(['natacha/*']);

    expect(byId.get('claude')?.clients.map((grant) => grant.client.key)).toEqual([claudeKey.key]);
  });
});

describe('unreachable credentials', () => {
  test('a pool no key matches, and a disabled credential, are both reported', () => {
    const model = derivePools(
      [
        credential({ name: 'codex-a.json' }),
        credential({ name: 'codex-disabled.json', disabled: true }),
        credential({ name: 'codex-b.json', prefix: 'cousin' }),
      ],
      [gptKey]
    );

    expect(model.unreachable).toEqual([
      { credential: expect.objectContaining({ name: 'codex-disabled.json' }), reason: 'disabled' },
      { credential: expect.objectContaining({ name: 'codex-b.json' }), reason: 'no_client' },
    ]);
    // The disabled credential still belongs to its pool: the pool is a fact
    // about configuration, not about health.
    expect(model.pools[0].members).toHaveLength(2);
  });

  test('everything is reachable when a key matches every pool', () => {
    const model = derivePools([credential({ name: 'codex-a.json' })], [openKey]);
    expect(model.unreachable).toEqual([]);
  });
});

describe('reading the backend shapes', () => {
  test('an auth-file entry plus its prefix becomes a pool member', () => {
    const member = toPoolCredential(
      {
        name: 'codex-0b6f7ea7-account.json',
        type: 'codex',
        email: ' account@example.org ',
        status: 'active',
        disabled: false,
      },
      'natacha/'
    );
    expect(member).toEqual({
      name: 'codex-0b6f7ea7-account.json',
      family: 'codex',
      prefix: 'natacha',
      email: 'account@example.org',
      status: 'active',
      disabled: false,
    });
  });

  test('a key is shown by its label, or by its first characters — never in full', () => {
    expect(describeClientKey(toPoolClientKey('sk-abcdef123456', 'Natacha laptop', []))).toBe(
      'Natacha laptop'
    );
    expect(describeClientKey(toPoolClientKey('sk-abcdef123456', '', ['gpt-*']))).toBe('sk-abc…');
  });
});
