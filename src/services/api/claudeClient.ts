import { apiClient } from './client';
import { usageStoreApi } from './usageStore';
import { CLAUDE_CLI_BASELINE_VERSION, CLAUDE_REQUEST_HEADERS } from '@/utils/quota/constants';

// Anthropic offers reset grants only to recent Claude Code versions, so the dashboard
// presents the newest claude-cli version the pool has seen from real clients rather than a
// pinned one that ages out.
const AGENT_TTL_MS = 30 * 60 * 1000;
const CLI_VERSION_RE = /^claude-cli\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/;
let agentCache: { revision: number; at: number; value: Promise<string> } | null = null;

const parseVersion = (userAgent: string): [number, number, number] | null => {
  const match = CLI_VERSION_RE.exec(userAgent.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** Newest plausible claude-cli version in recent Claude requests, never below the baseline. */
export function newestClaudeCliUserAgent(userAgents: readonly string[]): string {
  const baseline = parseVersion(`claude-cli/${CLAUDE_CLI_BASELINE_VERSION}`) as [number, number, number];
  let best = baseline;
  for (const userAgent of userAgents) {
    const version = parseVersion(userAgent);
    // Same major and minor as the baseline and a bounded patch jump: a client cannot push an
    // implausible version into every Anthropic call.
    if (
      version &&
      version[0] === baseline[0] &&
      version[1] === baseline[1] &&
      version[2] > best[2] &&
      version[2] <= baseline[2] + 500
    )
      best = version;
  }
  return `claude-cli/${best.join('.')} (external, cli)`;
}

export function claudeCliUserAgent(): Promise<string> {
  const revision = apiClient.getConnectionRevision();
  const now = Date.now();
  if (agentCache && agentCache.revision === revision && now - agentCache.at < AGENT_TTL_MS)
    return agentCache.value;
  const value = usageStoreApi
    .getRequests({ limit: 200, filters: { provider: ['claude'] } })
    .then(
      (response) => newestClaudeCliUserAgent(response.rows.map((row) => row.user_agent)),
      () => newestClaudeCliUserAgent([])
    );
  agentCache = { revision, at: now, value };
  return value;
}

export async function claudeRequestHeaders(): Promise<Record<string, string>> {
  return { ...CLAUDE_REQUEST_HEADERS, 'User-Agent': await claudeCliUserAgent() };
}

// Anthropic throttles the OAuth usage and profile reads per account. Like Claude Code, remember
// a 429 for its Retry-After (5 minutes when absent, at most an hour) and do not ask again.
const THROTTLE_DEFAULT_MS = 5 * 60 * 1000;
const THROTTLE_MAX_MS = 60 * 60 * 1000;
const throttledUntil = new Map<string, number>();
const throttleKey = (authIndex: string) => `${apiClient.getConnectionRevision()}:${authIndex}`;

export function claudeReadThrottledUntil(authIndex: string, now = Date.now()): number | null {
  const until = throttledUntil.get(throttleKey(authIndex));
  return until !== undefined && until > now ? until : null;
}

export function noteClaudeReadThrottle(
  authIndex: string,
  header: Record<string, string[]> | undefined,
  now = Date.now()
): void {
  const raw = Object.entries(header ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1]?.[0];
  const seconds = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  const delay = seconds > 0 ? Math.min(seconds * 1000, THROTTLE_MAX_MS) : THROTTLE_DEFAULT_MS;
  throttledUntil.set(throttleKey(authIndex), now + delay);
}

/** Test hook: forget the learned version and remembered throttles. */
export function resetClaudeClientState(): void {
  agentCache = null;
  throttledUntil.clear();
}
