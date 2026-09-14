import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('quota forecast page contract', () => {
  test('has an authenticated route and an Observe sidebar entry', () => {
    expect(read('src/router/MainRoutes.tsx')).toContain(
      "{ path: '/quota-forecast', element: <QuotaForecastPage /> }"
    );
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(layout).toContain("path: '/quota-forecast'");
    expect(layout).toContain("labelKey: 'nav.quota_forecast'");
  });

  test('queries only Codex usage and keeps token history separate from quota math', () => {
    const page = read('src/features/quotaForecast/QuotaForecastPage.tsx');
    const forecast = read('src/features/quotaForecast/forecast.ts');
    expect(page).toContain("filters: { provider: ['codex'] }");
    expect(forecast).toContain("provider's own weekly percentage and elapsed cycle time");
    expect(forecast).not.toMatch(/total_tokens\s*\/\s*used/i);
  });

  test('ships the same forecast keys in every locale', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ru'].map((language) =>
      JSON.parse(read(`src/i18n/locales/${language}.json`))
    );
    const englishKeys = Object.keys(locales[0].quota_forecast).sort();
    for (const locale of locales) {
      expect(locale.nav.quota_forecast).toBeTruthy();
      expect(locale.nav_meta.quota_forecast).toBeTruthy();
      expect(Object.keys(locale.quota_forecast).sort()).toEqual(englishKeys);
    }
  });
});
