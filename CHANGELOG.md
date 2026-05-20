# Changelog

All notable changes to Open Agents are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

### Changed

- docs: SPEC.md §2 Registry model rewritten — the OpenAgents repo is now the registry. App binary ships with zero agents and fetches `/agents/index.json` from the repo at runtime; cache-on-first-fetch lifecycle; per-agent `minAppVersion` gate; forkable registry source for enterprises.
- docs: tasks/todo.md gains a v0.2 block — repo-as-registry plumbing, DSL extensions (parallel/named graph steps, multi-input LLM, `map`), new synthetic fixtures, and the bundled agent overhaul (investigator / advisor / cleanup tiers; existing read-only agents demoted to a new "Dashboards" tier).

### Removed

### Fixed

### Security

## [0.1.6] - 2026-05-20

### Added

- **AppX tile assets — fix for Microsoft Store policy 10.1.1.11.** Custom `StoreLogo.png`, `Square44x44Logo.png`, `Square71x71Logo.png`, `Square150x150Logo.png`, `Square310x310Logo.png`, `Wide310x150Logo.png`, and `SplashScreen.png` rendered from the brand `icon-source.svg` and placed in `apps/desktop/build/`. `electron-builder` auto-discovers them by filename when building the AppX. Replaces the default Electron placeholder tiles that Microsoft rejected ("Tile icons must uniquely represent product"). Sources for the wide tile and splash live alongside as `*.source.svg` so they're regeneratable. `apps/desktop/build/README.md` documents the rasterize commands. `build.appx.showNameOnTiles` enabled in `apps/desktop/package.json` so the app name renders under the tile.
- runtime: agent-template graph steps can now call any Microsoft Graph GET endpoint via the new `RunGraphApi.request()` adapter — paths beyond `/deviceManagement/managedDevices` are dispatched generically with `$select`, `$filter`, etc.
- runtime: generic write action kind `graph-write` — agents can declare any POST/PATCH/PUT/DELETE Graph endpoint with a templated body. The runtime renders one Graph request per source item, lists them all in the `WritePlan`, and only fires after the user types the confirmation phrase. The legacy `retire-managed-device` kind keeps working unchanged.
- runtime: two new transforms — `group-by-field` and `sort-by` — so agents working over arbitrary Graph collections have somewhere to go besides device-age math. Transforms (filter-by-age, group-by-age, group-by-field, count-by-field, sort-by) now read nested dot-paths like `signInActivity.lastSignInDateTime`.
- electron: vendored merill/msgraph endpoint catalogue (~28k endpoints, ~6.4k with permission scopes). The drafter pre-searches it for candidate endpoints, and the install path validates that every declared graph or graph-write step targets a real endpoint.
- run UI: write actions now show the HTTP method as a coloured badge and expose an expandable "Request preview" with the rendered method/path/body so admins audit the exact Graph call before approving.
- agents: sample `user-license-overview` (read) and `disable-inactive-guests` (graph-write) agents demonstrating the new shapes end-to-end.

### Changed

- new-agent: review step now shows the drafted agent's name, description, mode, category, and version; modal subtitle switches to a review-mode caption; pipeline card opens by default so the proposed steps are visible without an extra click.
- new-agent: drafter prompt no longer hardcodes a single endpoint; candidate read endpoints relevant to the user's prompt are injected at draft time, and when the prompt looks write-y (disable / delete / revoke / …) candidate POST/PATCH/DELETE endpoints are injected alongside them. Drafter examples cover both read and `graph-write` shapes.
- runtime: `tokenProvider` for agent runs now goes through `tenantSession.acquireTokenForScopes(agent.scopes)`, so MSAL prompts for incremental consent the first time an installed agent needs new scopes.
- runtime: retry policy for `RunGraphApi.request()` splits on idempotency — POST/PATCH retry only on 429, while GET/PUT/DELETE keep the existing 429+5xx retry behaviour.

### Removed

### Fixed

### Security

## [0.1.5] - 2026-05-19

### Added

- **Privacy policy page at `/privacy`.** Honest, plain-language policy covering MSAL token storage in OS keychain, Microsoft Graph data handling on-device, local-vs-hosted LLM provider behavior, no-telemetry stance, and the waitlist-only data the marketing site collects. Maintainer contact is `support@ugurlabs.com`. Linked from the homepage footer. Required for Microsoft Store submission and for the desktop app's eventual in-app About link.
- **Terms of use page at `/terms`.** One-page terms covering MIT-license as-is/no-warranty disclaimer, user responsibility for tenant authorization and write-agent diff approval, third-party services (Microsoft Graph + the user's LLM provider) being governed by their own terms, acceptable use, and a pointer back to the privacy policy. Linked from the homepage footer.
- **Sitemap and robots.txt for the marketing site.** New `web/src/app/sitemap.ts` and `web/src/app/robots.ts` using Next.js App Router metadata routes. Sitemap lists `/`, `/privacy`, and `/terms`; robots allows everything except `/api/` and points crawlers at the sitemap. Makes the legal pages discoverable to search engines and to Microsoft's Store-submission crawlers.
- **Microsoft Store auto-publish workflow.** New `.github/workflows/store-publish.yml` fires on `release: published` (and `workflow_dispatch`), downloads the `.appx` from the GitHub release assets, and submits it to Partner Center via Microsoft's official `msstore` Developer CLI. The first submission stays manual; subsequent releases auto-submit once `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET`, and `MS_STORE_APP_ID` are configured as repo secrets. The workflow skips cleanly (with a warning) until the secrets exist, so it's safe to land before the manual onboarding is finished. `docs/RELEASING.md` documents the one-time Partner Center → Azure AD app registration → Manager-role onboarding plus the secret names.
- **Microsoft Teams connector (first connector).** End-to-end implementation across the monorepo:
  - **`packages/connector-teams`** — new package implementing `TeamsConnectorCapabilities` (`listTeams`, `listChannels`, `postChannelMessage`, `postChatMessage`) against Microsoft Graph. Includes a small Markdown→Teams HTML renderer (bold, italic, code, links, headings, lists) so agent output renders correctly in Teams chat. Registers itself onto `ConnectorRegistry` via TypeScript declaration merging.
  - **Runtime wiring (`packages/runtime/src/connectors.ts`)** — static connector registry, preflight (build + healthcheck + dispose lifecycle), capability invocation wrapper that injects runtime-supplied idempotency keys, emits `ConnectorAuditEntry`, gates `notify`/`mutating`/`destructive` calls through a `confirmInvocation` callback, and maps typed `ConnectorError` failures to retry/reauth/reconfigure/fatal recovery actions. `ctx.connectors` is now injected into every `RunContext` when an agent declares connector requirements.
  - **MSAL `createTenantSession()`** with per-capability incremental consent — silent token acquisition first, interactive MSAL re-consent for any scope set the cache cannot satisfy. Wired into desktop runs via `buildGraph()` in `state.ts`.
  - **Connectors page** at `/connectors` (new sidebar entry between Agent Hub and Activity). Lists every registered connector with status pill (`connected` / `needs setup` / `needs consent` / `error` / `untested`), capability list with kind tags, declared Graph scopes, and a `Test connection` button that runs `healthCheck` against the active tenant.
  - **Preview-and-send confirmation modal** at AppShell level — fires whenever a `notify`+ capability is about to execute, shows the connector + capability + egress target + rendered body preview, with Cancel and Send buttons. Cross-process IPC bridge (`connector-confirm-bridge.ts`) correlates main-process capability calls with renderer-side modal responses.
  - **YAML pipeline support for `format: connector`** in `packages/runtime/src/agent-template.ts` — agents declare `descriptor.connectors[]` and use `format: connector` skills with `connector`, `capability`, `version`, and templated `args`. The runtime resolves the connector via `ctx.connectors`, maps kebab-case capability ids to camelCase methods, and invokes them through the capability wrapper so confirmation and audit fire automatically.
  - **Sample agent `tenant-health-report`** — reads Intune managed devices, tallies by compliance state, LLM-summarizes, and posts the summary to a Teams channel. First end-to-end exercise of the connector abstraction. User configures `teamId` + `channelId` per install; the post fires only after the preview-and-send modal is approved.
- **Connector abstraction (contract).** New `### Connector abstraction` section in `docs/SPEC.md` §2 plus the type contract in `packages/agent-sdk/src/index.ts`. Production-grade design: SemVer-major-versioned capabilities addressed as `id@major`, four capability kinds (`read` / `notify` / `mutating` / `destructive`) mapped to four confirmation tiers (none / preview-and-send / diff / typed-phrase), three auth-source classes (`graph-delegated` / `graph-application` / `external`), typed error contract with `recovery` semantics (`retry` / `reauth` / `reconfigure` / `fatal`), runtime-supplied idempotency keys, per-package plugin distribution, and type-safe `ctx.connectors` via TypeScript declaration merging on the empty `ConnectorRegistry` interface. `AgentContract.connectors?` and `RunContext.connectors?` extended (optional, runtime-injection lands in v0.2). The Teams connector ships first as the abstraction validator (graph-delegated, delegated permissions, scopes folded into MSAL consent, `post-*-message` as `kind: notify` with preview-and-send confirmation). ServiceNow positioned as the canonical second connector under "Designed before launch" (`external` auth, instance URL, keychain credentials). Added to §5 as a v1.0 blocker; v0.1 defers connector runtime to v0.2 alongside real MSAL.
- **Branded macOS DMG install window.** The `.dmg` now opens to a dark, on-brand Open Agents install screen (660×440) with the app icon on the left, an arrow, and an `Applications` shortcut on the right. Background source is `apps/desktop/build/dmg-background.svg`, rendered to a Retina TIFF at `apps/desktop/build/background.tiff`. See `apps/desktop/build/README.md` for regeneration steps.
- **Onboarding routing gate.** With zero tenants connected, every URL redirects to `/onboarding`. Disconnecting the last tenant routes the user back to onboarding. Adding tenant #2+ uses the existing `Connect tenant` buttons in TenantSwitcher / Settings → Tenants and triggers MSAL sign-in directly — no onboarding rerun.

### Changed

- **Graph writes are real by default once a tenant is connected.** Removed the `Enable real Graph writes` toggle from Settings → Privacy and dropped the corresponding global flag from state, IPC, and the status strip. The typed-phrase diff confirmation on every write run is the only authorization gate — there is no separate global switch to forget.
- **Onboarding step 3 is mandatory.** Removed the global Skip button and the "Continue without a tenant" card. Users connect a Microsoft 365 tenant before reaching the app shell.
- **Settings → Tenants copy** rewritten to reflect the new gate: no more mentions of a fallback synthetic fixture.

### Removed

- `setRealWritesEnabled` IPC + preload binding + AppState field. State files written by older 0.1.x releases are read transparently (the field is ignored).
- Real-writes cell from the bottom status strip — it duplicated information already conveyed by the tenant cell.
- **Synthetic mode entirely.** `packages/runtime/src/graph-fixtures.ts` deleted; `createSyntheticGraph` no longer exported. `RunDataSource` type and `RunRecord.dataSource` field dropped from `@openagents/agent-sdk`. The Activity "Synthetic" filter chip, AgentsHome "No tenant — synthetic mode" banner, ResultPanel synthetic callout, and RunResult dataSource pill are all gone. Runs without a connected tenant now fail preflight with a clear error instead of falling back to a fixture.
- Sidebar bottom-left user/provider card. Settings is now a regular nav row alongside Agents / Agent Hub / Activity. Provider info already lives in the bottom status strip.

### Fixed

### Security

## [0.1.4] - 2026-05-17

A cleanup pass on the v0.1 surface plus a structural redesign of the run-detail page. Stays on 0.1.x; no schema or storage migrations.

### Added

**Agent contract — LLM is load-bearing.** Every agent template must include at least one `format: llm` step. The runtime hard-fails any LLM step reached without a connected provider (replacing the previous silent skip on `when: ctx.llm.available`). `npm run qa` enforces it via a new `uses-llm` check. NL2Agent's prompt and validators reject drafts that omit the step. Bundled agents (`find-inactive-devices`, `compliance-overview`, `os-update-posture`) now use the LLM step's output as the `result.summary` headline rather than burying it in `data.llmSummary`. The write agent `retire-inactive-devices` gained an `explain_plan` LLM step whose output becomes the diff-confirmation headline.

**Run detail page redesign.**
- **Live telemetry strip** under the header: Elapsed (live-ticking) · Steps N/M · Tokens (prompt · out) · Model · Cost.
- **Token telemetry**: Ollama provider parses `prompt_eval_count` + `eval_count`; runtime accumulates into `RunRecord.tokens`.
- **Pipeline timeline** replaces the flat step list — connected status indicators (done ✓ / running spinner / pending hollow / failed ✕) with per-step durations.
- **Tabbed activity feed**: Pipeline · Logs · Reasoning. Logs tab has per-level filter chips (debug/info/warn/error) and per-line hover-to-copy. Reasoning tab isolates LLM thinking blocks.
- **Structured Result panel**: arrays-of-records render as tables; bucketed maps render as grouped sections; JSON-stringified values inside the data block are re-hydrated; `Show raw` toggle exposes the original JSON.
- **Failure remediation card** on failed runs with pattern-matched suggestions for common errors.
- **Outcome card** replaces the duplicated summary card; data-residency moved into a side panel.

**Per-run controls.**
- **Run cancellation** via `cancelRun(runId)` IPC + danger-styled Cancel button + `Esc` shortcut. Marks the run terminal and drops subsequent progress; background work finishes silently.
- **Per-run provider + model override** via a new `RunWithMenu` split button on Agent Detail. `StartRunOptions` gained `providerId` and `model` fields. Run-again preserves the original run's tenant, provider, and model.
- **"Run in background"** button during live runs navigates back to Agents; runs continue in flight.
- **Run-start preflight** throws synchronously ("Ollama isn't reachable. Start it with `ollama serve`, then try again.") instead of queueing a run that fails seconds later.

**Per-install agent management.**
- **Uninstall** via `uninstallAgent(slug)` IPC + UI on Agent Detail. User-authored agents are deleted from disk; bundled agents stay on disk and remain installable from the Hub.
- **Schedules**: `AgentSchedule { enabled, intervalSeconds }` per installed agent. A 60-second main-process tick fires any due schedule (skipping in-flight runs). New `AgentScheduleCard` with preset intervals (15m / 1h / 4h / 12h / 24h) and a live countdown. Schedules only fire while the app is open — surfaced honestly in the card copy.
- **Per-provider active model**: Settings → LLM Providers now renders each installed model as a clickable chip. Persists as `activeModelByProviderId` in state.
- **Resolution priority** for the model stamped on each run: explicit `options.model` → agent manifest `preferredModel` (if pulled) → user's `activeModelByProviderId` → provider's first reported model. Each layer validates the model is actually installed.

**App shell + system integration.**
- **Bottom status strip** across every page: active tenant · provider · model · real-writes · in-flight count.
- **Sidebar in-flight badge** on the Activity nav item with pulsing warning tone.
- **Auto-update in-app banner**: main-process updater broadcasts state to the renderer; `UpdateBanner` shows "downloading" / "ready" with a `Restart now` button alongside the existing native dialog.
- **OS-level run-completion notifications** when the app isn't focused; clicking focuses the app and navigates to the run.
- **Native application menu** with View accelerators (`Cmd+1`/`2`/`3`/`,`) and Help shortcuts (Open app data folder, Open logs folder, Open Agents on GitHub).
- **Inline tenant disconnect** on each row of the sidebar TenantSwitcher (hover-revealed ×).
- **Synthetic-mode banner** on Agents home when no tenant is connected.

**Run reporting.**
- **Copy report** (plaintext clipboard), **Export** (save-dialog JSON), **Share** menu (deep link + Export as Markdown). New IPC bridge for `openExternal` and `saveTextFile`.
- **Copy run ID** affordance in the run detail subtitle.
- **Activity text search** alongside the filter chips.
- **Manifest preview Pipeline card** is collapsible by default to shorten the Agent Detail body.
- **Hub filter empty state** with a `Clear filters` action when search/category returns no agents.

### Changed
- ShareMenu accepts per-action callbacks; renders only items with handlers supplied. Slack item removed.
- TenantDriftNote elevated from info to warning tone with a `Re-run against current tenant` CTA.
- Settings → General + Privacy rewritten with honest copy: real toggleable rows where wired, "Not collected" / "Coming in 0.2" labels everywhere else (no more fake "Off" badges).
- Settings → LLM Providers `Install guide` button opens vendor docs via `openExternal`.
- NL2Agent provider-unavailable warning includes provider-specific guidance (`ollama serve` for Ollama, "open Settings → LLM Providers" for hosted).
- Status pills render the new `cancelled` RunStatus with neutral tone.
- Cancelled runs stamp `summary: "Cancelled by user."` (was: stale "is running" text).
- Activity provider column shows the display name (e.g. `Ollama`), not the canonical id.
- All UI references to the GitHub repo corrected from `ugurlabs/openagents` to `ugurkocde/OpenAgents`.
- Agent Hub eyebrow "Community" → "Built-in"; fake `INSTALLS` / `Top installed in May` / hardcoded "From the author" quote removed in favour of real Category + Graph scopes panels.
- Onboarding "Use synthetic data" card retitled "Continue without a tenant" with honest empty-inventory copy.
- README + CONTRIBUTING updated to reflect the LLM-required contract and the actual shipped surface.

### Removed
- The 22-record `contoso.com` synthetic device fixture. Synthetic mode now returns zero devices; agents run end-to-end but produce empty results.
- Placeholder `$0.00 / External` cost cells from the agents-home stats strip, Activity table, Run Result summary, and Agent Detail right rail.
- "Time saved" tile from the agents-home stats strip.
- Stubbed Slack share entry, stubbed `Configure` button on provider rows, stubbed `INSTALLS` stat, the hardcoded "Top installed in May" pill, and the fake author quote on the featured Hub card.
- Agent rating field across the SDK, runtime, and UI (`rating?` removed from `RegistryAgentSummary`).
- Dead export `getSyntheticInventorySize()` from `@openagents/runtime/graph-fixtures.ts`.

### Fixed
- Ollama reasoning models (qwen3, deepseek-r1, gpt-oss) were producing empty `message.content` because they burned the full token budget inside `<think>` blocks. The Ollama provider now sends `think: false` to disable reasoning mode, captures `message.thinking` separately, and falls back to reasoning content if `message.content` is empty. `cleanLlmText` strips `<think>…</think>` from the visible answer.
- Default tenant scope in Settings → General now reflects the actual connected tenant instead of always showing "Not connected".
- Agent Detail Model card now resolves the *actual* model that will be used at run time (mirroring the runtime's resolution chain) instead of statically showing the manifest's `preferredModel` regardless of whether it's installed.
- Steps telemetry caption no longer reads `4/4 · of 4`; reports state ("all complete" / "in progress" / "N failed" / "incomplete" / "no steps yet").
- Agents home subtitle no longer duplicates the tenant name across the trust pill and a trailing span.

### Security

## [0.1.3] - 2026-05-16

### Added

### Changed

### Removed

### Fixed
- macOS DMG launched to a blank window because Vite's default `base: "/"` emitted absolute asset URLs (`<script src="/assets/…">`) that Electron's `file://` loader resolved to the filesystem root instead of the html file's directory. Neither JS nor CSS loaded, React never mounted, and the user saw only the BrowserWindow's configured background color. Fixed by setting `base: "./"` in `apps/desktop/vite.config.ts`, which emits `./assets/…` paths that resolve correctly under `file://`. Dev mode (`npm run dev`) was unaffected because Vite serves over `http` where absolute paths resolve to the dev server root. Bug was latent in v0.1.0 / v0.1.1 / v0.1.2; only surfaced now that someone actually launched the signed DMG.

### Security

## [0.1.2] - 2026-05-16

### Added
- Release-prep automation: a `workflow_dispatch` workflow that bumps every workspace `package.json`, rolls `CHANGELOG.md` so `[Unreleased]` becomes a dated `[X.Y.Z]` section, regenerates `package-lock.json`, and opens a release PR via `gh`. Pairs with a new `auto-tag` workflow that pushes the matching `vX.Y.Z` tag when a `release: v*` commit lands on `main`, which then triggers `release.yml` for the signed build. Net result: cutting a release is two clicks (Run workflow → review PR → merge). Defaults to `patch` bump so the v0.1.x line discipline is preserved by default.
- All four GitHub Actions workflows now opt into Node 24 via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, ahead of GitHub's June 2026 forced cutover. Silences the runner's Node-20-EOL warnings.

### Changed

### Removed

### Fixed
- macOS Keychain prompt on first run no longer references the raw npm package id (`@openagents/desktop`). `app.setName("Open Agents")` is now pinned at the top of `main.ts`, before any `safeStorage` access, so dev and signed builds both produce a single user-facing `Open Agents Safe Storage` Keychain entry. Existing dev-install users may need to delete a stale `@openagents/desktop Safe Storage` entry once (`security delete-generic-password -l "@openagents/desktop Safe Storage"`); fresh installs see no prompt at all.

### Security

## [0.1.1] - 2026-05-16

Signed-binaries follow-up to v0.1.0. The platform is unchanged; this release adds the distribution pipeline so we can ship trustable installers from CI on every tag push. End-to-end verified by a `workflow_dispatch` dry run on `main` — Windows MSIX built clean in 1m45s, macOS DMG signed + notarized in 3m23s (Apple's notarytool round-trip under 2 min on the day).

### Added
- Release pipeline. Tag-push of `v*.*.*` (or workflow_dispatch) cuts a two-channel build via `.github/workflows/release.yml`: an unsigned Windows MSIX for Microsoft Store submission (Store re-signs after upload, giving the binary Microsoft's SmartScreen reputation from day one) and a notarized + signed macOS DMG/ZIP for direct download via GitHub Releases (auto-updated by electron-updater). Build artifacts land on a draft release for review before publishing. macOS notarization uses the modern App Store Connect API key flow (`APPLE_API_KEY` / `_KEY_ID` / `_ISSUER`) rather than the legacy Apple-ID + app-specific-password path. Per-platform secrets list and the full runbook live in `docs/RELEASING.md`.
- `electron-updater` wired in `apps/desktop/electron/updates.ts`: 15-second startup delay, 4-hour poll, native dialog when an update is downloaded ("Restart now" / "Later"). Auto-skipped in dev and on Windows when the running build is a Microsoft Store-installed AppX (so the Store and electron-updater never race over the same install).

### Changed
- `apps/desktop/package.json` `build` block: Windows target switched from NSIS to AppX/MSIX with the Partner Center identity (`UgurLabs.UgurLabs.OpenAgents`, `CN=E5B1EEE1-…`, publisher `UgurLabs`); macOS target tightened to Apple Silicon DMG + ZIP with `hardenedRuntime: true`; GitHub publish provider added so electron-updater knows which release feed to read.

### Removed

### Fixed

### Security

## [0.1.0] - 2026-05-16

First public release. Private preview showcase. Tenant-data-local-by-default desktop platform for Microsoft 365 admins. Four bundled reference agents, two authoring paths (YAML by hand or NL2Agent draft), full transparency UI over both, gated real Graph writes, static schema + Graph QA gate.

Versioned packages: root `0.1.0`, `@openagents/agent-sdk@0.1.0`, `@openagents/runtime@0.1.0`, `@openagents/qa-graph@0.1.0`, `@openagents/desktop@0.1.0`.

### Added
- `agents/os-update-posture/` — third canonical Agent Template in the `updates` category. Reads `managedDevices` once and tallies the fleet twice with `count-by-field` (once on `operatingSystem`, once on `osVersion`) so end-of-life builds (Windows 10.21H2, 10.22H2) surface distinctly from current builds (11.23H2). Optional LLM step calls out the biggest update risk. YAML-only, no companion TypeScript. Smoke-verified against the synthetic fixture: 13 Windows / 5 macOS / 3 iOS / 1 Android, 12 distinct OS builds; 6 of 13 Windows devices on Windows 10 lines. Doubles as the reference shape NL2Agent should be able to draft from a plain-English prompt.
- NL2Agent renderer: the New agent button on the hub used to be dead chrome — it now opens a two-pane flow. Pane one is a prompt textarea with a quick capability cheat-sheet and a clear callout when the LLM provider isn't reachable. Pane two is a full Manifest Preview of the generated YAML (the same component used on AgentDetail) plus inline validation errors when the LLM produced a schema-incompliant draft. Save & install wires through to `saveAgentDraft` + `installAgent` and routes the user straight to the new agent's detail page so they can run it.
- NL2Agent backend: `draftAgentManifest(prompt)` + `saveAgentDraft(yaml)` IPC + runtime support for a second, user-writable agents root under `userData/agents/`. `draftAgentManifest` sends a structured prompt (system message + JSON Schema reference + worked example) to the active LLM provider, strips any markdown fences, parses + schema-validates the YAML, and returns either the parsed manifest or a list of validation errors. `saveAgentDraft` writes `manifest.yaml` + a projected `manifest.json` under `userData/agents/<slug>/` and refuses to shadow a bundled slug. The runtime's `listAllRegistryAgents(userRoot?)` merges both roots into a single de-duplicated registry; user-authored agents stamp their absolute path on `registryPath` so the dir resolver picks them up without colliding with the bundled tree.
- `agents/compliance-overview/` — the second canonical Agent Template. Read-mode agent in the `compliance` category that counts managed devices by `complianceState` (compliant / noncompliant / unknown) and optionally polishes the result with a local LLM summary. Ships as YAML only (no companion TypeScript), proving the YAML-only authoring path works end-to-end. Adds a new `count-by-field` transform kind to the runtime (one function, accepts an optional pinned bucket list so the result shape stays stable across tenants). Schema enum updated to allow it; new agent validates against `schemas/agent-template.schema.json` on first try. Smoke-verified against the synthetic graph fixture: 7 of 22 noncompliant, 3 unknown — summary string renders correctly.
- JSON Schema for Agent Template manifests at `schemas/agent-template.schema.json`. Mirrors the SDK types and is the authoritative shape for every `agents/<slug>/manifest.yaml`. The YAML Language Server directive at the top of each manifest gives editors live autocomplete and validation as authors type. `npm run qa` now adds a schema-validation pass over every YAML manifest (alongside the existing Graph QA + fixture checks); malformed manifests fail CI with a structured diff against the schema. Schema authoring guidance lives in `schemas/README.md`.
- Install-time settings for Agent Templates. AgentDetail's "Configure" button now opens a modal that renders one input per declared `definition.settings[]` entry (integer / string / boolean). Values are validated client-side and re-validated on the host (type-coercion plus unknown-key dropping) before persisting onto `AgentSummary.settings`. At run time the interpreter merges the persisted overrides on top of YAML defaults via `ctx.settings`. Manifest Preview's "Configurable settings" card surfaces both `default:` and `current:` chips for transparency. Smoke-verified end-to-end: overriding retire-inactive-devices' `retireDays` from 180 → 90 grows the plan from 4 to 8 devices and re-renders the confirmation phrase as `RETIRE 8 DEVICES`.
- `write` step format in Agent Templates. Write-mode agents now declare a `write` skill with `kind`, `source`, `confirmationPhrase`, and `actionTemplate` (rendered once per source item). The interpreter pauses on plan, builds a `WritePlan`, and dispatches each approved action to a registered handler (`retire-managed-device` for v0.1). `retire-inactive-devices` migrated from TypeScript to `manifest.yaml`; behaviour against synthetic Graph fixtures is identical (4 candidates, phrase `RETIRE 4 DEVICES`, per-device retire calls on apply). Manifest preview UI renders the write step with its kind, source, confirmation phrase, action template, and required scopes — every promise of transparency now applies uniformly across read and write agents.
- Initial project handoff: SPEC.md, CLAUDE.md, design mockups, contributor docs.
- v0.1 (private preview showcase) scope locked in SPEC.md §5a with phased plan in `tasks/todo.md`.
- Onboarding now installs a built-in registry agent through Electron IPC and routes into a live `/runs/:id`.
- `/runs/:id` shows a streaming/live state (pulsing indicator, running-step pulse, live elapsed) while a run is queued or running.
- Agent execution contract in `@openagents/agent-sdk`: `RunContext`, `AgentModule`, `ManagedDeviceRecord`, `RunGraphApi`. Each built-in agent now lives as a TS workspace package under `agents/<slug>/`.
- Synthetic Graph fixture and `executeRun` driver in `@openagents/runtime`. Agents emit their own steps, logs, and result; runtime streams every snapshot via `onProgress` and captures throws as `failed`.
- `agents/find-inactive-devices/` is the first real agent: computes inactivity buckets from the synthetic fixture instead of returning a hardcoded result.
- Two-phase write agent contract (`plan` + `apply`) and a real diff confirmation flow: `RunStatus` adds `awaiting-confirmation` / `rejected`, `RunRecord` carries the persisted `WritePlan`, IPC adds `confirmRun(runId, phrase)` / `rejectRun(runId)`. `/runs/:id` renders the diff confirmation inline; the standalone DiffConfirm route is gone.
- `agents/retire-inactive-devices/` is the first write agent: reads the synthetic Graph, plans one destructive `retire-device` action per device inactive ≥180 days, and applies after typed phrase confirmation.
- Static Graph QA gate (`npm run qa`). Each agent manifest now declares a `graphOperations` contract; `@openagents/qa-graph` validates declared scopes, endpoint existence, scope coverage, select fields, and curated sample backing against the local Microsoft Graph index — offline, no auth. Synthetic `ManagedDeviceRecord` fixture is cross-checked against the real `managedDevice` schema.
- Real local LLM streaming via `ctx.llm`. New SDK types (`LlmOptions`, `LlmCompletion`, `LlmStreamChunk`, `RunLlmApi`, `RunStepThinking`) plus an Ollama provider in `@openagents/runtime` that streams chunks from `http://127.0.0.1:11434`. `find-inactive-devices` gets an optional summary-polish step gated on `ctx.llm.available`; the deterministic path still works when Ollama is offline. `/runs/:id` shows a streaming "Reasoning" panel under each step (model name, pulsing dot, blinking cursor).
- CI workflow (`.github/workflows/ci.yml`) enforcing `typecheck` + `qa` + `build` on push to `main` and all pull requests. `scripts/setup-qa.sh` clones the public `merill/msgraph` skill with sparse checkout so CI runners get the QA index without a local Claude install.
- MSAL interactive authorization-code + PKCE flow (read path) via `@azure/msal-node` `acquireTokenInteractive` against the public Microsoft Graph CLI client id. Opens the system browser to login.microsoftonline.com and uses a loopback redirect (registered against the CLI client) so the user only ever signs in on the real Microsoft login page in their own browser. Token cache encrypted via Electron `safeStorage` and persisted to `tokens.bin`. New Settings → Tenants surface (connect / set-active / disconnect) and a `RunGraphApi` adapter against `https://graph.microsoft.com/v1.0` with `@odata.nextLink` paging and 429 / 5xx retry. Runs are stamped with `dataSource: "graph" | "synthetic"`; the synthetic fixture remains the default when no tenant is connected. Write-path remains synthetic — `POST /retire` calls deferred to a future slice.

### Changed
- Desktop framework: Tauri → Electron. Reasoning recorded in SPEC.md §2 ("Why Electron, not Tauri"). Trade: larger binaries (~80–150MB) and higher idle memory accepted in exchange for developer velocity, contributor accessibility, UI fidelity, and parity with the t3code reference architecture.
- Renderer: Next.js 14 App Router → Vite + React + React Router for the Electron renderer. Next.js retained only for `apps/marketing/`.
- Distribution surface narrowed: dropped the `npx openagents` CLI. Desktop app is the only end-user surface.

### Removed
- `apps/cli/` from the planned monorepo layout.
- Mock `LiveRunModal` surface and the `hubAgents` / `data/runs.ts` / `data/providers.ts` / `data/stats.ts` renderer fixtures, replaced by real registry-backed install-and-run.
- Hardcoded simulated run lifecycle (`createSimulatedRun` / `getSimulatedRunRunning` / `getSimulatedRunCompletion`) in `@openagents/runtime`. Runs now come from the agent's own code.
- Standalone `DiffConfirm` page, `data/results.ts` mock, and the `/agents/:slug/confirm` route. Diff confirmation now happens in-place on `/runs/:id` from the persisted plan.

### Fixed

### Security
