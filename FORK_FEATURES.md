# Fork feature manifest

This file lists the panel behavior that belongs to the `judiazm` fork and must survive every
upstream merge or update. A successful build is not enough to prove that these features survived because
the upstream panel builds cleanly without any of them.

The recovery branch starts at deployed release `v1.24.1-jd.1` (`b36e4e5`), whose upstream base is
`v1.24.1` (`bbac79d`). The release already contains the quota layout, credential nicknames, and
Codex and Claude forecast features. The recovery commits add Pools, object-form API key
preservation, and the persistent Usage interface through recovered source tip `1b33564`. Future
updates must descend from the latest complete fork release instead of reconstructing the fork from
the incomplete `b36e4e5` baseline.

## Required routes and navigation

The authenticated route table and the Observe navigation group must contain these entries in this
order:

| Route             | Navigation label | Purpose                                                                    |
| ----------------- | ---------------- | -------------------------------------------------------------------------- |
| `/quota`          | Quota Management | Compact credential rows, summary counts, account search, and email masking |
| `/quota-forecast` | Quota Forecast   | Provider-reported weekly forecast for Claude and Codex                     |
| `/pools`          | Pools            | Credential reach derived from prefixes and API key allowlists              |
| `/usage`          | Usage            | Persistent request usage by device, model, account, provider, and time     |

The route declarations live in `src/router/MainRoutes.tsx`. The navigation entries and icons live
in `src/components/layout/MainLayout.tsx` and `src/components/ui/icons.tsx`. Shared-file conflicts
during an update must preserve every entry. Choosing only the upstream side or only one custom side
can produce a valid build with missing navigation.

## Quota layout and privacy

Current release commit: `48633c0` (rebased from `9279e62`).

- `src/features/quota/QuotaPage.tsx` provides the summary strip, compact rows, account search, and
  the show/hide email control.
- `src/utils/quota/credentialName.ts` masks credential email addresses by default while retaining
  enough file identity to distinguish accounts.
- The masking choice is shared with Pools through `src/features/quota/uiState.ts`.
- The route and navigation entry remain `/quota` and `nav.quota_management`.

## Credential nicknames

Current release commit: `c6326a4` (rebased from `30ab307`).

- An auth file's `note` is the preferred human-readable nickname.
- `displayCredentialLabel` in `src/utils/quota/credentialName.ts` falls back to the masked or
  revealed credential filename when the note is blank.
- Quota and Forecast must both use the helper so the same account has the same label on both pages.

## Quota forecast

Current release commits: `7d68fac` for Codex and `b36e4e5` for Claude, rebased from `fbe486d` and
`cbb9d15` respectively.

- The route is `/quota-forecast` and the Observe navigation key is `nav.quota_forecast`.
- `src/features/quotaForecast/QuotaForecastPage.tsx` loads enabled Claude and Codex credentials,
  provider quota state, and usage-store context.
- `src/features/quotaForecast/forecast.ts` estimates from recorded changes in provider-reported quota
  over the latest 24 hours of the current cycle. Usage tokens are context only and are never
  converted to quota percent.
- `src/services/api/quotaHistory.ts` reads `/usage-store/quota-history` through the v8 client. The
  backend records genuine provider observations; opening the page never fabricates a timestamp.
- Forecasts isolate provider, auth filename, credential index, and weekly window. Changed resets and
  material percentage decreases start a new segment. At least three observations spanning 30
  minutes and one percentage point of growth are required for an estimate.
- Readings older than 30 minutes, truncated history, and unavailable history remain unknown. Fresh
  provider-reported exhaustion is shown even when the new cycle or observation history is sparse.
  Missing write diagnostics or process-lifetime lost records pause estimates. Imported log readings
  are identified and retain low confidence because their precision is lower.
- Confidence describes observation coverage and pace stability. It is not a calibrated probability.
  Rows show sample count, span, age, and observed quota pace; a bounded UI clock updates freshness
  without polling providers.
- Token totals cover the local Monday week separately from provider cycles. Recent token pace uses
  each account's first recorded request in the query range. Missing summaries remain unknown;
  request and failure counts are usage context. Old connection or refresh responses cannot replace
  current page state.
- Claude uses the account-wide `seven-day` window. Codex uses its account-wide weekly window.
- Missing, stale, sparse, invalid, or zero-consumption data must remain explicit unknown states.

## Pools

Recovery commit: `5ae5dde`, restored from original commit `c632251`.

- The route is `/pools` and the Observe navigation key is `nav.pools`.
- Pools are derived from provider family plus credential prefix. They are not stored as named
  backend objects.
- Reach is derived from object-form `api-keys` entries and their `allowed-models` patterns.
- Pool cards show member credentials, reachable client keys, matching patterns, quota context, and
  an Unreachable section for disabled or unmatched credentials.
- Credential emails are masked by default. Full client API keys never appear in the UI.
- Pure matching and derivation contracts live in `tests/poolsMatching.test.ts` and
  `tests/poolsDerivation.test.ts`.

## Object-form API keys

Recovery commit: `433fdd3`, restored from original commits `ab307ae` and `c8b845b`.

- `src/services/api/apiKeys.ts` accepts plain string keys and object entries with `api-key`, `label`,
  and `allowed-models`.
- `src/services/api/transformers.ts` exposes keys to the panel without discarding object entries.
- Saving the plain-text API key field in `src/hooks/useVisualConfig.ts` must retain the full existing
  object for every key that remains listed. This prevents a visual config save from erasing labels
  and allowlists used by Pools and Usage.

## Persistent Usage

The backend API client in `src/services/api/usageStore.ts` was already present in release
`v1.24.1-jd.1` through the Codex forecast commit `7d68fac`. Its content is byte-identical to original
Usage commit `c07690a`, so replaying `c07690a` was correctly empty. The custom interface was restored
through these commits:

| Recovery commit | Original commit | Contract                                                                           |
| --------------- | --------------- | ---------------------------------------------------------------------------------- |
| `9e9ac47`       | `f80cb4c`       | Usage page, controls, table, timeline, matrix, request view, hooks, and pure logic |
| `8af3e8a`       | `45fdcdb`       | `/usage` route, Observe navigation entry, icon, and all four locales               |
| `9903334`       | `bb78713`       | API query, aggregation, formatting, translations, and view-state tests             |
| `ea5a479`       | `cd4c420`       | Page transitions respond to search-only navigation changes                         |
| `4b95575`       | `f8d8d38`       | Address-bar filters use key fingerprints instead of full client keys               |
| `1b33564`       | `766eda5`       | Device drill-downs deduplicate by fingerprint                                      |

Usage supports table, timeline, matrix, and raw request views over the same range and filters. View
state is encoded in the URL so back/forward navigation and shared links remain consistent. A client
key is expanded from its fingerprint only when preparing the backend request. The full key must not
enter the address bar, filter chips, headings, or exported labels.

## Reset outcomes

A Codex reset is reported as done only when the consume answer's `code` is `reset` or
`already_redeemed`. ChatGPT answers `nothing_to_reset` and `no_credit` with HTTP 200 and spends
nothing; those, and any unrecognized answer, are shown as not reset instead of a success toast.
Claude reset grants explain why no grant can be spent (throttled read, spent, ineligible, waiting
for the limit) on the quota row, including when the row's own usage read failed.

## Display time zone

Every timestamp renders in one display zone, America/New_York (Miami) by default, named with
its abbreviation (EDT/EST). The proxy host logs in UTC and browsers can run anywhere, so "local
time" used to mean three different clocks.

- `src/utils/time/displayZone.ts` holds the choice (Miami, UTC or this device), persists it in
  `localStorage` (`cpamc.displayTimeZone`), and `installDisplayTimeZone()` (called first in
  `src/main.tsx`) makes `toLocale*String` and `Intl.DateTimeFormat` default to it when a caller
  names no zone. Upstream call sites are therefore covered without edits.
- The choice sits in the header's language menu ("Language and time zone"); changing it
  re-mounts the page content (`key={displayZone}` on `PageTransition`).
- `resolveTimeZoneLabel` names the display zone; `formatInstantShort`, `formatDateTimeValue`,
  `formatUnixTimestamp`, Usage request stamps and Forecast instants append it.
- Log lines parse the server's offset-less stamps as UTC and render them in the display zone
  (`formatLogInstant`), with the raw UTC stamp in the tooltip.
- Grid arithmetic (timeline day columns, the forecast's Monday week) still follows the device
  zone.

## Plans and quota numbers

- Codex `promax` is OpenAI's Pro 500 (2026-09-29): label "Pro 500", the same top finish as
  Pro 200, and a "Speed: Ultrafast" note. Claude Max shows its multiplier from
  `organization.rate_limit_tier` ("Max 20x", "Max 5x").
- Pro and Pro 500 report one weekly window and no 5-hour window; their 5-hour cell reads "No
  5-hour limit" (`absentLabelKeys` in the row model) instead of "Not reported".
- Codex rows show the account's credit balance when it is above zero.
- Manual resets show how many would apply now (`applicable_available_count`). When none would,
  the Codex "Reset quota" button is disabled with the reason, on the Quota page and on Auth
  Files: OpenAI answers `nothing_to_reset` and spends nothing until usage needs a reset.
- Claude rows show until when a remaining reset grant is valid, and the confirm dialog states
  the current 5-hour and weekly use before a grant is spent.
- Claude's headline window is whichever weekly bucket (all models or Fable) has less left
  across the family; the other is shown beside it (`CONTESTED_WEEKLY`).

## Log requests view

Logs has a Requests tab (`src/features/logs/components/LogRequestsView.tsx`, pure model in
`src/features/logs/model/logRequestTable.ts`). It groups log lines by the 8-character request id,
merges routing lines (`auth=`, `provider=`, `model=`) with the gin access line (status,
duration, client IP, path), and joins each request to the usage store by id suffix (the log's id
is the last 8 characters of the stored UUIDv7). Rows show time in the display zone, status,
duration, time to first token, client key label or fingerprint (never the key), account
nickname, model and alias, speed tier, tokens and path; a row expands to its log events and
stored details. Filters: status class, in flight, errors and limits, first token at or over
20 s, provider, account, model and text. It tails with the log stream. Management calls under
any API version are hidden by the existing switch (`isManagementPath`).

## Usage request details

The Usage Requests view adds a Speed column (Fast, Ultrafast, Flex; standard left blank), the
account nickname above its email, Failures and slow-first-token toggles with counts, row
highlighting, and an expandable detail row (request id, endpoint, credential, session chain,
asked and served tier, client IP and agent).

## Hash navigation

`PageTransition` keys layers with `resolveLayerKey`
(`src/components/common/pageTransitionKey.ts`). A hand-edited hash, or back/forward onto one,
arrives with `key: 'default'`; keyed on that alone, the second such navigation matched the
current layer and the page never changed while the sidebar did.

## Release gate

Before publishing any fork panel release:

1. Resolve the latest complete fork release tag or recorded release tip and confirm it is an ancestor
   of the candidate. For the first recovered release, the required recovered source tip is `1b33564`;
   `b36e4e5` ancestry alone is insufficient because that commit does not contain Pools or Usage.
2. Read the upstream range and resolve shared route, layout, locale, config, and API conflicts while
   preserving every feature above.
3. Run `bun test tests/forkFeatures.test.ts` and the focused Pools, Usage, quota credential, and quota
   forecast suites.
4. Run `bun run verify`.
5. Build the single-file artifact and confirm the four required routes and Observe navigation labels
   are present before replacing `management.html`.
6. After deployment, read back the served asset, confirm its SHA-256 matches the release artifact,
   and verify `/quota`, `/quota-forecast`, `/pools`, and `/usage` through hash routing.

`tests/forkFeatures.test.ts` is the minimum fork-presence contract. Do not remove or bypass it in an
updater branch. If a feature is intentionally replaced, update this manifest and the contract in the
same reviewed change.

The forecast risk total includes both exhausted accounts and accounts projected to run out before reset. Unknown forecasts are disclosed separately and are not evidence of available capacity.
