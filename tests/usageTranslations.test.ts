/**
 * The usage page's copy, in all four locales.
 *
 * Fallback is zh-CN, so a key missing from en.json does not render blank: it
 * renders in Chinese in an English UI, which reads as a bug in the wrong place.
 * Comparing the key sets catches that at the point it is introduced.
 */

import { describe, expect, test } from 'bun:test';
import en from '../src/i18n/locales/en.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const LOCALES = { en, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

const usageKeys = (locale: Record<string, unknown>): string[] =>
  Object.keys((locale.usage ?? {}) as Record<string, string>).sort();

describe('usage translations', () => {
  test('every locale carries the same usage keys', () => {
    const reference = usageKeys(en);
    expect(reference.length).toBeGreaterThan(100);

    Object.entries(LOCALES).forEach(([name, locale]) => {
      expect({ name, keys: usageKeys(locale as Record<string, unknown>) }).toEqual({
        name,
        keys: reference,
      });
    });
  });

  test('no usage string is left empty in any locale', () => {
    Object.entries(LOCALES).forEach(([name, locale]) => {
      const block = (locale as Record<string, unknown>).usage as Record<string, string>;
      Object.entries(block).forEach(([key, value]) => {
        expect(`${name}.${key}:${typeof value}`).toBe(`${name}.${key}:string`);
        expect(`${name}.${key}:${value.trim().length > 0}`).toBe(`${name}.${key}:true`);
      });
    });
  });

  test('the sidebar entry is translated everywhere, not only in English', () => {
    Object.entries(LOCALES).forEach(([name, locale]) => {
      const record = locale as Record<string, Record<string, string>>;
      expect(`${name}:${typeof record.nav.usage}`).toBe(`${name}:string`);
      expect(`${name}:${typeof record.nav_meta.usage}`).toBe(`${name}:string`);
    });

    // Distinct strings, so a copy-paste of the English is caught.
    const labels = Object.values(LOCALES).map(
      (locale) => (locale as Record<string, Record<string, string>>).nav.usage
    );
    expect(new Set(labels).size).toBeGreaterThan(1);
  });

  test('interpolation placeholders match across locales', () => {
    const placeholders = (value: string) =>
      (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((token) => token.replace(/\s/g, '')).sort();

    const reference = en.usage as Record<string, string>;
    Object.entries(LOCALES).forEach(([name, locale]) => {
      const block = (locale as Record<string, unknown>).usage as Record<string, string>;
      Object.entries(reference).forEach(([key, value]) => {
        expect({ name, key, tokens: placeholders(block[key]) }).toEqual({
          name,
          key,
          tokens: placeholders(value),
        });
      });
    });
  });
});
