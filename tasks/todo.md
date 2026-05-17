# v0.1.4 — Cleanup pass (current)

**Status: planned.** Patch release on the 0.1.x line. No new features, no spec deltas. Tightens UX honesty: wire or remove the stub buttons, drop the synthetic device seed data, and flag the unimplemented provider toggles so the next contributor can't miss them.

## Goals

Stay on 0.1.x. The product shouldn't show buttons that do nothing and shouldn't pretend a synthetic `contoso.com` fixture is real tenant data. Every clickable control either works or is removed; every "I'm a placeholder" surface is labelled as such.

## Scope

### 1. Wire or remove non-functional controls

For each, the rule is: **wire it if the implementation is cheap and honest, hide/remove it if it implies a v0.2+ capability we don't have yet.** No half-finished handlers.

- [x] **Run result header** — Copy report → clipboard plaintext summary; Export → save-dialog JSON; Share → replaced inline button with `ShareMenu` (Copy link + Export as Markdown).
- [x] **Share menu** — items now optional via per-callback props; renders only handlers supplied. Slack entry removed.
- [x] **Agent Hub featured card** — `View manifest` opens a Modal hosting `ManifestPreview`, fetched via `getAgentManifest(slug)`.
- [x] **Settings → Providers row buttons** — `Install guide` opens vendor docs via new `openExternal` IPC; `Configure` button removed.

### 2. Remove synthetic seed data

- [x] **Empty the device fixture** — `SYNTHETIC_DEVICES` is now `[]`; synthetic graph still functions, just returns zero records.
- [x] **Drop the `$0.00` cost cell** — removed from Activity (column + header), RunResult (SmallStat tile), and AgentsHome (stats grid now 3 columns).

### 3. Flag unimplemented provider toggles

- [x] TODO(uli) comment added in `providerCatalog`; new `apps/desktop/src/shared/providers.ts` defines the implemented set; Settings rows and Onboarding cards both show `Coming in 0.2` + are disabled for LM Studio / Anthropic / OpenAI / Azure OpenAI.

### 4. Housekeeping

- [x] CHANGELOG `[0.1.4]` entry populated.
- [x] Root + 4 workspace `package.json` versions bumped to 0.1.4; display strings in Sidebar / Onboarding / Settings updated.

### 5. Post-plan additions (still 0.1.4)

- [x] **Agent uninstall** — `uninstallAgent(slug)` IPC + UI on Agent Detail header. User-authored agents are deleted from disk; bundled agents fall back to the registry.
- [x] **Run cancellation** — `cancelRun(runId)` IPC + soft-cancel in `AppStateStore` (background work finishes silently). `Cancel run` button on the run header during queued/running states. New `cancelled` status surfaced everywhere.
- [x] **First-run UX after empty fixture** — synthetic banner on Agents home with a `Connect tenant` CTA; Onboarding card retitled "Continue without a tenant" with honest copy.
- [x] **Auto-update in-app surface** — main-process updater broadcasts state to the renderer; `UpdateBanner` in the app shell shows "downloading" / "ready" with `Restart now`.
- [x] **Run-start preflight error** — `startRun` fails synchronously with provider-specific guidance ("Start Ollama with `ollama serve`…"); displayed as a dismissable banner on Agents Home + Agent Detail.
- [x] **View manifest on Trending + Hub grid cards** — Trending cards open the modal on click; Hub grid cards get an explicit `View manifest` button.
- [x] **TenantSwitcher inline disconnect** — hover-revealed × on each tenant row with a typed confirm.
- [x] **NL2Agent provider-unavailable hint** — provider-specific guidance baked into the warning.
- [x] **Dead export `getSyntheticInventorySize()` removed.**
- [x] **CommandPalette ⌘K shortcut** — already wired in `AppShell`, discoverable via sidebar button + `⌘K` chip in Agents search bar (verified, no change needed).
- [x] **Multi-tenant guard during runs** — `startRun` pins `run.tenantId` at queue time and `driveRun` builds the graph from `run.tenantId`, not active tenant. `TenantDriftNote` on Run Result already surfaces drift. Verified, no change needed.
- [x] **Settings persistence** — `activeProviderId` round-trips through `state.json` (`isProviderId` parse on read, persisted on `setActiveProvider`). Verified, no change needed.

### 6. Polish bundle (added pre-commit)

- [x] **Bottom status strip** — `StatusStrip.tsx`, mounted in `AppShell`, shows tenant / provider / real-writes / in-flight count.
- [x] **OS run-complete notifications** — `Notification` from main, fired by `AppStateStore.onRunFinished` only when window isn't focused; click handler navigates renderer to the run.
- [x] **Sidebar in-flight badge** — pulsing warning pill on Activity nav item, count live from `state.runs`.
- [x] **Activity text search** — input alongside filter chips, matches agent name / slug / id / summary / provider.
- [x] **Run-detail empty-result callout** — `isEmptyResult` heuristic + contextual info panel (different copy for synthetic vs. real tenant).
- [x] **Copy run ID** — small mono button in run subtitle that copies the full id to clipboard.
- [x] **Settings → About actions** — Run setup again, View on GitHub, What's new.
- [x] **Native application menu** — `Menu.setApplicationMenu` with View / Help submenus including app-data + logs folder shortcuts, navigation accelerators.

### 7. Run detail redesign (added pre-commit)

- [x] **#1 Outcome card** replaces duplicated Run summary — single card with summary, agent description, mode/category pill, counts, and a side panel for data residency.
- [x] **#2 Live telemetry strip** (`RunTelemetry`) under header: Elapsed (live), Steps N/M, Tokens, Model, Cost placeholder.
- [x] **#3 Pipeline timeline** rebuilt with connected status indicators (done/running/pending/failed) and connector lines + per-step durations.
- [x] **#4 Structured result rendering** (`ResultPanel`) — arrays-of-records as tables, bucketed maps as grouped sections, key/value views; raw JSON behind a Show raw toggle.
- [x] **#5 Empty-result callout** surfaces for failed runs too with a "see Logs" pointer.
- [x] **#6 Header decluttered** — subtitle split into two rows (status/data-source/agent-mode on one, timestamp/provider/model/copy-id on a second muted row).
- [x] **#7 TenantDriftNote elevated** to warning tone with `Re-run against current tenant` CTA.
- [x] **#8 Cancel button danger styling** during live runs; bound to Esc keyboard shortcut.
- [x] **#9 Run again preserves tenant pinning** via explicit `{ tenantId }` option.
- [x] **#10 Live elapsed timer** — surfaced both in telemetry strip and continues with "Streaming updates" pulse in header.
- [x] **#11 Logs filter chips** by level with hover-to-copy per line.
- [x] **#12 Reasoning tab** isolates LLM thinking blocks.
- [x] **#13 Tabbed activity feed** (`ActivityFeed`): Pipeline · Logs · Reasoning replaces Steps/Result/Logs trio.
- [x] **#14 "Run in background" button** during live state navigates back to Agents.
- [x] **#15 LLM token telemetry** — Ollama parses `prompt_eval_count` + `eval_count`, runtime accumulates into `RunRecord.tokens`, telemetry strip renders the totals.
- [x] **#16 Failure remediation** (`RunFailureRemediation`) pattern-matched suggestions for common errors.

### Out of 0.1.4 scope (deferred to v0.2)

- GitHub-hosted remote agent registry (currently `./agents` directory only).
- Additional write-action kinds beyond `retire-managed-device` (schema + runtime work).

## Out of scope (explicitly deferred)

These are real gaps but they belong to v0.2 or later, not this patch:

- LM Studio / Anthropic / OpenAI / Azure OpenAI provider implementations
- Real cost tracking (per-token accounting)
- Real Slack / Teams webhook destination
- Real markdown rendering pipeline for run reports beyond plaintext-ish
- Keytar OS keychain (still `safeStorage`)
- SQLite run history
- Graph write POST handler (still synthetic)
- Code signing cert acquisition
- `09-registry.html` and `10-empty-states.html` mockups

## Acceptance criteria

The release is done when **all** of these hold:

1. `npm run typecheck && npm run qa && npm run build` is green.
2. Every button visible to the user in the desktop app does what its label says, or is not visible.
3. Opening the app with no tenant connected and no agents installed shows **no `contoso.com` records anywhere** — synthetic-mode runs complete with empty inventory and a clear empty state.
4. The Settings → Providers list shows `Ollama` as the only enabled provider; the other four are visibly `Coming in 0.2` and `disabled`.
5. CHANGELOG `[0.1.4]` section is populated with concrete entries under `Changed` / `Removed` / `Fixed`.
6. `package.json` and workspace manifests report `0.1.4`.

## How we'll verify

- Manual click-through of every interactive control on every page (8 pages × ~6 controls each).
- Cold-launch the app with `~/Library/Application Support/openagents` removed → confirm no synthetic device data visible anywhere.
- Trigger a synthetic-mode run of `find-inactive-devices` → confirm it completes with zero results, not 22.
- Confirm CI passes on the resulting branch before tagging.

---

# v0.1 — Private preview showcase

**Status: complete.** Tagged as v0.1.0. Signed installers + hosted LLM providers land in v0.2.

The goal of v0.1 was to ship the platform thesis end-to-end against synthetic + real Graph data, so prospective users can evaluate the trust story, the agent template DSL, and the path from "describe what you want" to "agent running on your tenant." Every promise the marketing page makes about local-first, transparency, and human-in-the-loop has a corresponding feature in the desktop app.

---

## What landed

### Platform
- [x] Electron desktop app (Windows + macOS in dev; signed builds in v0.2)
- [x] Vite + React + React Router renderer
- [x] Tailwind design system ported from `docs/mockups/_design.css`
- [x] MSAL interactive authorization-code + PKCE tenant connect against the public Microsoft Graph CLI client
- [x] Encrypted token cache via Electron `safeStorage`
- [x] Ollama local LLM provider with NDJSON streaming + thinking display
- [x] Synthetic Graph fixture as the default data source
- [x] Real Graph adapter for `/deviceManagement/managedDevices` (GET + paging + retry)
- [x] Real Graph writes gated behind tenant-connected + global toggle

### Agent Templates (the DSL)
- [x] `descriptor`, `skills[]`, `definition` shape backed by SDK types
- [x] Liquid-subset templating with `size`, `total`, `length`, `sample`, `default`, `join`, `upper`, `lower`, `type`
- [x] Step formats: `graph`, `transform`, `llm`, `write`
- [x] Transform kinds: `group-by-age`, `filter-by-age`, `count-by-field`
- [x] Write action handlers: `retire-managed-device`
- [x] Install-time settings (integer / string / boolean) — UI + persistence + runtime merge
- [x] JSON Schema (`schemas/agent-template.schema.json`) — editor autocomplete + CI validation
- [x] Manifest Preview component renders pipeline cards, scopes, raw YAML, settings (default + current)

### NL2Agent
- [x] `draftAgentManifest(prompt)` — structured prompt + schema + worked example, parses + validates
- [x] `saveAgentDraft(yaml)` — writes to `userData/agents/<slug>/`
- [x] Two-pane modal flow on the hub: prompt → review → save & install
- [x] Validation errors surfaced inline with raw-YAML disclosure
- [x] User-authored agents stamped with absolute `registryPath` so they coexist with bundled agents

### Reference agents
- [x] `find-inactive-devices` (devices, read) — group-by-age + LLM polish
- [x] `retire-inactive-devices` (devices, write) — filter-by-age + write step + typed confirmation
- [x] `compliance-overview` (compliance, read) — count-by-field with pinned buckets
- [x] `os-update-posture` (updates, read) — two count-by-fields side by side

### QA + CI
- [x] `npm run qa` validates: schema, declared scopes against `merill/msgraph`, endpoint existence, select fields, fixture coverage
- [x] GitHub Actions CI on push + PR: typecheck + qa + build
- [x] All checks green; signed status badge ready for v0.2 installer signing

## What's deferred to v0.2

- Hosted LLM providers (Anthropic, OpenAI, Azure OpenAI) — adapter stubs exist, real wiring + secret storage land with `keytar`
- LM Studio local provider — same shape as Ollama, separate adapter
- Signed installers (Windows EV cert + Apple notarization)
- Auto-update via `electron-updater` against signed GitHub releases
- SQLite migration for run history (currently JSON-backed)
- Scheduled triggers (`triggers[].kind: scheduled`) — manifest already declares them; interpreter only honours manual today

## How to run

```bash
npm install
npm run dev
npm run typecheck && npm run qa && npm run build
```

See [`README.md`](../README.md) for the full quickstart.
