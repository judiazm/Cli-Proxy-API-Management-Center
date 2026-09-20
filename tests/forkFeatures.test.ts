import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runVisualConfig } from './helpers/visualConfig';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('fork feature manifest', () => {
  test('documents every feature that the release updater must preserve', () => {
    const manifest = read('FORK_FEATURES.md');
    for (const required of [
      '## Quota layout and privacy',
      '## Credential nicknames',
      '## Quota forecast',
      '## Pools',
      '## Object-form API keys',
      '## Persistent Usage',
      '## Release gate',
    ]) {
      expect(manifest).toContain(required);
    }
  });
});

describe('custom route and navigation contract', () => {
  test('keeps all custom Observe routes and keeps the navigation in its intended order', () => {
    const routes = read('src/router/MainRoutes.tsx');
    const layout = read('src/components/layout/MainLayout.tsx');

    for (const [path, component, labelKey] of [
      ['/quota', 'QuotaPage', 'nav.quota_management'],
      ['/quota-forecast', 'QuotaForecastPage', 'nav.quota_forecast'],
      ['/pools', 'PoolsPage', 'nav.pools'],
      ['/usage', 'UsagePage', 'nav.usage'],
    ] as const) {
      expect(routes).toContain(`{ path: '${path}', element: <${component} /> }`);
      expect(layout).toContain(`path: '${path}'`);
      expect(layout).toContain(`labelKey: '${labelKey}'`);
    }

    const positions = ['/quota', '/quota-forecast', '/pools', '/usage', '/logs'].map((path) =>
      layout.indexOf(`path: '${path}'`)
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test('retains the route-owned source files and sidebar icons', () => {
    for (const path of [
      'src/features/quotaForecast/QuotaForecastPage.tsx',
      'src/features/pools/PoolsPage.tsx',
      'src/features/usage/UsagePage.tsx',
      'src/features/usage/components/UsageTableView.tsx',
      'src/features/usage/components/UsageTimelineView.tsx',
      'src/features/usage/components/UsageMatrixView.tsx',
      'src/features/usage/components/UsageRequestsView.tsx',
      'src/services/api/usageStore.ts',
    ]) {
      expect(existsSync(join(root, path))).toBe(true);
    }

    const icons = read('src/components/ui/icons.tsx');
    expect(icons).toContain('export function IconSidebarForecast');
    expect(icons).toContain('export function IconSidebarPools');
    expect(icons).toContain('export function IconSidebarUsage');
  });
});

describe('privacy and navigation behavior contract', () => {
  test('keeps full client keys out of usage URLs and passes search-only navigation through', () => {
    const page = read('src/features/usage/UsagePage.tsx');
    const naming = read('src/features/usage/logic/naming.ts');
    const view = read('src/features/usage/hooks/useUsageView.ts');
    const transition = read('src/components/common/PageTransition.tsx');

    expect(page).toContain('expandDeviceFilterValues(view.filters.api_key, names.devices)');
    expect(naming).toContain('export const keyFingerprint');
    expect(view).toContain('useSearchParams()');
    expect(view).toContain('{ replace: !isNavigation }');
    expect(transition).toContain('location.search');
  });

  test('keeps credential masking and note-based nicknames wired into quota and forecast', () => {
    const credentialName = read('src/utils/quota/credentialName.ts');
    const quotaRow = read('src/features/quota/components/QuotaCredentialRow.tsx');
    const forecast = read('src/features/quotaForecast/QuotaForecastPage.tsx');

    expect(credentialName).toContain('export function maskCredentialName');
    expect(credentialName).toContain('export function displayCredentialLabel');
    expect(quotaRow).toContain('displayCredentialLabel');
    expect(forecast).toContain('displayCredentialLabel');
  });
});

describe('object-form API key preservation', () => {
  test('a visual config save retains labels and allowlists on keys that remain listed', () => {
    const source = `api-keys:
  - api-key: fixture-mac-key
    label: Mac
    allowed-models:
      - gpt-*
  - fixture-plain-key
`;
    const config = runVisualConfig(source, [
      { apiKeysText: 'fixture-mac-key\nfixture-plain-key\nfixture-new-key' },
    ]);
    const saved = parseYaml(config.applyVisualChangesToYaml(source));

    expect(saved['api-keys']).toEqual([
      {
        'api-key': 'fixture-mac-key',
        label: 'Mac',
        'allowed-models': ['gpt-*'],
      },
      'fixture-plain-key',
      'fixture-new-key',
    ]);
  });
});

describe('both-provider forecast contract', () => {
  test('keeps provider-specific quota windows and usage-only context', () => {
    const page = read('src/features/quotaForecast/QuotaForecastPage.tsx');
    const forecast = read('src/features/quotaForecast/forecast.ts');

    expect(page).toContain("filters: { provider: ['claude', 'codex'] }");
    expect(page).toContain('getQuotaCacheKey(entry.file)');
    expect(forecast).toContain("export type ForecastProvider = 'claude' | 'codex'");
    expect(forecast).toContain("window.id === 'seven-day'");
    expect(forecast).toContain("window.id === 'weekly'");
    expect(forecast).toContain('Token history remains context only');
  });
});
