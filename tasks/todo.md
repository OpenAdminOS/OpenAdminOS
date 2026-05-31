# v0.2.1 — Candidate backlog

**Status: proposal.** Follow-up release after v0.2.0. The theme is making the agent ecosystem feel solid: "Build your own Agent" should be reliable enough for non-developer admins, and "Share with the community" should move a local agent into the public Agent Hub without weakening the registry trust model.

## Priority 1 — Make "Build your own Agent" production-grade

- [x] **Rename the surface to "Build your own Agent"** wherever the current UI says "New agent" / NL2Agent, if that is the product wording we want to ship.
- [x] **Guided builder mode** — offer structured fields before the free-form prompt: target area, read/write intent, desired output, schedule intent, and Teams-delivery suggestion.
- [x] **Prompt-to-manifest reliability pass (first pass)** — expanded the drafter guidance for schema v2 patterns: settings, scheduled triggers, `map`, multi-input LLM steps, generic `graph-write`, connector steps, OData query strings, Entra tier hints, and reserved slug avoidance.
- [x] **Draft repair loop** — when generated YAML fails schema / Graph QA, feed the exact validation errors back to the LLM once or twice before showing the user a failed draft.
- [x] **Manual YAML editor** — allow editing the generated manifest before save, with inline schema errors, Graph endpoint/scope errors, and an explicit "validate again" action.
- [x] **Local test run before install** — run a preflight-only check against the active tenant: provider reachable, Graph scopes known, endpoints valid, connector requirements understood. For write agents, the check verifies the typed-confirmation gate and does not apply Graph changes.
- [x] **Agent capability preview** — before Save & install, show a compact summary: Graph steps, required scopes, LLM usage, confirmation tier, provider residency, settings, connector targets, schedule eligibility, and editable version.
- [x] **Better slug/version handling** — drafter now sees reserved slugs, user-authored examples default to `0.1.0`, validation detects slug collisions, collision errors suggest an available alternative, and the review pane exposes version editing.
- [x] **Edit existing user-authored agents** — allow opening a local agent back in the builder, saving as a new version, and preserving install settings, schedule, delivery, and run history.
- [x] **Export local agent bundle** — produce a deterministic local folder containing `manifest.yaml`, `README.md`, and `metadata.json` so the same artifact can be tested, shared privately, or submitted upstream.
- [x] **Builder QA tests** — add builder-focused tests for reserved slug handling, connector declaration validation, and current drafter prompt coverage. Golden prompt snapshots can expand when the builder starts storing prompt examples.

## Priority 2 — "Share with the community" path

- [x] **Share action for user-authored agents** — visible only for local agents from Agent Detail and from the builder success state after Save & install.
- [x] **Submission checklist** — requires description, maintainer display name, support URL or GitHub handle, license confirmation, changelog entry, and explicit privacy/egress notes before submission.
- [x] **Generate upstream-ready files** — generates `manifest.yaml`, `README.md`, and `metadata.json` for the public review issue. Exact `agents/<slug>/` PR layout remains a later PR automation step.
- [x] **GitHub issue intake first** — desktop submits validated payloads to the OpenAdminOS web API; the server uses its GitHub token to create a public `[New Agent]` issue for maintainer review. This avoids desktop GitHub auth and does not publish into Agent Hub.
- [x] **Reviewed GitHub intake, not direct hub upload** — the app creates a public GitHub issue, not a Hub publish. The public Agent Hub only updates after a maintainer converts/accepts the submission through the normal repo review path.
- [x] **Auth model for GitHub** — no desktop GitHub auth. The desktop app posts to the OpenAdminOS web API; the server uses its own GitHub token to create the issue. Duplicate open issues are reused and the endpoint is rate-limited.
- [x] **Pre-submit QA gate** — runs local checks before issue creation: metadata completeness, manifest validation, Graph endpoint/scope validation, write confirmation requirements, connector declarations, LLM-step requirement, README generation, public-issue acknowledgement, and secret scan.
- [x] **Security review flags** — marks high-risk Graph scopes, destructive writes, and external connector egress for maintainer review; secret-like values block submission.
- [x] **Supply-chain stance** — community submissions are manifests, README, and metadata only for now; no arbitrary TypeScript execution from community submissions until sandboxing/signing is designed.
- [x] **User copy** — be explicit that sharing creates a public GitHub issue. Tenant data, run history, prompts, provider settings, tokens, and secrets are never included.
- [x] **Issue template integration** — generated issue body includes what the agent does, scopes, write actions, connectors, QA output, README, metadata, manifest YAML, and checklist answers.
- [x] **Agent Hub review states** — after a successful issue submission, local agent detail shows "Submitted for review" with an Open issue link. The agent does not become public until it is merged and appears in `agents/index.json`.

## Priority 3 — Registry trust and security hardening

- [x] **Manifest provenance** — record source URL, registry ref, manifest SHA-256 when available, installed version, and installed time for every installed public agent.
- [x] **Scope-diff confirmation on updates** — if an update adds Graph scopes, changes write actions, changes connector egress, or raises `minAppVersion`, require an explicit review before applying.
- [x] **Registry CI hardening** — generated `agents/index.json` must only update after QA passes. CI fails on duplicate slugs, invalid semver, missing README, missing LLM step, undeclared scopes, content-safety failures, or stale generated index.
- [x] **CODEOWNERS / maintainer review** — require review for `/agents/**`, schema changes, QA rule changes, and registry generation scripts.
- [x] **Content safety for published agents** — lint README and manifest copy for secrets, tenant identifiers, personal data, and unsupported claims like guaranteed remediation.
- [x] **Compatibility matrix** — every public agent declares `minAppVersion`; the app shows "Update OpenAdminOS" rather than trying to run unsupported DSL.
- [x] **Enterprise fork story** — explicitly deferred. v0.2.1 community sharing targets only the public OpenAdminOS repo intake; private fork submission flows are out of scope.

## Priority 4 — Quality of life candidates

- [ ] **Agent builder docs** — in-app short guide plus README docs for authoring, validating, and submitting agents.
- [ ] **Examples gallery** — prompt examples that generate useful read, write, and connector-backed agents.
- [ ] **Better error messages from Graph QA** — turn low-level endpoint/scope failures into copy a tenant admin can act on.
- [ ] **Screenshots for Agent Hub entries** — generated or user-supplied images in the submission bundle, rendered in Hub detail.
- [ ] **Private share** — deferred beyond 0.2.1; public community submission is the only share target for this candidate.

## Open questions

- [ ] Should the app itself open GitHub PRs, or should it export a ready-to-commit folder and hand off to the browser/`gh`? Direct PR creation is smoother, but introduces GitHub auth surface.
- [ ] Do we allow community TypeScript agents in 0.2.1, or limit community sharing to YAML Agent Templates until sandboxing/signing exists?
- [ ] What minimum fixture coverage should be required for read agents that use endpoints we cannot safely exercise against a real tenant in CI?
- [ ] Should public Agent Hub entries require maintainer verification before install counts and screenshots are shown?
- [ ] What is the review SLA / maintainer ownership model for community PRs?

## Acceptance criteria

1. An admin can describe, validate, save, install, run, edit, and uninstall a local agent without touching the filesystem.
2. Invalid generated agents get repaired automatically when possible; unrepaired failures show exact schema/Graph QA errors.
3. A local write agent cannot be saved or run unless its write actions flow through the existing confirmation gate.
4. "Share with the community" never uploads tenant data, prompts, run results, provider settings, or secrets.
5. Sharing creates a reviewed GitHub PR or an equivalent upstream-ready export; it does not push directly to `main` or publish straight into Agent Hub.
6. Registry CI rejects malformed, overbroad, or incomplete submissions before `agents/index.json` can expose them to users.
7. Agent Hub only shows the shared agent after the PR is merged and the generated index includes it.

# Drop synthetic mode entirely (in-progress, still 0.1.4)

**Status: implemented; not yet shipped.** Going live. No demo tenants, no synthetic fixtures, no fallback fake data. Onboarding becomes a hard gate: connect a real Microsoft 365 tenant or stay on `/onboarding`. Adding further tenants later is direct MSAL sign-in from the existing TenantSwitcher / Settings entry points — no onboarding rerun. Aligns with CLAUDE.md constraint #3 ("No agent runs without an active tenant scope") and removes the trust ambiguity of pretending fake data is a usable state. Version stays on 0.1.4 — this lands as part of the cleanup pass already in flight.

## Why

- CLAUDE.md constraint #3: agents cannot start without an active tenant. Synthetic mode silently bypasses this.
- "synthetic mode" / "synthetic fixture" is jargon a real admin shouldn't have to decode. Either you're connected to a tenant or you're not.
- Going live = product is for real M365 admins running against real tenants. No "explore without connecting" use case past the marketing site.

## Scope

### 1. Routing gate

- [x] `App.tsx`: if `state.tenants.length === 0` AND path is not `/onboarding`, redirect to `/onboarding`. Onboarding is the only path that doesn't require a tenant.
- [x] Drop the `state.activeTenantId === null` ambient case from the app shell — after onboarding there is always at least one tenant.
- [x] Remove the global "Skip" button in `Onboarding.tsx:178` (was wired to `navigate("/")`).
- [x] Step 3 "Connect tenant" cannot be skipped; remove the `onSkip` / "Skip for now" / "Continue without a tenant" code path (`Onboarding.tsx:89,214,494–509`).

### 2. Add-tenant flow (later tenants)

- [x] Adding tenant #2+ is **not** onboarding. Existing `Connect tenant` buttons in `TenantSwitcher` and `Settings → Tenants` already call `connectTenant()` directly — keep that.
- [x] If user disconnects their **last** tenant via TenantSwitcher, the routing gate kicks them back to `/onboarding`.

### 3. Delete synthetic data layer

- [x] Delete `packages/runtime/src/graph-fixtures.ts`.
- [x] Remove the synthetic branch from `packages/runtime/src/graph-adapter.ts` — Graph adapter only talks to real Microsoft Graph; if there's no tenant token, runs fail preflight with a clear error.
- [x] Remove `dataSource: "synthetic"` from the `Run` type and every read site. Every run is live.
- [x] Delete synthetic-related exports from `packages/runtime/src/index.ts`.

### 4. Remove all synthetic-mode UI

- [x] `StatusStrip.tsx:24–34` — collapse the tenant block to always render `tenant: <activeTenant.displayName>`. Drop the no-tenant branch.
- [x] `AgentsHome.tsx:98` — delete the "No tenant — synthetic mode" banner.
- [x] `RunFailureRemediation.tsx:40` — drop the "accept synthetic mode" remediation entry.
- [x] `Settings.tsx:361, 388, 484` — rewrite the three synthetic-fixture copy strings to plain "Connect a Microsoft 365 tenant" language. Delete the "No tenants connected" subtitle branch (unreachable now).
- [x] `Onboarding.tsx:498` — delete the "skip and run against synthetic inventory" copy block along with the skip path.

### 5. Activity filter

- [x] `Activity.tsx`: delete the `"synthetic"` filter variant, the `counts.synthetic` accumulator, and the `Synthetic` chip. `showFilters` reduces to `state.tenants.length > 1` (filter row only relevant for multi-tenant).
- [x] Drop the `dataSource === "synthetic"` filter logic.

### 6. Result panel

- [x] `ResultPanel.tsx:69` — delete the synthetic-data callout entirely.

### 7. Onboarding step 4 ("First agent")

- [x] Audit the post-tenant "run your first agent" step — make sure it executes against the real tenant (no synthetic fallback). If it can't, fail loudly.

## Acceptance criteria

- Fresh launch (zero tenants on disk) routes to `/onboarding` from any URL.
- Onboarding has no "Skip" / "Continue without a tenant" path — step 3 must be completed.
- Disconnecting the last tenant routes user back to `/onboarding`.
- Adding a 2nd+ tenant from TenantSwitcher or Settings opens MSAL sign-in directly; user is not sent back through onboarding.
- `StatusStrip` always shows a real tenant name. The string "synthetic" appears nowhere in renderer source (`rg synthetic apps/desktop/src` returns zero matches).
- `packages/runtime/src/graph-fixtures.ts` is deleted; nothing imports it.
- `Run` type no longer has a `dataSource` field.
- `npm run typecheck` passes; UI smoke-tested in Electron dev.

## Out of scope

- Cached real-tenant data for offline review — separate v0.2 concern.
- Telemetry / analytics — still off, still local-first.

---

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

- Additional write-action kinds beyond `retire-managed-device` (schema + runtime work).

## v0.2 — Repo-as-registry + bundled agent overhaul

**Goal.** The OpenAdminOS repo becomes the registry. The app binary ships with zero agents and fetches everything from `/agents/` in this repo at runtime. The bundled agent set is reframed around three tiers (investigators, advisors, cleanup-with-judgment) so agents demonstrably out-class a PowerShell script.

### Why now

The existing seven agents look like PowerShell scripts with an LLM blurb tacked on (`compliance-overview`, `os-update-posture`, etc.). Agents earn their keep when the task needs judgment, correlation, or synthesis. We need bundled examples that prove the platform thesis, and a distribution model that doesn't lie about "bundled" vs. "community."

### Distribution: repo-as-registry

- [ ] **Index generator** — CI step that builds `agents/index.json` from `agents/*/manifest.yaml`. Entries carry: `slug`, `version`, `author`, `mode`, `category`, scope summary, `manifestUrl`, `sha`, `minAppVersion`. Gate behind the existing agent QA (`npm run qa`) so broken agents never reach `main`.
- [ ] **Runtime fetch + cache layer** — replace filesystem load of `./agents` with HTTP fetch of `index.json` from the configured registry source. Cache index + per-agent manifests to userData. Cache survives offline; refresh on every online launch.
- [ ] **App↔manifest version gate** — app filters out entries whose `minAppVersion` exceeds the current app version, with an "Update OpenAdminOS to use this agent" affordance.
- [ ] **Agent Hub UX** — "Last refreshed N ago" indicator, manual refresh button, per-agent "Update available" badge. Updates are explicit, never auto-applied.
- [ ] **Settings: Registry source** — text field, defaults to `https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents/`. Lets enterprises point at a fork.
- [ ] **Onboarding** — agent index fetch becomes a discrete step after tenant + LLM provider, before the "first agent" step.
- [ ] **Remove binary bundling** — drop the build-time inclusion of `/agents/` in the Electron package; clean up "built-in agent" framing in code and copy.

### DSL extensions (required for the new agents)

Today's DSL is linear `graph → transform → llm-blurb`. Investigators need multi-source correlation; triage agents need per-row reasoning; the CA explainer needs raw-policy LLM consumption.

- [ ] **Parallel/named `graph` steps** — multiple Graph calls per agent, each addressable by id. Steps may depend on each other; runtime executes in topological order.
- [ ] **Multi-input `llm` steps** — `inputs:` block listing named prior-step outputs the LLM step consumes. Template engine resolves into the prompt.
- [ ] **`map` step kind** — applies a sub-pipeline per row of a collection (per-item LLM reasoning, with shared context). Output is the array of sub-pipeline results.
- [ ] **Schema + template engine + QA updates** — `schemas/agent-template.schema.json`, `template-engine.ts`, scope checker, fixture coverage validator.
- [ ] **Bump `schemaVersion` to `2`** — runtime accepts both 1 and 2 manifests; old agents continue to run unchanged.

### Synthetic Graph fixtures (new endpoints)

- [ ] Sign-in logs (`/auditLogs/signIns`)
- [ ] Conditional Access policies (`/identity/conditionalAccess/policies`) + policy evaluation results
- [ ] Directory audit logs (`/auditLogs/directoryAudits`)
- [ ] Secure Score + control profiles (`/security/secureScores`, `/security/secureScoreControlProfiles`)
- [ ] App registrations (`/applications`) + sign-in activity (`/reports/appCredentialSignInActivities`)
- [ ] Existing fixtures extended where needed (guest invitations, group memberships for `stale-guest-cleanup`)

### Bundled agent overhaul

**Investigators (read, multi-source correlation + LLM reasoning).** The killer category — no script can do this.

- [ ] `sign-in-failure-explainer` — pick a user; pulls sign-in logs + CA policy evaluations + device compliance + recent directory changes; LLM names the cause with reasoning.
- [ ] `risky-sign-in-triage` — last-24h risky sign-ins; per-item LLM classifies likely-FP / likely-compromise / unclear with reasoning. Uses `map`.
- [ ] `tenant-change-audit` — directory audit log over a configurable window; LLM groups by change type, flags anomalies.

**Advisors (read, posture/policy reasoning).**

- [ ] `conditional-access-explainer` — loads all CA policies; LLM explains what each does, flags interactions and gaps vs. Microsoft baseline. Qualitative explanation, not a formal simulator.
- [ ] `secure-score-prioritizer` — Secure Score recommendations ranked by tenant shape, with effort estimates.

**Cleanup with judgment (write, multi-criteria reasoning before the diff).**

- [ ] `stale-guest-cleanup` — replaces `disable-inactive-guests`. Guests where: no sign-in 90d AND no app assignment AND no group ownership AND inviter has left. LLM produces per-guest rationale; write step disables with typed diff confirmation.
- [ ] `dormant-app-registrations` — app regs with no recent sign-ins, no owners, stale secrets; LLM groups by likely purpose and recommends keep/disable/delete.

**Reframe the existing read-only set as "Dashboards" (not "Agents").**

- [ ] New `category: dashboard` (or top-level tier) in manifest schema + Agent Hub filter.
- [ ] Move `compliance-overview`, `os-update-posture`, `tenant-health-report`, `user-license-overview` into the Dashboards tier. Be honest in their READMEs — these are LLM-narrated reports, not agents.
- [ ] Keep `find-inactive-devices` + `retire-inactive-devices` as the minimum-viable read+write pair. Reframe READMEs around the LLM-authored cleanup rationale.
- [ ] Delete `disable-inactive-guests` (superseded by `stale-guest-cleanup`).

### Docs

- [ ] SPEC.md §2 Registry model — already updated to repo-as-registry.
- [ ] SPEC.md §5b (new) — bundled agent philosophy: investigator / advisor / cleanup tiers + why dashboards are separate.
- [ ] README + marketing copy — lead with investigators, not dashboards. "An AI sysadmin that reasons across Graph, not a fancier `Get-MgUser`."
- [ ] CONTRIBUTING — how to PR a new agent: scaffold, fixture requirements, QA gate, what gets you into the index.

### Acceptance criteria

1. Fresh install with empty userData → onboarding completes → Agent Hub shows agents fetched from `agents/index.json` in this repo (zero agents bundled in the binary).
2. With no network: previously cached agents are still listed and runnable; Agent Hub shows "Offline — last refreshed N ago" with no blocking errors.
3. Pointing "Registry source" at a fork URL shows that fork's agents instead — verified end-to-end.
4. Pushing a manifest with a `minAppVersion` greater than the running app version → that agent appears with an "Update required" state, not as runnable.
5. `sign-in-failure-explainer` run against synthetic data correctly correlates a CA-policy-induced failure across the four sources and the LLM output names the cause.
6. `stale-guest-cleanup` produces a diff with per-guest LLM rationale; typed confirmation gate works; no write reaches Graph without it.
7. Agent Hub clearly separates "Agents" (investigator / advisor / cleanup tiers) from "Dashboards." The four demoted agents appear under Dashboards only.
8. `disable-inactive-guests` is removed from `/agents/` and from any in-app references.
9. CI gate: invalid manifest, missing fixture, or scope mismatch fails the build and `agents/index.json` does not regenerate.

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
- Cold-launch the app with `~/Library/Application Support/OpenAdminOS` removed → confirm no synthetic device data visible anywhere.
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

# Per-agent over-the-air updates (0.2.0)

**Status: planned.** Today agent updates ride app updates only — manifests load from the bundled tree and `installedAgents[].version` is a never-checked snapshot. We give every installed agent an opt-in "Update available" path that fetches the new manifest from GitHub and applies it without an app upgrade.

## Why

- Agents iterate faster than the app. A bug fix or feature on `offboarding-agent` shouldn't require a 50 MB Electron release.
- The GitHub repo is public; `agents/index.json` already ships `version` per agent and a raw `manifestUrl`. The version-comparison data is already on disk in the registry cache.
- Trust requirement: user-controlled. Click to update, never silent. Same human-in-the-loop ethos as the diff-confirm flow.

## Source of truth — the "meta file" the user asked about

**`agents/index.json` at the registry root is the meta file.** Each entry carries `id`, `slug`, `version` (semver string), and `manifestUrl` (raw GitHub URL to that agent's manifest.yaml). The desktop app fetches this index at launch and caches it to `<userData>/registry-cache/index.json`. To check for updates we compare `installedAgents[slug].version` against `registryIndex[slug].version` — both already in scope, no new metadata file needed.

## Acceptance criteria

- On every `getAppState()`, each entry in `installedAgents[]` gains a derived `updateAvailable?: { version: string; manifestUrl: string }` field when the registry version is newer than the installed version. Not persisted; recomputed on read.
- AgentsHome cards show a chip "Update available → 1.1.0" when present. AgentDetail page shows a prominent callout with current → new version and an "Update" button.
- "Update" button → `updateAgent(slug)` IPC → main process fetches `manifestUrl`, parses + validates against the schema, persists to `<userData>/agent-updates/<slug>/manifest.yaml`, then updates `installedAgents[slug]` with the new registry-summary fields (version, scopes, description, name, mode, category).
- `loadAgentManifestPreview` / `resolveAgentDirectory` check `<userData>/agent-updates/<slug>/` first; bundled tree is the fallback. Other agents are unaffected.
- User settings, schedule, and `installedAt` are preserved across update. Settings keys that no longer exist in the new manifest are dropped silently; the rest are kept verbatim.
- Failure modes are surfaced inline, never silent: network error, schema-invalid manifest, slug mismatch between fetched manifest and registry entry. On failure the previously-installed manifest stays in place.
- No auto-update. No background polling. Detection rides the existing registry refresh on app launch + the user's manual "Refresh" button in the registry panel.
- Tests cover: semver compare, fetch+validate+persist happy path, schema-invalid manifest rejection, settings preservation, slug mismatch rejection.

## Out of scope (deferred)

- Auto-update toggle. Diff modal showing scope additions explicitly (we just list the new scopes inline on the callout). Typed confirmation for scope-adding updates. Per-agent rollback. Background polling between launches.

## Steps

- [ ] `packages/agent-sdk/src/index.ts`: add `updateAvailable?: { version: string; manifestUrl: string }` to `AgentSummary`.
- [ ] `packages/runtime/src/index.ts`: export `compareSemver(a, b)` helper; teach `resolveAgentDirectory` to check a caller-supplied override dir first.
- [ ] `apps/desktop/electron/state.ts`:
  - Inject the override dir (`<userData>/agent-updates`) into manifest resolution.
  - Compute `updateAvailable` in `getAppState()` by diffing installed vs registry cache.
  - New `updateAgent(slug)` method — fetch, validate, persist, refresh state.
- [ ] `apps/desktop/electron/main.ts`: register `openadminos:update-agent` IPC.
- [ ] `apps/desktop/electron/preload.mts`: expose `updateAgent` on the bridge.
- [ ] `apps/desktop/src/state/AppStateContext.tsx`: wire `updateAgent`.
- [ ] `apps/desktop/src/pages/AgentDetail.tsx`: render the "Update available" callout + button.
- [ ] `apps/desktop/src/pages/AgentsHome.tsx`: render the chip on cards where `updateAvailable` is set.
- [ ] Tests in `packages/runtime/src/`: semver compare unit tests.
- [ ] Tests in `apps/desktop/electron/`: update flow happy + sad paths (or move logic into runtime for testability).
- [ ] CHANGELOG `[Unreleased]` entry.
- [ ] `npm run typecheck && npm test && npm run qa && npm run build` green.

## Review

(filled in after execution)

# Offboarding agent (0.1.9 — breaking rename of retire-inactive-devices)

**Status: planned.** Rename `retire-inactive-devices` to `offboarding-agent`, widen its read surface, and reposition it as the open-source replacement for Microsoft's retired Intune Device Offboarding Agent. **No migration shim.** 0.1.9 ships the new agent and overwrites anyone's installed copy of the old one.

## Why

- Microsoft's Security Copilot Device Offboarding Agent retires from the Intune admin center 2026-06-01. It was advisory (suggestion list + one Entra disable); admins did the work manually.
- Our current `retire-inactive-devices` already executes — we should claim the offboarding-agent name and broaden the signal so we're objectively more useful, not just a rename.
- Pre-1.0 install base is small; ugur will force-overwrite in 0.1.9, so a clean break is acceptable.

## Acceptance criteria

- Directory `agents/offboarding-agent/` exists; `agents/retire-inactive-devices/` is gone.
- Manifest `descriptor.id` is `offboarding-agent`, name `Offboarding agent`, package name `@openadminos/agent-offboarding-agent`.
- Pipeline reads **both** `/deviceManagement/managedDevices` and `/devices` (Entra) and correlates by Intune `azureADDeviceId` ↔ Entra `deviceId`. Flags candidates that are stale by both signals (configurable strategy `both` | `intune-only` | `entra-only`, default `both`).
- Staleness signals used:
  - Intune `managedDevice.lastSyncDateTime` exceeds `staleDays`.
  - Entra `device.approximateLastSignInDateTime` exceeds `staleDays`. Note in rationale that this signal is approximate and lags up to ~14 days per MS docs.
- Hard exclusions (never include in plan):
  - `managementState` already in `retirePending` | `retireIssued` | `retireFailed` | `wipePending` | `wipeIssued` | `deletePending` — already in flight.
  - Entra `accountEnabled: false` — already disabled, retire is still meaningful but de-emphasize.
- Required Graph $select fields:
  - managedDevices: add `azureADDeviceId`, `managementState` to existing select.
  - Entra devices: `id`, `deviceId`, `displayName`, `accountEnabled`, `approximateLastSignInDateTime`, `operatingSystem`, `trustType`, `isManaged`.
- New settings:
  - `staleDays` (integer, default 180) — replaces `retireDays`.
  - `strategy` (enum: `both` | `intune-only` | `entra-only`, default `both`).
  - `instructions` (string, optional) — free-text guidance fed into the rationale LLM step (mirrors MS's tuning surface).
- Confirmation phrase becomes `OFFBOARD N DEVICES` (was `RETIRE N DEVICES`). Single write action remains `retire-managed-device` per device (Entra disable is a follow-up; needs runtime change to lift one-write-step cap).
- Required Graph scopes: `DeviceManagementManagedDevices.Read.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All`, **+ new `Device.Read.All`** for Entra correlation.
- All references updated: [agents/index.json](../agents/index.json), [README.md](../README.md), [apps/desktop/src/pages/AgentsHome.tsx](../apps/desktop/src/pages/AgentsHome.tsx), [stats/agents.json](../stats/agents.json), [package-lock.json](../package-lock.json) workspace entry, NL2Agent prompts in [apps/desktop/electron/state.ts](../apps/desktop/electron/state.ts) if any.
- `agents/index.json` no longer carries a `retire-inactive-devices` entry (clean break — anyone hitting the old `manifestUrl` 404s, which is the intended signal to upgrade).
- README, manifest description, and LLM rationale framing use plain offboarding language; no AI-hype.
- `npm run typecheck && npm run qa && npm run build` green.
- CHANGELOG `[Unreleased]` entry calls out the breaking rename and the 0.1.9 force-overwrite plan.

## Out of scope (deferred to its own issue)

- Multi-step write plan (Intune retire + Entra `accountEnabled: false` PATCH in one confirmation). Blocked by [packages/runtime/src/agent-template.ts:114](../packages/runtime/src/agent-template.ts:114) one-write-step cap.
- Defender / ABM remediation guidance links in the diff UI.
- 0.1.9 release machinery (force-overwrite logic on app upgrade) — handled by ugur separately.

## Steps

- [x] `git mv agents/retire-inactive-devices agents/offboarding-agent`
- [ ] Rewrite `agents/offboarding-agent/manifest.yaml` — new id, name, description; add Entra `/devices` load skill; correlation transform; `instructions` setting; offboarding phrase.
- [ ] Rewrite `agents/offboarding-agent/README.md` — offboarding framing, signals, what it does + doesn't do, contrast with retired MS agent.
- [ ] Update `agents/offboarding-agent/package.json` name to `@openadminos/agent-offboarding-agent`.
- [ ] Update [agents/index.json](../agents/index.json) entry (id, slug, manifestUrl, description).
- [ ] Update [apps/desktop/src/pages/AgentsHome.tsx:39](../apps/desktop/src/pages/AgentsHome.tsx:39) hardcoded id.
- [ ] Update [README.md:116](../README.md:116) agent table row.
- [ ] Update [stats/agents.json](../stats/agents.json) key.
- [ ] Update [tasks/todo.md:212](#) and [tasks/todo.md:308](#) historical lines? No — leave history alone except where it would mislead a reader looking at active scope.
- [ ] Grep `retire-inactive-devices` post-change — should only appear in CHANGELOG history.
- [ ] Run `npm run typecheck && npm run qa && npm run build`.
- [ ] Add `[Unreleased]` CHANGELOG entry.

## Companion sweep (separate commit): TODO(uli) → TODO(ugur)

- [x] [CLAUDE.md:60](../CLAUDE.md:60)
- [x] [HANDOFF_PROMPT.md:27](../HANDOFF_PROMPT.md:27)
- [x] [packages/agent-sdk/src/index.ts:1021](../packages/agent-sdk/src/index.ts:1021)
- [x] [apps/desktop/src/shared/providers.ts:3](../apps/desktop/src/shared/providers.ts:3)
- [x] Historical entry in [tasks/todo.md:97](#) left untouched per plan.

## Review

**Status: done, ready to commit.** All acceptance criteria met. `npm run typecheck` clean, `npm test` 53/53, `npm run qa` 77 pass / 20 warn (pre-existing) / 0 fail, `npm run build` succeeds.

**One scope deviation from the original plan:** I told ugur up-front that cross-service correlation needed no runtime change — that was wrong. The runtime only shipped five transform kinds (`group-by-age`, `filter-by-age`, etc.), none of which can join two arrays. Added a new `correlate-stale-devices` transform kind in [packages/runtime/src/agent-template.ts](../packages/runtime/src/agent-template.ts) plus a one-line relaxation of `transformSkill.settings.required` in [schemas/agent-template.schema.json](../schemas/agent-template.schema.json) so the new kind validates without forcing a `source` key. Same shape as existing transforms; minimal blast radius.

**What landed:**
- `agents/offboarding-agent/` (manifest + README) replacing `agents/retire-inactive-devices/`.
- Reads Intune + Entra, correlates by `azureADDeviceId` ↔ `deviceId`, filters by strategy (`both` | `intune-only` | `entra-only`), excludes in-flight management states, surfaces `instructions` to the rationale LLM.
- Confirmation phrase: `OFFBOARD N DEVICES`.
- Registry, top-level README, stats, AgentsHome.tsx, package-lock.json all updated. No alias for the old slug — clean break as requested.

**Deferred (separate work):**
- Multi-step write plan (Intune retire + Entra `accountEnabled: false`). Blocked by the one-write-step cap in [packages/runtime/src/agent-template.ts:114](../packages/runtime/src/agent-template.ts:114).
- 0.1.9 force-overwrite logic on app upgrade — ugur owns this.

## How to run

```bash
npm install
npm run dev
npm run typecheck && npm run qa && npm run build
```

See [`README.md`](../README.md) for the full quickstart.
