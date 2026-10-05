/**
 * One row per proxied request, assembled from the log.
 *
 * The proxy writes several lines per request, all tagged with the trailing 8
 * characters of its UUIDv7 request id: routing lines (`auth=… provider=…
 * model=…`) while it picks a credential, warnings when it retries or a
 * credential cools down, and finally the gin access line with status, latency,
 * client IP and path. Reading those lines one by one answers "what did the
 * server print"; this answers "what happened to that request".
 *
 * The usage store keeps the same request under its full id, so a row joins to
 * its stored record by suffix: account, client key, model and alias, speed
 * tier, time to first token and tokens. Rows without a stored record (errors
 * before routing, health checks) still show what the log knows.
 *
 * Pure: no React, no clock except what is passed in.
 */

import type { UsageRequestRow } from '@/services/api';
import { parseServerLogTimestamp } from '@/utils/time/displayZone';
import type { LogEntry } from './logSelectors';
import type { LogLevel } from './logTypes';

export const REQUEST_ID_PATTERN = /^[a-f0-9]{8}$/i;

/** First token later than this keeps Claude Code's "Waiting for API response" banner up. */
export const SLOW_FIRST_TOKEN_MS = 20_000;

const MAX_EVENTS_PER_REQUEST = 12;

export interface LogRequestEvent {
  atMs: number | null;
  level?: LogLevel;
  source?: string;
  message: string;
}

export interface LogRequestRecord {
  id: string;
  /** When the access line was written (request end), or the first line seen. */
  atMs: number | null;
  status: number | null;
  latencyMs: number | null;
  latencyText: string | null;
  method: string | null;
  path: string | null;
  ip: string | null;
  /** Credential named by the routing lines, when the log carried one. */
  auth: string | null;
  provider: string | null;
  model: string | null;
  events: LogRequestEvent[];
  hasWarn: boolean;
  hasError: boolean;
  /** A 429, a cooldown, or a quota message touched this request. */
  rateLimited: boolean;
  /** The access line has been seen; until then the request is in flight. */
  finished: boolean;
}

/** Go `time.Duration` strings as gin prints them: `851ms`, `18.825s`, `1m42s`, `1h2m3s`. */
export function parseLatencyMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  const units: Record<string, number> = {
    h: 3_600_000,
    m: 60_000,
    s: 1000,
    ms: 1,
    µs: 0.001,
    us: 0.001,
    ns: 0.000001,
  };
  const pattern = /(\d+(?:\.\d+)?)(h|ms|m|s|µs|us|ns)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    total += Number(match[1]) * units[match[2]];
    consumed += match[0].length;
  }
  return consumed === trimmed.length && consumed > 0 ? total : null;
}

const field = (message: string, name: string): string | null => {
  const match = message.match(new RegExp(`\\b${name}=([^\\s|,]+)`));
  if (!match) return null;
  const value = match[1].replace(/\.{3}$/, '');
  return value && value !== '-' ? value : null;
};

const RATE_LIMIT_TEXT = /\b(429|cooldown|cooling down|rate[ _-]?limit|quota)\b/i;

const isAccessLine = (entry: LogEntry): boolean =>
  typeof entry.statusCode === 'number' &&
  Boolean(entry.source?.startsWith('gin_logger')) &&
  Boolean(entry.method);

/**
 * Group log entries by request id, oldest first in, newest first out.
 * Lines without a real id (`--------`, management calls) are skipped.
 */
export function buildLogRequestRecords(entries: readonly LogEntry[]): LogRequestRecord[] {
  const byId = new Map<string, LogRequestRecord>();
  for (const entry of entries) {
    const id = entry.requestId;
    if (!id || !REQUEST_ID_PATTERN.test(id)) continue;
    const atMs = parseServerLogTimestamp(entry.timestamp);
    let record = byId.get(id);
    if (!record) {
      record = {
        id,
        atMs,
        status: null,
        latencyMs: null,
        latencyText: null,
        method: null,
        path: null,
        ip: null,
        auth: null,
        provider: null,
        model: null,
        events: [],
        hasWarn: false,
        hasError: false,
        rateLimited: false,
        finished: false,
      };
      byId.set(id, record);
    }

    if (isAccessLine(entry)) {
      record.finished = true;
      record.atMs = atMs ?? record.atMs;
      record.status = entry.statusCode ?? null;
      record.latencyText = entry.latency ?? null;
      record.latencyMs = parseLatencyMs(entry.latency);
      record.method = entry.method ?? null;
      record.path = entry.path ?? null;
      record.ip = entry.ip ?? null;
      if ((entry.statusCode ?? 0) === 429) record.rateLimited = true;
      if ((entry.statusCode ?? 0) >= 500) record.hasError = true;
      continue;
    }

    const message = entry.message || entry.raw;
    record.auth = field(message, 'auth') ?? field(message, 'auth_file') ?? record.auth;
    record.provider = field(message, 'provider') ?? record.provider;
    record.model = field(message, 'model') ?? record.model;
    if (entry.level === 'warn') record.hasWarn = true;
    if (entry.level === 'error' || entry.level === 'fatal') record.hasError = true;
    if (entry.level !== 'info' && entry.level !== 'debug' && RATE_LIMIT_TEXT.test(message)) {
      record.rateLimited = true;
    }
    if (record.events.length < MAX_EVENTS_PER_REQUEST) {
      record.events.push({ atMs, level: entry.level, source: entry.source, message });
    }
  }
  return [...byId.values()].sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
}

/** Usage rows by the 8-character suffix the log prints. */
export function indexUsageRowsByShortId(
  rows: readonly UsageRequestRow[]
): Map<string, UsageRequestRow> {
  const index = new Map<string, UsageRequestRow>();
  for (const row of rows) {
    const id = row.request_id?.trim() ?? '';
    if (id.length < 8) continue;
    const short = id.slice(-8).toLowerCase();
    // Newest wins if two rows ever shared a suffix.
    if (!index.has(short)) index.set(short, row);
  }
  return index;
}

/** Speed tier as people say it. `priority` is what Codex calls Fast. */
export function describeServiceTier(
  row: Pick<UsageRequestRow, 'service_tier' | 'response_service_tier'> | null | undefined
): 'ultrafast' | 'fast' | 'flex' | 'standard' | null {
  if (!row) return null;
  const tier = (row.response_service_tier || row.service_tier || '').trim().toLowerCase();
  if (!tier) return null;
  if (tier === 'ultrafast') return 'ultrafast';
  if (tier === 'priority' || tier === 'fast') return 'fast';
  if (tier === 'flex') return 'flex';
  return 'standard';
}

export type LogRequestStatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'pending';

export const statusClassOf = (status: number | null): LogRequestStatusClass => {
  if (status === null) return 'pending';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
};

export interface LogRequestJoined {
  record: LogRequestRecord;
  usage: UsageRequestRow | null;
  /** Credential file: stored record first, then the routing line. */
  authId: string | null;
  provider: string | null;
  model: string | null;
  alias: string | null;
  ttftMs: number | null;
  slowFirstToken: boolean;
  isError: boolean;
  /** Status from the access line, else from the stored record. */
  status: number | null;
  /**
   * Done when the access line was seen or the store already recorded the
   * request (the store writes at the final usage event, a moment before gin
   * writes its access line).
   */
  finished: boolean;
}

export function joinLogRequests(
  records: readonly LogRequestRecord[],
  usageByShortId: ReadonlyMap<string, UsageRequestRow>
): LogRequestJoined[] {
  return records.map((record) => {
    const usage = usageByShortId.get(record.id.toLowerCase()) ?? null;
    const ttftMs = usage && usage.ttft_ms > 0 ? usage.ttft_ms : null;
    // The store keeps status_code 0 for a successful stream; a stored request
    // that did not fail is a 200 even before its access line lands.
    const storedStatus = usage ? usage.status_code || (usage.failed ? null : 200) : null;
    const status = record.status ?? storedStatus;
    return {
      record,
      usage,
      authId: usage?.auth_id || record.auth,
      provider: usage?.provider || record.provider,
      model: usage?.model || record.model,
      alias: usage?.alias && usage.alias !== usage.model ? usage.alias : null,
      ttftMs,
      slowFirstToken: ttftMs !== null && ttftMs >= SLOW_FIRST_TOKEN_MS,
      isError: record.hasError || Boolean(usage?.failed) || (status !== null && status >= 400),
      status,
      finished: record.finished || usage !== null,
    };
  });
}

export interface LogRequestFilters {
  statusClasses: ReadonlySet<LogRequestStatusClass>;
  provider: string;
  account: string;
  model: string;
  errorsOnly: boolean;
  slowOnly: boolean;
  text: string;
}

export const EMPTY_LOG_REQUEST_FILTERS: LogRequestFilters = {
  statusClasses: new Set(),
  provider: '',
  account: '',
  model: '',
  errorsOnly: false,
  slowOnly: false,
  text: '',
};

export function filterLogRequests(
  rows: readonly LogRequestJoined[],
  filters: LogRequestFilters
): LogRequestJoined[] {
  const needle = filters.text.trim().toLowerCase();
  return rows.filter((row) => {
    const cls = row.finished ? statusClassOf(row.status) : 'pending';
    if (filters.statusClasses.size && !filters.statusClasses.has(cls)) {
      return false;
    }
    if (filters.provider && row.provider !== filters.provider) return false;
    if (filters.account && row.authId !== filters.account) return false;
    if (filters.model && row.model !== filters.model && row.alias !== filters.model) return false;
    if (filters.errorsOnly && !row.isError && !row.record.rateLimited) return false;
    if (filters.slowOnly && !row.slowFirstToken) return false;
    if (!needle) return true;
    const haystack = [
      row.record.id,
      row.record.path,
      row.record.ip,
      row.authId,
      row.model,
      row.alias,
      row.provider,
      ...row.record.events.map((event) => event.message),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** Distinct, sorted values of one field, for the filter menus. */
export function distinctValues(
  rows: readonly LogRequestJoined[],
  pick: (row: LogRequestJoined) => string | null | undefined
): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const value = pick(row);
    if (value) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}
