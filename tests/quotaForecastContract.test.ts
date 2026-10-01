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

  test('queries Claude and Codex usage while keeping token history separate from quota math', () => {
    const page = read('src/features/quotaForecast/QuotaForecastPage.tsx');
    const forecast = read('src/features/quotaForecast/forecast.ts');
    expect(page).toContain("filters: { provider: ['claude', 'codex'] }");
    expect(page).toContain(
      "entry.type === 'claude' ? claudeQuota[cacheKey] : codexQuota[cacheKey]"
    );
    expect(forecast).toContain("provider's own weekly percentage, observed over time");
    expect(forecast).not.toMatch(/total_tokens\s*\/\s*used/i);
  });

  test('reads recorded quota history after quota checks and guards old connections and requests', () => {
    const page = read('src/features/quotaForecast/QuotaForecastPage.tsx');
    expect(page).toContain('quotaHistoryApi.getHistory');
    expect(page.indexOf('await loadQuota(forecastEntries)')).toBeLessThan(
      page.indexOf('quotaHistoryApi.getHistory')
    );
    expect(page).toContain('apiClient.getConnectionRevision() === revision');
    expect(page).toContain('requestRef.current === requestId');
    expect(page).toContain('window.setInterval(() => setNowMs(Date.now()), 60_000)');
    expect(page).toContain('window.clearInterval(timer)');
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
      for (const key of englishKeys) {
        const placeholders = (value: string): string[] =>
          (value.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((part) => part.replace(/\s/g, '')).sort();
        expect(placeholders(locale.quota_forecast[key])).toEqual(
          placeholders(locales[0].quota_forecast[key])
        );
      }
    }
  });
});
