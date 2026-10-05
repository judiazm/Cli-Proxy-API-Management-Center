/**
 * Display time zone: Miami by default, labelled, persisted, and applied to
 * default-zone formatting without touching explicit zones.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setDisplayTimeZoneForTests,
  __uninstallDisplayTimeZoneForTests,
  DEFAULT_DISPLAY_TIME_ZONE,
  displayZoneAbbreviation,
  formatLogInstant,
  installDisplayTimeZone,
  parseServerLogTimestamp,
  readStoredDisplayTimeZone,
  zonedDateParts,
} from '@/utils/time/displayZone';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';

afterEach(() => {
  __uninstallDisplayTimeZoneForTests();
  __setDisplayTimeZoneForTests('America/New_York');
});

const JULY = Date.UTC(2026, 9, 5, 17, 45, 37); // 2026-10-05 17:45:37Z, EDT
const JANUARY = Date.UTC(2026, 0, 15, 17, 0, 0); // EST

describe('display zone', () => {
  test('defaults to Miami when nothing is stored or storage is broken', () => {
    expect(DEFAULT_DISPLAY_TIME_ZONE).toBe('America/New_York');
    expect(readStoredDisplayTimeZone({ getItem: () => null })).toBe('America/New_York');
    expect(readStoredDisplayTimeZone({ getItem: () => 'Mars/Base' })).toBe('America/New_York');
    expect(
      readStoredDisplayTimeZone({
        getItem: () => {
          throw new Error('blocked');
        },
      })
    ).toBe('America/New_York');
    expect(readStoredDisplayTimeZone({ getItem: () => 'UTC' })).toBe('UTC');
  });

  test('names the zone with its daylight-saving abbreviation', () => {
    expect(displayZoneAbbreviation(JULY)).toBe('EDT');
    expect(displayZoneAbbreviation(JANUARY)).toBe('EST');
    expect(resolveTimeZoneLabel(new Date(JULY))).toBe('EDT');
    __setDisplayTimeZoneForTests('UTC');
    expect(displayZoneAbbreviation(JULY)).toBe('UTC');
  });

  test('reads calendar fields in the display zone', () => {
    expect(zonedDateParts(JULY)).toMatchObject({ month: 10, day: 5, hour: 13, minute: 45 });
    __setDisplayTimeZoneForTests('UTC');
    expect(zonedDateParts(JULY)).toMatchObject({ hour: 17, weekday: 1 });
  });

  test('server log timestamps are UTC and render in Miami time', () => {
    const ms = parseServerLogTimestamp('2026-10-05 17:45:37');
    expect(ms).toBe(JULY);
    expect(formatLogInstant(ms!)).toBe('10/05 13:45:37 EDT');
    expect(parseServerLogTimestamp('not a time')).toBeNull();
  });

  test('default-zone formatting follows the display zone; explicit zones win', () => {
    installDisplayTimeZone();
    const date = new Date(JULY);
    expect(date.toLocaleTimeString('en-US', { hour: 'numeric', hourCycle: 'h23' })).toBe('13');
    expect(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23' }).format(date)
    ).toBe('13');
    expect(
      date.toLocaleTimeString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'UTC' })
    ).toBe('17');
    __setDisplayTimeZoneForTests('UTC');
    expect(date.toLocaleTimeString('en-US', { hour: 'numeric', hourCycle: 'h23' })).toBe('17');
  });
});
