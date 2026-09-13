/**
 * Wildcard matching for the per-API-key `allowed-models` lists.
 *
 * A port of the gateway's own matcher — `util.MatchWildcard` plus the
 * `config.NormalizeExcludedModels` pass every pattern goes through at config
 * load time — so this page describes the reach a key actually has instead of a
 * second, nearly identical guess at it:
 *
 * - patterns and model IDs are trimmed and lower-cased before comparison;
 * - `*` matches any run of characters, including none;
 * - a pattern without `*` has to equal the whole ID, not merely start it;
 * - an empty pattern matches nothing.
 *
 * Pure and dependency-free; `tests/poolsMatching.test.ts` is the contract.
 */

/** Trim, lower-case and de-duplicate patterns, dropping empty ones. */
export function normalizeModelPatterns(patterns: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(patterns)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  patterns.forEach((pattern) => {
    if (typeof pattern !== 'string') return;
    const trimmed = pattern.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized;
}

/**
 * Whether one pattern matches one model ID.
 *
 * The segment walk mirrors the Go implementation: anchor the prefix, anchor the
 * suffix, then consume the middle segments left to right. Consuming middles in
 * order is what makes `a*b*c` behave here exactly as it does in the proxy.
 */
export function matchesModelPattern(pattern: string, modelId: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;

  let value = modelId.trim().toLowerCase();
  if (!normalizedPattern.includes('*')) return normalizedPattern === value;

  const parts = normalizedPattern.split('*');

  const prefix = parts[0];
  if (prefix) {
    if (!value.startsWith(prefix)) return false;
    value = value.slice(prefix.length);
  }

  const suffix = parts[parts.length - 1];
  if (suffix) {
    if (!value.endsWith(suffix)) return false;
    value = value.slice(0, value.length - suffix.length);
  }

  for (let index = 1; index < parts.length - 1; index += 1) {
    const segment = parts[index];
    if (!segment) continue;
    const found = value.indexOf(segment);
    if (found < 0) return false;
    value = value.slice(found + segment.length);
  }

  return true;
}

/** Whether any pattern matches any of the model IDs. */
export function patternsMatchAnyModel(
  patterns: readonly string[],
  modelIds: readonly string[]
): boolean {
  return patterns.some((pattern) =>
    modelIds.some((modelId) => matchesModelPattern(pattern, modelId))
  );
}

/** The patterns that matched at least one model ID, in the order given. */
export function matchingPatterns(
  patterns: readonly string[],
  modelIds: readonly string[]
): string[] {
  return patterns.filter((pattern) =>
    modelIds.some((modelId) => matchesModelPattern(pattern, modelId))
  );
}
