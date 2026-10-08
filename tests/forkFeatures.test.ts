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
      '## Reset outcomes',
      '## Display time zone',
      '## Plans and quota numbers',
      '## Log requests view',
      '## Usage request details',
      '## Hash navigation',
      '## Release gate',
    ]) {
      expect(manifest).toContain(required);
    }
  });
});

describe('reset outcome contract', () => {
  test('keeps unspent Codex answers and Claude grant states out of the success path', () => {
    const codex = read('src/features/quota/providers/codex/data.ts');
    expect(codex).toContain("outcome !== 'reset' && outcome !== 'already_redeemed'");
    expect(codex).toContain("codex_quota.reset_outcome_${outcome ?? 'unknown'}");
    const hook = read('src/features/quota/providers/claude/ClaudeResetGrants.tsx');
    expect(hook).toContain('describeResetGrantState(status, now)');
    expect(hook).toContain("'read_throttled'");
    const row = read('src/features/quota/components/QuotaCredentialRow.tsx');
    expect(row).toContain("entry.type === 'claude' && status !== 'idle' && claudeReset.message");
    expect(row).toContain('<ClaudeResetGrantDetails');
    expect(codex).toContain('authFilesApi.resetCooldown(authIndex)');
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
    const source = `access:
  api-keys:
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

    expect(saved.access['api-keys']).toEqual([
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
    const historyClient = read('src/services/api/quotaHistory.ts');
    expect(historyClient).toContain('/usage-store/quota-history');
    expect(historyClient).toContain('observed_at_ms');
    expect(page).toContain('quotaHistoryApi.getHistory');
    expect(page).toContain('authIndex: entry.file.authIndex');
    expect(page).toContain('meta.health.persistence_failed_rows');
    expect(forecast).toContain('latest.used_percent - first.used_percent');
    expect(forecast).toContain('context.history.truncated');
    expect(forecast).toContain("unknownForecast('store-losses'");
    expect(forecast).toContain('FORECAST_MAX_AGE_MS');
    expect(forecast).toContain('includesImportedReadings');
  });
});

describe('2026-10-05 dashboard pass contract', () => {
  test('timestamps default to Miami time and the choice lives in the header menu', () => {
    const zone = read('src/utils/time/displayZone.ts');
    expect(zone).toContain("DEFAULT_DISPLAY_TIME_ZONE = 'America/New_York'");
    expect(read('src/main.tsx')).toContain('installDisplayTimeZone();');
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(layout).toContain('DISPLAY_TIME_ZONE_CHOICES.map');
    expect(layout).toContain('key={displayZone}');
    expect(read('src/utils/quota/relativeTime.ts')).toContain('displayZoneAbbreviation(date)');
    expect(read('src/features/logs/LogsPage.tsx')).toContain(
      'formatServerLogTimestamp(line.timestamp)'
    );
    expect(read('src/features/authFiles/constants.ts')).toContain('resolveTimeZoneLabel(date)');
  });

  test('plans, weekly-only Codex rows and reset applicability stay wired', () => {
    const rowModel = read('src/utils/quota/rowModel.ts');
    expect(rowModel).toContain("'codex_quota.plan_promax'");
    expect(rowModel).toContain("'codex_quota.no_five_hour_limit'");
    expect(rowModel).toContain('rateLimitResetCreditsApplicableAvailableCount');
    expect(read('src/utils/quota/planTier.ts')).toContain("ELITE_CODEX_PLAN_TYPE, 'promax'");
    expect(read('src/features/quota/providers/claude/data.ts')).toContain("return 'plan_max20'");
    expect(read('src/utils/quota/familySummary.ts')).toContain('CONTESTED_WEEKLY');
    const row = read('src/features/quota/components/QuotaCredentialRow.tsx');
    expect(row).toContain('resetNotApplicable');
    expect(row).toContain('model?.absentLabelKeys?.[column.columnId]');
    expect(read('src/features/authFiles/components/AuthFileQuotaSection.tsx')).toContain(
      'resetNotApplicable'
    );
  });

  test('the Logs page keeps its Requests tab joined to the usage store', () => {
    const page = read('src/features/logs/LogsPage.tsx');
    expect(page).toContain("type TabType = 'logs' | 'requests' | 'errors';");
    expect(page).toContain('<LogRequestsView');
    expect(page).toContain("active: activeTab === 'logs' || activeTab === 'requests'");
    const view = read('src/features/logs/components/LogRequestsView.tsx');
    expect(view).toContain('indexUsageRowsByShortId(usageRows)');
    expect(view).toContain('resolveDeviceName(key, devices)');
    expect(existsSync(join(root, 'src/features/logs/model/logRequestTable.ts'))).toBe(true);
  });

  test('usage request rows keep speed, failure and slow-first-token detail', () => {
    const view = read('src/features/usage/components/UsageRequestsView.tsx');
    expect(view).toContain("t('usage.column_speed')");
    expect(view).toContain('usage.requests_failures_only');
    expect(view).toContain('usage.requests_slow_only');
    expect(view).toContain('styles.detailRow');
  });

  test('hand-edited hashes and back/forward still change the page', () => {
    expect(read('src/components/common/PageTransition.tsx')).toContain(
      'const locationLayerKey = resolveLayerKey(location);'
    );
  });
});
