/**
 * The time zone every timestamp in the panel is shown in.
 *
 * The proxy's operator works in Miami, while the proxy host logs in UTC and a
 * browser may run anywhere, so "local time" was three different clocks. The
 * panel now defaults to America/New_York for every rendered timestamp and
 * labels it (EDT/EST). The choice persists per browser and can be switched to
 * UTC or the device's own zone.
 *
 * Most of the panel formats dates through `toLocaleString` and
 * `Intl.DateTimeFormat`, including upstream code this fork does not own.
 * `installDisplayTimeZone` makes those calls default to the chosen zone when
 * the caller did not name one, so upstream merges stay covered without editing
 * every call site. Date arithmetic (`getHours`, `setDate`) is unaffected and
 * keeps following the device zone; grid bucketing that matters goes through
 * `zonedDateParts` instead.
 */

export const DISPLAY_TIME_ZONE_STORAGE_KEY = 'cpamc.displayTimeZone';
export const DEFAULT_DISPLAY_TIME_ZONE = 'America/New_York';

/** `local` means the device's own zone (no injected `timeZone`). */
export type DisplayTimeZoneChoice = 'America/New_York' | 'UTC' | 'local';

export const DISPLAY_TIME_ZONE_CHOICES: readonly DisplayTimeZoneChoice[] = [
  'America/New_York',
  'UTC',
  'local',
];

const isChoice = (value: unknown): value is DisplayTimeZoneChoice =>
  typeof value === 'string' && (DISPLAY_TIME_ZONE_CHOICES as readonly string[]).includes(value);

export function readStoredDisplayTimeZone(
  storage: Pick<Storage, 'getItem'> | null = safeStorage()
): DisplayTimeZoneChoice {
  try {
    const raw = storage?.getItem(DISPLAY_TIME_ZONE_STORAGE_KEY);
    if (isChoice(raw)) return raw;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  return DEFAULT_DISPLAY_TIME_ZONE;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let currentChoice: DisplayTimeZoneChoice = readStoredDisplayTimeZone();
const listeners = new Set<(choice: DisplayTimeZoneChoice) => void>();

export function getDisplayTimeZoneChoice(): DisplayTimeZoneChoice {
  return currentChoice;
}

/** IANA zone injected into formatters, or undefined for the device zone. */
export function getDisplayTimeZone(): string | undefined {
  return currentChoice === 'local' ? undefined : currentChoice;
}

export function setDisplayTimeZone(choice: DisplayTimeZoneChoice): void {
  if (!isChoice(choice) || choice === currentChoice) return;
  currentChoice = choice;
  try {
    safeStorage()?.setItem(DISPLAY_TIME_ZONE_STORAGE_KEY, choice);
  } catch {
    // The choice still applies for this page load.
  }
  listeners.forEach((listener) => listener(choice));
}

export function subscribeDisplayTimeZone(
  listener: (choice: DisplayTimeZoneChoice) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: set the zone without touching storage or listeners. */
export function __setDisplayTimeZoneForTests(choice: DisplayTimeZoneChoice): void {
  currentChoice = choice;
}

let installed = false;
let nativeDateTimeFormat: typeof Intl.DateTimeFormat | null = null;
let restoreNatives: (() => void) | null = null;

const withZone = <T extends Intl.DateTimeFormatOptions | undefined>(
  options: T
): Intl.DateTimeFormatOptions | undefined => {
  const zone = getDisplayTimeZone();
  if (!zone) return options;
  if (options && options.timeZone) return options;
  return { ...(options ?? {}), timeZone: zone };
};

/**
 * Route default-zone formatting through the display zone. Idempotent; call
 * once before the app renders.
 */
export function installDisplayTimeZone(): void {
  if (installed) return;
  installed = true;

  const NativeDTF = Intl.DateTimeFormat;
  nativeDateTimeFormat = NativeDTF;
  const PatchedDTF = function (
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) {
    return new NativeDTF(locales, withZone(options));
  } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(PatchedDTF, 'prototype', { value: NativeDTF.prototype });
  Object.defineProperty(PatchedDTF, 'supportedLocalesOf', {
    value: NativeDTF.supportedLocalesOf.bind(NativeDTF),
  });
  Intl.DateTimeFormat = PatchedDTF;

  const proto = Date.prototype;
  const nativeToLocaleString = proto.toLocaleString;
  const nativeToLocaleDateString = proto.toLocaleDateString;
  const nativeToLocaleTimeString = proto.toLocaleTimeString;
  proto.toLocaleString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) {
    return nativeToLocaleString.call(this, locales, withZone(options));
  };
  proto.toLocaleDateString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) {
    return nativeToLocaleDateString.call(this, locales, withZone(options));
  };
  proto.toLocaleTimeString = function (
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions
  ) {
    return nativeToLocaleTimeString.call(this, locales, withZone(options));
  };

  restoreNatives = () => {
    Intl.DateTimeFormat = NativeDTF;
    proto.toLocaleString = nativeToLocaleString;
    proto.toLocaleDateString = nativeToLocaleDateString;
    proto.toLocaleTimeString = nativeToLocaleTimeString;
  };
}

/** Test seam: undo `installDisplayTimeZone` so other suites see native formatting. */
export function __uninstallDisplayTimeZoneForTests(): void {
  restoreNatives?.();
  restoreNatives = null;
  nativeDateTimeFormat = null;
  installed = false;
}

function formatterCtor(): typeof Intl.DateTimeFormat {
  return nativeDateTimeFormat ?? Intl.DateTimeFormat;
}

/**
 * Short zone name for an instant in the display zone: `EDT`, `EST`, `UTC`, or
 * a `GMT-5`-style offset where the runtime has no abbreviation.
 */
export function displayZoneAbbreviation(at: Date | number = new Date()): string {
  const date = typeof at === 'number' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new (formatterCtor())('en-US', {
      timeZone: getDisplayTimeZone(),
      timeZoneName: 'short',
      hour: 'numeric',
    }).formatToParts(date);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    return name === 'GMT' && getDisplayTimeZone() === 'UTC' ? 'UTC' : name;
  } catch {
    return '';
  }
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Calendar fields of an instant in the display zone. */
export function zonedDateParts(at: Date | number): ZonedDateParts {
  const date = typeof at === 'number' ? new Date(at) : at;
  const parts = new (formatterCtor())('en-US', {
    timeZone: getDisplayTimeZone(),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour') % 24,
    minute: value('minute'),
    second: value('second'),
    weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
  };
}

/**
 * The proxy writes its log in the host's zone without an offset. The Vostro
 * host runs on UTC, so `2026-10-05 17:45:37` is parsed as UTC.
 */
export function parseServerLogTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  const result = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms
  );
  return Number.isFinite(result) ? result : null;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `13:45:37` in the display zone. */
export function formatClockTime(ms: number, withSeconds = true): string {
  const parts = zonedDateParts(ms);
  const base = `${pad(parts.hour)}:${pad(parts.minute)}`;
  return withSeconds ? `${base}:${pad(parts.second)}` : base;
}

/** `10/05 13:45:37 EDT` in the display zone. */
export function formatLogInstant(ms: number): string {
  const parts = zonedDateParts(ms);
  return `${pad(parts.month)}/${pad(parts.day)} ${formatClockTime(ms)} ${displayZoneAbbreviation(ms)}`.trim();
}
