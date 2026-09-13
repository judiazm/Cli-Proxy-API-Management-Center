/**
 * Pools, derived rather than configured.
 *
 * The gateway has no concept of a named pool. What it has is a set of
 * credentials — each optionally carrying a model `prefix` — and a set of client
 * API keys, each optionally restricted to a list of `allowed-models` patterns.
 * A pool is what those two facts imply when read together: one provider family
 * at one prefix, the credentials that serve it, and the client keys whose
 * allowlist can actually reach it.
 *
 * A prefixed credential only answers requests for `<prefix>/<model>` and is
 * skipped for unprefixed ones, so `Codex` and `Codex · natacha/` are two pools
 * that happen to share a provider, not one pool with a label.
 *
 * Client reach is decided against a *sample* of each family's model IDs rather
 * than the live catalogue: what a key may reach is a property of its patterns,
 * and the sample below is taken from the proxy's own model registry. A key
 * restricted to a model outside the sample is the one case this can miss, which
 * is why the patterns that granted access are shown beside the keys.
 *
 * Pure and clock-free; `tests/poolsDerivation.test.ts` is the contract.
 */

import { normalizeProviderKey } from '@/features/authFiles/constants';
import { matchingPatterns, normalizeModelPatterns, patternsMatchAnyModel } from './matching';

/**
 * Representative model IDs per provider family, taken from the proxy's model
 * registry (`internal/registry/models/models.json`). Two or three per family is
 * enough: allowlists are written as family-wide globs (`gpt-*`, `claude-*`), and
 * a family not listed here falls back to its own key, which still answers what
 * `*` and `<family>*` ask.
 */
export const POOL_SAMPLE_MODEL_IDS: Record<string, readonly string[]> = {
  claude: ['claude-opus-4-8', 'claude-sonnet-4-6'],
  codex: ['gpt-6-astra', 'gpt-5.6-sol', 'codex-auto-review'],
  antigravity: ['gemini-3-flash', 'claude-sonnet-4-6'],
  gemini: ['gemini-2.5-pro', 'gemini-3-pro-preview'],
  aistudio: ['gemini-2.5-pro', 'gemini-3-pro-preview'],
  vertex: ['gemini-2.5-pro', 'gemini-3-pro'],
  xai: ['grok-4.6', 'grok-4.5'],
  kimi: ['kimi-k2', 'kimi-k2-thinking'],
};

/** Families first, in the order the rest of the app lists them. */
const FAMILY_ORDER = [
  'claude',
  'codex',
  'antigravity',
  'xai',
  'kimi',
  'gemini',
  'aistudio',
  'vertex',
  'qwen',
  'iflow',
];

/** How many leading characters stand in for a key that carries no label. */
const KEY_FINGERPRINT_LENGTH = 6;

export interface PoolCredential {
  /** Auth-file name — unique, and the key quota results are cached under. */
  name: string;
  family: string;
  /** Normalized prefix; empty for a credential that serves unprefixed models. */
  prefix: string;
  email: string;
  status: string;
  disabled: boolean;
}

export interface PoolClientKey {
  key: string;
  /** Comment or label the config carries for this key; empty when it has none. */
  label: string;
  /** Normalized allowlist patterns; empty means the key sees every model. */
  patterns: string[];
  /** True for a plain-string entry, which reaches every pool. */
  unrestricted: boolean;
}

export interface PoolClientGrant {
  client: PoolClientKey;
  /** Which of the key's patterns reach this pool; empty when unrestricted. */
  patterns: string[];
}

export interface DerivedPool {
  /** `family` or `family/prefix` — stable across reloads, used as the React key. */
  id: string;
  family: string;
  prefix: string;
  /** The IDs reach was tested against, prefixed when the pool is prefixed. */
  sampleModelIds: string[];
  members: PoolCredential[];
  clients: PoolClientGrant[];
  /** Union of the patterns that grant access, in config order. */
  patterns: string[];
}

export type UnreachableReason = 'disabled' | 'no_client';

export interface UnreachableCredential {
  credential: PoolCredential;
  reason: UnreachableReason;
}

export interface PoolsModel {
  pools: DerivedPool[];
  unreachable: UnreachableCredential[];
  credentialCount: number;
  clientKeyCount: number;
}

/**
 * `natacha`, `natacha/` and ` /natacha ` all name the same pool.
 *
 * The gateway stores the prefix without its separator and joins it on, so the
 * separator is normalized away here rather than splitting one pool into two
 * that differ only by punctuation.
 */
export const normalizePoolPrefix = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/^\/+/, '').replace(/\/+$/, '') : '';

export const poolId = (family: string, prefix: string): string =>
  prefix ? `${family}/${prefix}` : family;

/** Model IDs as a client would write them: `gpt-6-astra`, `natacha/gpt-6-astra`. */
export function poolSampleModelIds(family: string, prefix: string): string[] {
  const base = POOL_SAMPLE_MODEL_IDS[family] ?? [family];
  return prefix ? base.map((modelId) => `${prefix}/${modelId}`) : [...base];
}

/**
 * What to show instead of a key.
 *
 * Never the key itself: this page is read on shared screens and the whole key
 * is the credential. A label when the config carries one, otherwise just enough
 * of the key to tell two of them apart.
 */
export function describeClientKey(client: PoolClientKey): string {
  if (client.label) return client.label;
  const key = client.key.trim();
  if (!key) return '';
  return key.length <= KEY_FINGERPRINT_LENGTH ? key : `${key.slice(0, KEY_FINGERPRINT_LENGTH)}…`;
}

const familyRank = (family: string): number => {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
};

const comparePools = (left: DerivedPool, right: DerivedPool): number => {
  const rankDiff = familyRank(left.family) - familyRank(right.family);
  if (rankDiff !== 0) return rankDiff;
  const familyDiff = left.family.localeCompare(right.family);
  if (familyDiff !== 0) return familyDiff;
  // Unprefixed first: it is the pool a request reaches when it asks for nothing
  // special, and the prefixed ones are exceptions hanging off it.
  if (!left.prefix) return right.prefix ? -1 : 0;
  if (!right.prefix) return 1;
  return left.prefix.localeCompare(right.prefix);
};

/**
 * Group credentials into pools and attach the client keys that reach each one.
 *
 * Disabled credentials stay in their pool — a pool is a fact about
 * configuration, not about health — and are additionally reported as
 * unreachable so a credential that serves nothing cannot hide in a long list.
 */
export function derivePools(
  credentials: readonly PoolCredential[],
  clientKeys: readonly PoolClientKey[]
): PoolsModel {
  const byPool = new Map<string, DerivedPool>();

  credentials.forEach((credential) => {
    const id = poolId(credential.family, credential.prefix);
    const existing = byPool.get(id);
    if (existing) {
      existing.members.push(credential);
      return;
    }
    byPool.set(id, {
      id,
      family: credential.family,
      prefix: credential.prefix,
      sampleModelIds: poolSampleModelIds(credential.family, credential.prefix),
      members: [credential],
      clients: [],
      patterns: [],
    });
  });

  const pools = Array.from(byPool.values());

  pools.forEach((pool) => {
    pool.members.sort((left, right) => left.name.localeCompare(right.name));

    const patterns: string[] = [];
    const seenPatterns = new Set<string>();

    pool.clients = clientKeys.reduce<PoolClientGrant[]>((grants, client) => {
      if (client.unrestricted) {
        grants.push({ client, patterns: [] });
        return grants;
      }
      if (!patternsMatchAnyModel(client.patterns, pool.sampleModelIds)) return grants;

      const granting = matchingPatterns(client.patterns, pool.sampleModelIds);
      granting.forEach((pattern) => {
        if (seenPatterns.has(pattern)) return;
        seenPatterns.add(pattern);
        patterns.push(pattern);
      });
      grants.push({ client, patterns: granting });
      return grants;
    }, []);

    pool.patterns = patterns;
  });

  pools.sort(comparePools);

  const unreachable: UnreachableCredential[] = [];
  pools.forEach((pool) => {
    const poolHasNoClient = pool.clients.length === 0;
    pool.members.forEach((credential) => {
      if (credential.disabled) {
        unreachable.push({ credential, reason: 'disabled' });
        return;
      }
      if (poolHasNoClient) {
        unreachable.push({ credential, reason: 'no_client' });
      }
    });
  });

  return {
    pools,
    unreachable,
    credentialCount: credentials.length,
    clientKeyCount: clientKeys.length,
  };
}

/** Read one management `api-keys` entry into the shape the page reasons about. */
export function toPoolClientKey(
  key: string,
  label: string,
  allowedModels: readonly unknown[]
): PoolClientKey {
  const patterns = normalizeModelPatterns(allowedModels);
  return {
    key,
    label: label.trim(),
    patterns,
    unrestricted: patterns.length === 0,
  };
}

export interface PoolCredentialSource {
  name?: unknown;
  type?: unknown;
  provider?: unknown;
  email?: unknown;
  status?: unknown;
  disabled?: unknown;
}

/** Normalize one auth-file list entry, plus its prefix, into a pool member. */
export function toPoolCredential(file: PoolCredentialSource, prefix: string): PoolCredential {
  const rawFamily = String(file.type ?? file.provider ?? '');
  return {
    name: typeof file.name === 'string' ? file.name : '',
    family: normalizeProviderKey(rawFamily) || 'unknown',
    prefix: normalizePoolPrefix(prefix),
    email: typeof file.email === 'string' ? file.email.trim() : '',
    status: typeof file.status === 'string' ? file.status.trim() : '',
    disabled: file.disabled === true,
  };
}
