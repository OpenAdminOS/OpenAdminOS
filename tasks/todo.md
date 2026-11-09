# Current active plan

- [ ] Managed configuration, issue #176 (branch `managed/policy-file`, PR #177). Built: policy file paths, schema, parsing with line numbers, precedence, main-process enforcement for providers, models, public references and the app registration, Settings and notice UI, configuration audit events, IT admin docs.

  Acceptance criteria:
  1. With a policy that allows only local providers, no hosted provider is offered or selectable anywhere, and the main process refuses one for Chat, agents and tests.
  2. With a policy that sets a provider and model and `skipFirstRunScan`, a fresh install whose policy provider is ready skips the scan, opens at Connect Microsoft 365, then Chat with that model.
  3. A setting the policy sets shows "Set by your IT department" and cannot be changed.
  4. An invalid policy file shows a designed error naming the file, the line and the problem (Settings and a one-time notice); only invalid keys fall back to no policy.
  5. Policy load, change, removal and problems are recorded in the configuration audit.

  - [x] First-run scan integration (after #175 merged): the scan checks only allowed providers and keeps the policy provider selected, a locked provider shows as set by IT in the model choice, and `skipFirstRunScan` with a ready policy provider skips the scan and opens at Connect Microsoft 365.

- [ ] Chat hardening mega PR (branch `fix/chat-hardening`, decision Ugur 2026-10-25: one PR for all findings) from the [2026-10-24 full Chat test](./chat-full-test-2026-10-24.md) including the live addendum.

  Deliverables (one PR, staged commits): (0) diagnose and fix investigative Chat on the Codex provider; (1) evidence guard for tenant-data finals plus deterministic flip with visible notice on repeated protocol failure; (2) tenant-scoped conversations; (3) picker provider switch, Azure send gate, Gemini selectability, fail-closed provider resolution; (4) cache invalidation after confirmed write runs, `graph_get` paging, sources from executed traces, model-facing staleness aligned to host TTLs, named-scope 403s; (5) single agent matcher with read/write badge, expanded write-intent routing, bounded conversation memory; (6) actionable error notices, streaming live region, per-stream cancel, Node 22 pin with Node 26-safe test setup, SPEC and CHANGELOG reconciliation.

  Product defaults taken (veto any): conversation list/search/read/mutate/export show the active tenant only (multi-tenant conversations keep their existing scope handling); Gemini becomes selectable via a default model entry instead of being hidden; conversation memory is the last 4 turns as plain text with a hard character cap; write-intent block short-circuits before cache refresh and model calls on every send path.

  Acceptance criteria:
  1. On every advertised provider, one investigative tenant question produces at least one investigative `chat_tool_calls` row, or the answer is deterministically generated with a visible engine notice. A prose-only model reply can no longer persist as a clean completed tenant answer (unit test at the loop boundary, plus provider contract test with a fake prose-only provider).
  2. With tenant B active, tenant A conversations are absent from list and search, and read/rename/delete/pin/export by id are refused in the host (cross-tenant test). Follow-up send behavior unchanged.
  3. Picking another provider's model in Chat activates that provider; the next message is stamped with the new provider (renderer test). A configured Azure provider can send from Chat without the setup loop. A missing persisted provider fails closed with a named error instead of falling back to `providers[0]` or a no-op LLM.
  4. After a confirmed write run, affected cache resources are stale on the next question (host test). `graph_get` follows `@odata.nextLink` within its row budget and reports truncation. Answer sources list only resources actually read, and the header shows the oldest source age.
  5. One matcher serves host and renderer; the executed probe table from the report passes as a maintained test (including no offboarding suggestion for the stale-guest read phrasing, sign-in question matches on both surfaces, grant/update requests route as write intent). Suggestion cards show a read/write badge and scopes collapsed.
  6. A follow-up like "Show only the Windows ones." receives the prior turn context (host test on prompt assembly). Non-send Chat errors render a recovery action. The stopped/cancelled behavior stays byte-identical in outcome.
  7. Gates green on Node 22: repo `npm run typecheck`, `npm test`, `npm run qa`, renderer suite, `npm run smoke:intune-chat`. Renderer suite also passes on Node 26. Separate evaluator agent plus GPT-6.1-Sol full-diff review with no open blocking findings before merge readiness is claimed.
  8. Live retest on a dev build against ugurlabs.com: Codex compliance question answered from tools or deterministic notice path, picker switch honored, write prompt blocked in under 5 seconds without a cache refresh storm.

## Nightly update channel (branch `feature/nightly-channel`)

Decisions (Ugur, 2026-10-23): build after every merge to `main`, channel name "Nightly", Linux packages attached to the prerelease but never published to apt. Design ported from TenuVault (`origin/main`, including #219).

- [x] Pipeline: `auto-tag.yml` cuts a stable release when the package version is untagged, otherwise dispatches a nightly when app paths changed since the last `v*` tag.
- [x] Pipeline: `release.yml` resolves the channel in a `meta` job; nightlies skip the release gate (CI already passed on that commit), set `X.Y.Z-nightly.YYYYMMDDHHMMSS` and the `nightly` update channel at build time, publish a signed prerelease with `--latest=false`, prune to 20, and never touch apt.
- [x] App: channel-aware updater (ported from TenuVault), newer stable offered to nightly users, Settings > About toggle and "Check for updates", Nightly badge in the status strip.
- [x] Docs: `docs/RELEASING.md`, `docs/SPEC.md`, `CHANGELOG.md`.

Acceptance criteria:
1. A green CI run on `main` whose diff since the last `v*` tag touches only `stats/`, `web/`, `docs/`, `tasks/`, `.github/` or root Markdown dispatches nothing.
2. A green CI run on `main` with an app change and an already-tagged package version dispatches exactly one nightly; a release-prep merge still cuts the stable release and no nightly.
3. A nightly run publishes a GitHub prerelease tagged `vX.Y.Z-nightly.<14 digits>` (X.Y.Z = newest stable patch + 1) containing signed Windows and notarized macOS installers, Linux packages, `nightly.yml`, `nightly-mac.yml`, and `SHA256SUMS.txt`; it is not marked latest, so `/releases/latest` and the website keep pointing at stable.
4. Stable tag releases behave exactly as before (same gate, assets, CHANGELOG notes, apt publish).
5. Nightly runs never deploy the apt repository and fail if signing secrets are missing.
6. A stable install never offers a nightly. A nightly install offers newer nightlies and any newer stable. Turning nightly off on a nightly install offers the current stable even if older. Updates from a previous channel are cancelled or discarded.
7. Version tooling, notes generation, and updater channel logic are covered by tests that run in CI.

Review (2026-10-23): all seven criteria pass. Separate Claude reviewer plus three GPT-6.1-Sol rounds (approved in round 3). Fixed from review: macOS install-time channel lock, prerelease guard on apt backfill, pipefail-safe path listing, queued nightlies with a `skip` re-check so the hourly stats commit cannot restart a build, never publishing a commit an existing tag already contains, switch-before-save for the channel preference, Privacy/About channel sync. Declined: discovering nightlies beyond GitHub's Atom feed window (needs 10+ consecutive non-nightly releases; the paginated REST fallback would hit the 60 requests/hour unauthenticated limit). Verified locally: typecheck, 450 desktop, 214 renderer (Node 22), 8 script tests, actionlint, a nightly-versioned macOS package writing `nightly-mac.yml` and `channel: nightly`, and the Settings and status-strip UI in the dev app. Not verified locally: Windows NSIS packaging (needs Rosetta) and signed publication; the first nightly after merge is that check.

- [ ] Prepare **0.6.4** after PR #91: fix issue #89 where a Windows provider-probe `spawn EINVAL` aborted tenant connection. Batch launchers are resolved or refused, synchronous spawn failures are contained, and provider checks are isolated. Verified on the Windows mini PC and macOS.
- [ ] Close the known Chat, Nova and Agent Team demo blockers using the [0.6.3 live desktop readiness plan](./demo-readiness-063-plan.md), then verify the signed installed build against the configured tenant/providers.

- [x] Prepare **0.6.3 CLI providers** in PR #88: Copilot/Gemini adapters and PR #85 discovery/auth fixes are implemented. Native protocol tests passed on Linux, Windows, and macOS; live Mac Codex/Claude completions passed. Authenticated Copilot/Gemini tests remain unverified because no accounts are available. Evidence: [CLI provider review](./v0.6.3-cli-provider-review.md).

- [x] Prepare **0.6.2** after PR #86 with Cache, Nova voice and web research, reviewed connector delivery, formatted conversations, and aligned installer/update metadata. Publish through the signed release workflow after all gates pass.

- [x] Prepare **0.6.1** after PR #83: guided teammate setup, native office fullscreen, correct workflow evidence, and Windows reliability/security fixes. Linux, macOS, and Windows native-flow and visual evidence is recorded in the 0.6.1 review reports. Full publication is authorized and follows release validation.

- [x] Prepare Agent Team as version **0.6.0**, with aligned workspace versions, release notes, and a 0.6.0 minimum for the new evidence workflows. Published as v0.6.0 on 2026-09-11.

- [x] Implement the approved [Agent Team significant improvement plan](./agent-team-improvement-plan.md): proactive evidence handoffs, bounded Chief planning, findings/conversations, operational schedules, and a conference rehearsal. Cross-platform hardware validation remains a release gate.

- [x] Agent Team: persistent personas, tenant/provider-pinned sequential assignments, recurrence, live room/list views, briefings, and host/renderer/Electron verification. Human collaboration and desktop avatars remain follow-ons.

The current v0.4 activation decision is tracked in [v0.4-contextual-activation.md](./v0.4-contextual-activation.md): a fresh install opens the real Chat-first shell, while tenant permissions, Microsoft sign-in, provider repair, and explicit action resumption appear only when required. The earlier UX simplification direction remains in [v0.4-ux-simplification-round-2.md](./v0.4-ux-simplification-round-2.md), with measurement in [v0.4-quality-gap-closure.md](./v0.4-quality-gap-closure.md). The functional hardening pass covers full Graph paging, beta-only connector calls, non-idempotent retry safety, tenant-data purge, capped-cache drift semantics, signed, revision-protected, and digest-pinned agent delivery, fail-closed connector confirmation, secure-store enforcement, updater error UX, version 0.4.3 metadata, CI/release smoke gates, stable macOS/Linux upgrade identities, and legacy JSON/SQLite migration coverage. Tagged releases wait for green main CI and build the signed Windows x64 NSIS installer, macOS, and Linux; Windows AppX validation remains an explicit manual action for the deferred Microsoft Store path. External Intune-admin sessions plus Windows High Contrast and cross-platform zoom checks remain release evidence, not completed implementation claims.

---

# v0.3 — "Ask anything, run it anywhere"

**Status: implemented on `v0.3-dev`; release gate partially complete (see below).** The theme: Intune Chat becomes agentic, and every advertised LLM provider actually works. Supporting work (retention, audit export, honest docs, accessibility) serves one story — a tool you can trust to think about your tenant, locally.

## Phase 0 — Foundations
- [x] Doc honesty pass: README shipped-vs-coming table, agent count, `web/` path, `docs/agent-sdk.md` authored, dead renderer `types.ts` removed.
- [x] Write-plan safety test hardening: typed-phrase enforcement, plan/apply mismatch rejection, tenant pinning, run-confirmation host tests.
- [x] `state.ts` decomposition, four verbatim stages: module helpers → `intune-chat/service.ts` → `run-delivery.ts` → `runs.ts`. 10,036 → 4,678 lines; `confirmRun` verified byte-identical.

## Phase 1 — Provider completeness (6/6)
- [x] Anthropic via local Claude Code CLI (no stored API key, scrubbed spawn env, min version 2.1.200).
- [x] LM Studio via local OpenAI-compatible server (loopback trust classification).
- [x] Azure OpenAI API-key variant: endpoint/deployment/api-version in state, key in safeStorage only, write-only Settings form, `hasKey` boolean to renderer. Entra ID auth variant deferred to v0.4.

## Phase 2 — Agentic Intune Chat (flagship)
- [x] Read-only tool layer: `list_cached_resources`, `query_cache`, `graph_get` (GET-only, catalog/scope validated), `refresh_resource`; every call streamed and persisted to `chat_tool_calls`.
- [x] Bounded prompt-JSON loop: 6 iterations, 50-row caps, 24 KB Graph payloads, one repair attempt, visible deterministic fallback.
- [x] Rollout: three-state investigation mode (auto / always agentic / always deterministic) with a conservative small-model heuristic; multi-tenant chat stays deterministic.

## Phase 3 — Trust & safety
- [x] Run-history retention: keep-last-500 / 180-day defaults, never-prune option, startup + scheduler + manual pruning; workspace-pinned, live, and awaiting-confirmation runs are never pruned.
- [x] Audit log export: JSON/CSV with SHA-256 hash chain over run lifecycle, write confirmations, connector deliveries, and hosted-provider consent events. Signed timestamps deferred.
- [x] Renderer test baseline (Vitest + Testing Library) for write confirmation, hosted consent, provider settings.

## Phase 4 — UX polish
- [x] Mockups `09-registry.html` + `10-empty-states.html` and empty-state sweep.
- [x] Reusable output panes shared by chat artifacts, run results, and the tool trace.
- [x] Examples gallery on the marketing site (`/examples`).
- [x] Accessibility basics pass across v0.3 surfaces + clear existing offenders.

## Release gate — remaining before tagging v0.3.0
Run under xvfb after installing Ollama locally (2026-07-05):
- [x] Hub screenshots per registry entry (`xvfb-run -a -s "-screen 0 1600x1000x24" npm run screenshots`).
- [x] Smoke scripts: `npm run smoke:intune-chat` and `npm run smoke:report-issue` pass under xvfb. Fixing the run surfaced and fixed a write-intent false-positive bug (whole-word matching) plus smoke-driver drift from the a11y label change and pre-LLM write blocking.
- [x] Live provider matrix: Ollama probe/complete/stream live (llama3.2:1b; qwen2.5:7b holds the investigative JSON protocol), Claude Code and Codex adapters complete real prompts, LM Studio verified live against a headless 0.4.18 server (probe connected + model list, complete, stream; 0.5b model correctly triggers the deterministic-mode heuristic). Azure OpenAI verified against Microsoft's GA 2024-10-21 data-plane reference instead of a live resource per Ugur (URL shape, api-key header, api-version, body fields, SSE data:[DONE]); note: o-series models on newer api-versions need max_completion_tokens, fine on GA with standard chat models.
- [ ] Optional visual pass on a real desktop session (`npm run dev`) — xvfb screenshots reviewed and look correct.
- [ ] `git tag v0.3.0` + release once the above pass.

## Phase 5 — Tenant drift timeline (added to v0.3 scope 2026-07-05)
"What changed in my tenant since Friday, and who changed it?" — versioned config snapshots on every cache refresh, a deterministic diff engine, audit-log attribution, a Changes timeline UI, and a chat tool. Read-only throughout; the LLM never computes diffs, only summarizes them.

Graph facts verified live via Lokka (tenant ffc10f05): `deviceManagement/auditEvents` works on v1.0 with existing scopes (`$filter=activityDateTime ge`, `$select`, `$top`; carries actor UPN/app, target `resourceId`, per-property old/new values); `auditLogs/directoryAudits` v1.0 supports the same time filter (initiatedBy.user, targetResources[].id). Attribution = join diffed object id ↔ audit target id within the snapshot window.

- [x] D1 — Snapshot + diff core (electron): `drift_snapshots` + `drift_object_versions` tables (interval representation: first/last snapshot per content-hash version, removal marking), hook in `replaceGraphResources` (same transaction), config-tier tracked-resource list, per-resource volatile-field ignore lists, canonical JSON + SHA-256 content hashing, pure diff engine (added/removed/modified with field-level before→after paths), retention pruning, heavy unit tests.
- [x] D2 — Drift service + attribution + IPC (electron): timeline/diff query APIs, `intuneAuditEvents` added as a cached Graph resource with newest-first capped refresh, actor correlation (matched vs unknown — never guessed), agent-sdk types, validated IPC + preload bridge.
- [ ] D3 — Changes UI (renderer): `/changes` route + sidebar entry, day-grouped timeline with resource/actor/date filters, field-level diff detail pane (reuse output panes + diff-confirm visual language), pin-to-workspace evidence, designed empty state ("history starts with your second refresh"), accessibility bar, renderer tests.
- [x] D4 — Chat tool + settings + docs: read-only `query_drift` chat tool (capped, traced), planner prefetch hints for change questions, drift retention setting in Settings, SPEC.md section, CHANGELOG under [0.3.0], `/changes` screenshot added to the capture harness.
- [ ] D5 — Review gate: full test chain, smoke under xvfb, screenshots refresh, PR #62 update.

## Deferred to v0.4+
- Agentic multi-tenant chat; Azure OpenAI Entra-auth variant; Windows signing; light theme; localization; full WCAG audit; agent signing/verification; cost budgets; signed audit timestamps.
- Drift follow-ons: expiry radar, threshold watch rules, golden-tenant config diff, device-inventory drift tier (aggregate-level).

---

# v0.2.5 — Workspaces + multi-tenant Intune Chat

**Status: implemented and verified.** Follow-up release after v0.2.4. The theme is making OpenAdminOS better for MSP-style investigation without weakening tenant boundaries: Intune Chat can explicitly answer read-only questions across selected tenants, while Workspaces keep a single tenant problem, its evidence, related conversations, agent runs, notes, and approved local instructions together.

## Product stance

- **Intune Chat supports explicit multi-tenant read aggregation.** The default remains the active tenant; all-tenants or selected-tenants scope requires a visible scope review before Graph refresh or model prompting.
- **Tenant groups are local shortcuts, not new tenant scopes.** Groups such as "All customers", "Pilot tenants", or "EU tenants" resolve to explicit tenant ids in the scope review before anything runs.
- **Saved queries are reusable prompts with declared scope hints.** They speed up common MSP investigations without silently broadening tenant access.
- **Multi-tenant chat is not Workspaces.** Cross-tenant Intune Chat results can be exported locally or split into tenant-specific workspace evidence, but Workspaces remain single-tenant.
- **The surface is called Workspaces.** Workspaces are tenant-scoped investigation containers, not generic projects.
- **Workspaces organize evidence; they do not bypass safeguards.** Agent runs still require an active tenant, write agents still pause for confirmation, and hosted providers still require explicit tenant-context confirmation.
- **Local-first remains literal.** Workspace metadata, notes, pinned evidence, linked chat context, approved instructions, and exports are stored locally in SQLite/userData.
- **Freshness is part of the object.** Pinned Graph evidence must show source, tenant, row count or object identity where available, cache/live status, and refreshed time.
- **Workspaces is top-level navigation.** Route Workspaces at `/workspaces`, place it directly after Intune Chat, and use contextual add/link/pin actions from Intune Chat, Activity, and Run Detail.
- **No silent workspace magic.** A workspace can suggest relevant chats, sources, and agent runs, but it does not secretly attach broad tenant context to prompts.

## Priority 1 — Multi-tenant Intune Chat scope and UI

- [x] **Tenant scope selector** — add an Intune Chat scope control with Active tenant, Selected tenants, and All connected tenants. Active tenant remains the default.
- [x] **Tenant groups** — add local tenant groups that can be selected in the scope control and expanded into explicit tenant checklists during scope review.
- [x] **Saved query gallery** — add a compact saved-query picker for common multi-tenant investigations such as Windows compliance, stale devices, BitLocker gaps, risky sign-ins, and Conditional Access gaps.
- [x] **Prompt scope detection** — detect phrases such as "all tenants", "every connected tenant", and "all customers" and open scope review instead of silently using the active tenant.
- [x] **Scope readiness preflight** — before a multi-tenant run starts, classify each selected tenant as ready, expired, missing scopes, stale, throttled, or skipped, with a visible recovery path.
- [x] **Scope review panel** — render tenant checklist, resolved group membership, resource kinds, cache freshness, missing scopes, expired sessions, provider/model, and skipped-tenant warnings before any multi-tenant work starts.
- [x] **Per-tenant progress card** — show queued, refreshing cache, reading local cache, building result, skipped, failed, or ready for each selected tenant inside the assistant response slot.
- [x] **Aggregate result view** — render summary tiles and a tenant comparison table for multi-tenant answers. For the Windows compliance prompt, show tenants scanned, Windows devices, compliant, non-compliant, unknown, failed tenants, and stale-data caveats.
- [x] **Answer artifact layout** — let table-heavy multi-tenant results span the conversation column while keeping prose at readable chat width; keep tenant columns visible and contain horizontal overflow inside the artifact.
- [x] **Expandable tenant detail** — let admins expand a tenant row to inspect device-level rows with tenant, device name, compliance state, OS, OS version, last sync, owner, and source freshness.
- [x] **Result filters** — filter multi-tenant result tables by tenant, readiness, compliance state, OS, stale data, and failed/skipped tenants.
- [x] **Local exports and dossiers** — export multi-tenant results as CSV, Markdown, JSON, or a local dossier that includes query text, tenant scope, provider, freshness, skipped tenants, summary, and detail rows. Exports are explicit local file saves, not connector sends or background uploads.
- [x] **Split to workspaces** — from a multi-tenant result, create/link separate tenant-specific workspace evidence entries without creating a mixed-tenant workspace.
- [x] **Hosted-provider batch confirmation** — when a hosted provider is active, confirmation names every selected tenant or shows an expandable tenant list and states that retrieved context from those tenants will be sent to the provider.

## Priority 2 — Multi-tenant host support

- [x] **TenantScope contract** — add a chat input scope shape for active, selected tenant ids, and all connected tenants. Validate selected tenant ids in Electron main.
- [x] **Tenant group store** — persist local tenant groups with id, name, tenant ids, updated time, and no tenant data beyond membership metadata.
- [x] **Saved query store** — persist saved query templates with title, prompt text, resource hints, default scope hint, and local-only ordering metadata.
- [x] **Separate multi-tenant stream IPC** — add a distinct multi-tenant chat stream path instead of overloading the existing single-active-tenant chat send.
- [x] **Conversation tenant guard** — block appending to a single-tenant conversation when the active tenant no longer matches the conversation tenant; offer to switch tenant or start a new conversation.
- [x] **Multi-tenant conversation marker** — store multi-tenant chat conversations with explicit scope metadata so history/search can badge them separately from tenant-scoped chats.
- [x] **Scope preflight service** — compute readiness before execution, including account/session state, required delegated scopes, cache freshness, and recent throttle/failure signals.
- [x] **Deterministic cross-tenant query helpers** — add SQL helpers for grouped read-only questions such as Windows device compliance by tenant, using cached `tenant_id`, `operating_system`, and `compliance_state`.
- [x] **Graph cache fan-out** — refresh selected tenants with bounded concurrency and per-tenant failure state. One throttled or expired tenant must not fail the whole answer.
- [x] **Multi-tenant chat job records** — introduce a local job record for cross-tenant chat queries, including preflight state, resolved tenant ids, saved-query id when used, export artifacts, and run duration.
- [x] **Cross-tenant agent batch records** — agent batches queue one normal tenant-pinned `RunRecord` per tenant.
- [x] **Write safety boundary** — multi-tenant chat never applies writes.
- [x] **Cross-tenant write-agent confirmation** — write-agent batches require per-tenant plan review and typed confirmation; no "confirm all tenants" destructive action.

## Priority 3 — Workspace data model and host APIs

- [x] **Workspace schema migrations** — add local tables for workspaces, linked conversations, pinned evidence, linked agent runs, notes, and workspace-local instructions. Keep tenant id scoped on every row.
- [x] **Workspace CRUD IPC** — create, rename, archive/delete, list, and load workspaces through validated Electron main IPC. Renderer must not write SQLite directly.
- [x] **Evidence pinning contract** — define a compact, non-secret evidence reference shape for Graph cache rows, answer-pack sources, chat messages, and run result sections.
- [x] **Split-result import** — accept tenant-specific evidence bundles created from a multi-tenant Intune Chat result and attach only the matching tenant's rows to each workspace.
- [x] **Local deletion semantics** — deleting a workspace removes workspace metadata, notes, pins, and links only; it must not delete chat history, run history, tenant config, Graph cache, or connector audit records.
- [x] **Export format** — export a workspace-local Markdown or JSON dossier with notes, linked chats, pinned evidence metadata, run links, and freshness. Tenant data stays local unless the admin exports it explicitly. Multi-tenant exports are handled by Intune Chat, not Workspaces.

## Priority 4 — Workspaces UI

- [x] **Workspaces route/shell** — add Workspaces as a top-level primary navigation item at `/workspaces`, placed directly after Intune Chat.
- [x] **Workspace list** — show active tenant, workspace title, updated time, pinned evidence count, linked conversations, linked runs, and freshness state.
- [x] **Workspace detail** — layout with notes, pinned evidence, linked chat conversations, linked agent runs, and local instructions. Keep the screen dense and operational, not a card-heavy project board.
- [x] **Adaptive workspace panes** — use a two-pane list/detail layout that can collapse the workspace list at narrower desktop widths without hiding the global sidebar or status strip.
- [x] **Create from chat** — allow creating a workspace from an Intune Chat conversation and linking the current conversation without copying messages into a second store.
- [x] **Create from multi-tenant result** — allow creating one workspace per selected tenant from a multi-tenant Intune Chat result, with a review screen that shows the tenant-to-workspace mapping before writing local records.
- [x] **Pin from chat answer** — allow pinning an answer, source, or source detail into the current workspace with freshness metadata.
- [x] **Link run to workspace** — allow adding an existing run result to a workspace from Run Detail/Activity and from chat-started agent runs.
- [x] **Empty states** — add designed zero-workspace and empty-workspace states with direct actions: start from Intune Chat, link a run, or add a note.

## Priority 5 — Workspace-aware prompting

- [x] **Explicit context attachment** — the composer can attach selected workspace evidence or notes to a prompt. It must show what will be included before send.
- [x] **Hosted-provider confirmation integration** — when workspace context is attached and a hosted provider is active, the confirmation names the workspace, tenant, provider, model, and included context.
- [x] **Workspace instructions storage** — allow approved local instructions per workspace. These cannot add Graph scopes, change agent mode, alter connector egress, or bypass confirmation.
- [x] **Workspace instructions prompt composition** — apply workspace instructions only through explicit prompt/context attachment.
- [x] **Suggestion hooks** — suggest relevant workspaces from matching tenant, conversation title, pinned source kind, or linked run, but never auto-attach context.

## Priority 6 — Verification and docs

- [x] **Host tests** — cover tenant groups, saved queries, multi-tenant scope validation, readiness preflight, per-tenant cache fan-out, partial failures, deterministic aggregation, dossier export, workspace schema migrations, CRUD, split-result import, deletion boundaries, evidence pinning, and export generation.
- [x] **Renderer tests/smoke** — run a saved multi-tenant Windows compliance query from Intune Chat; review readiness; create a workspace from chat; split a multi-tenant result into tenant workspaces; pin a source; link a run; export the workspace; and delete the workspace without deleting underlying chat/run records.
- [x] **UX mockups** — add `docs/mockups/11-multi-tenant-chat.html` and `docs/mockups/12-workspaces.html` before implementation, covering empty, loading, partial failure, hosted-provider, export, split-to-workspaces, and narrow-width states.
- [x] **Accessibility and state review** — verify keyboard access, visible focus, `aria-sort` for sortable tables, icon labels, text+icon status indicators, persisted filters/expanded rows, and long-content truncation with accessible full-value disclosure.
- [x] **Trust copy audit** — verify local/hosted provider copy across multi-tenant Intune Chat, Workspaces, StatusStrip, and export surfaces.
- [x] **GitBook docs** — add admin-facing documentation for multi-tenant Intune Chat and Workspaces, covering tenant scope, tenant groups, saved queries, readiness preflight, result dossiers, what is stored locally, what can be attached to prompts, and how deletion/export behaves.
- [x] **CHANGELOG entry** — record multi-tenant Intune Chat and Workspaces scope under `[Unreleased]` as implementation lands.

## Acceptance criteria

1. An admin can ask Intune Chat for compliant and non-compliant Windows devices across all connected tenants and see a scope review before any tenant data is read.
2. An admin can create local tenant groups and select one during scope review; the UI shows the resolved tenant list before running.
3. An admin can launch saved multi-tenant queries for common investigations and edit the prompt before send.
4. The scope preflight shows ready, expired, missing-scope, stale, throttled, failed, and skipped tenants with recovery paths.
5. The multi-tenant result shows per-tenant progress, partial failures, summary tiles, a tenant comparison table, filters, expandable device rows, and local CSV/Markdown/JSON/dossier export.
6. A multi-tenant result can be split into separate tenant-specific workspace evidence without creating a mixed-tenant workspace.
7. Table-heavy multi-tenant answers use a stable answer artifact layout with keyboard sorting/filtering, text+icon state indicators, and no page-level horizontal scroll.
8. Hosted-provider multi-tenant sends require explicit confirmation for the selected tenants and provider before prompt construction.
9. Multi-tenant chat never applies writes or connector side effects directly.
10. Cross-tenant agent batches queue one tenant-pinned `RunRecord` per tenant; write-agent batches require per-tenant typed confirmation.
11. An admin can create, rename, open, archive/delete, and export a tenant-scoped workspace.
12. A workspace can link existing tenant-matching chat conversations and agent runs without duplicating or deleting the underlying records.
13. An admin can pin Graph evidence/source details from a chat answer and see source freshness, tenant, resource kind, and cache/live status.
14. Workspace notes and instructions are stored locally and scoped to one tenant.
15. Workspaces do not accept mixed-tenant evidence; multi-tenant chat results can only export locally or be split into tenant-specific workspace evidence.
16. Prompting with workspace context is explicit: the UI shows the selected evidence/notes before sending.
17. Hosted-provider sends with attached workspace context require the same explicit confirmation boundary as Intune Chat.
18. Deleting a workspace does not delete tenant config, chat history, Graph cache, run history, connector audit records, or self-training records.
19. Workspace export is local and explicit, with no background upload.
20. Multi-tenant Chat and Workspaces pass a keyboard/focus, narrow-width, long-content, empty-state, loading-state, and partial-failure UX review before release.
21. `npm run typecheck`, `npm test`, `npm run qa`, and the relevant Electron smoke test pass before release.

# v0.2.2 — Intune Chat + local intelligence foundation

**Status: implemented and smoke-verified; live-tenant pilot run recommended before release.** Follow-up release after v0.2.1. The theme is making OpenAdminOS feel like an operating surface, not only an agent launcher: admins can ask natural-language questions against their own tenant, route repeatable work into installed agents as skills, and optionally approve local self-training suggestions that adapt those agents to their environment.

## Product stance

- **Intune Chat is a first-class surface.** It should sit beside Agents in the primary navigation and feel like the default place to investigate a tenant.
- **Agents become skills.** Installed agents expose routing metadata so chat can suggest "This matches Offboarding agent" instead of trying to improvise a repeatable workflow.
- **Natural language is broad, execution is constrained.** Chat can answer freely from tenant data, but no Graph write or connector side effect happens without the existing confirmation gates.
- **Local-first remains literal.** With a local provider, Graph data, prompts, chat history, cache entries, and self-training suggestions stay on the device. Hosted providers must show honest trust messaging before tenant context is sent.
- **Self-training is opt-in and approved.** Chat and agent runs can propose improvements, but OpenAdminOS only writes `self-training.yaml` after the admin approves the suggestion.

## Priority 1 — Persistence and cache foundation

- [x] **SQLite store introduction** — add a `node:sqlite` store in the Electron main process and create `openadminos.db` under `userData`. Keep existing `state.json` for current app state during the first pass; do not rewrite all persistence at once. `better-sqlite3` was tested and rejected for this pass because it failed to rebuild against Electron 42's Node/V8 ABI.
- [x] **Schema migrations** — versioned migrations for chat conversations, chat messages, chat tool calls, Graph snapshots, Graph resource rows, learning events, and learning suggestions.
- [x] **Graph cache service** — cache selected read-only Graph resources by tenant, resource kind, snapshot id, Graph id, raw JSON, normalized search columns, scope set, and `refreshedAt`.
- [x] **Manual refresh controls** — Settings exposes "Refresh tenant data now" with active tenant, scopes, provider trust, last refresh, and failures; chat keeps only a compact refresh action and freshness indicator.
- [x] **Periodic refresh controls** — Settings exposes a per-tenant scheduled refresh toggle with interval selection, next-run state, last failure, and OS scheduler integration.
- [x] **Cache freshness model** — every answer carries "using data refreshed at ..." and stale data is disclosed rather than silently treated as current.

## Priority 2 — Intune Chat surface

- [x] **Chat route and layout** — add a primary navigation item for Intune Chat with a minimal two-pane layout: collapsible chat history on the left, conversation/composer in the center, and only compact tenant/provider/freshness indicators in the header.
- [x] **Read-only chat service** — persist conversations/messages locally and generate answers through the active LLM provider.
- [x] **Streaming chat responses** — stream LLM deltas from Electron main to the renderer through a scoped IPC event channel; persist only the final completed or failed assistant message.
- [x] **Platform system prompt** — use an OpenAdminOS chat prompt that requires active tenant context, answers only from retrieved Graph/cache context, refuses unsupported writes, and discloses stale or missing data.
- [x] **Intent router** — classify each prompt as answer-from-data, route-to-agent, clarify, blocked-write, or unsupported.
- [x] **Graph context planner** — choose Graph/cache sources for the question. Coverage now includes device inventory, Entra devices, users, groups, compliance, configuration/settings catalog, apps, detected apps, MAM/app config, Autopilot/enrollment, remediations/scripts, Windows Update, endpoint security, assignment filters, scope tags, encryption, troubleshooting, sign-ins, directory audit, and Conditional Access policies.
- [x] **MCP endpoint review** — validate chat cache Graph endpoints and compact audit-log `$select` lists against Microsoft Graph beta through the Microsoft MCP before treating the endpoint set as releasable.
- [x] **Graph PM cache validation** — assert every Intune Chat cache endpoint, delegated permission, and selected field against the bundled Graph PM indexes; tenant connection now requests the read scopes needed by the full chat cache surface.
- [x] **Answer-pack builder** — use deterministic SQL/Graph filtering, joins, counts, sorting, and top-N sampling before sending compact context to the LLM. Do not dump whole tenant inventories into model context.
- [x] **Source/freshness rendering** — answers show which resources were used, when they were refreshed, and whether data came from cache or live Graph.
- [x] **Chat interaction polish** — Enter sends messages, Shift+Enter inserts newlines, the composer has a single focused accent border, message bubbles expose copy prompt/response actions, and cache/model work renders as a progress checklist inside the active assistant response slot instead of a static loading pill.
- [x] **150-question coverage bank** — keep `docs/research/intune-chat-question-bank.md` as the researched admin-demand fixture and assert every listed question maps to known cache resources.

## Future UX follow-ups

- [x] **Workspaces** — implemented in v0.2.5 as tenant-scoped investigation containers with pinned Graph evidence, linked agent runs, notes, approved local instructions storage, and freshness metadata. Route placement is top-level `/workspaces`, directly after Intune Chat.
- [ ] **Reusable output panes** — evaluate artifact-like side panes for large generated outputs such as policy comparison reports, remediation plans, and exportable summaries, without sharing tenant data outside the selected provider trust boundary.

## Priority 3 — Agent-as-skill routing

- [x] **Agent routing descriptor** — derive `name`, `description`, category, mode, scopes, settings, example prompts, and write/destructive status from installed manifests.
- [x] **Agent match scoring** — detect when a prompt maps better to an installed agent than ad-hoc chat. Prefer explicit agent suggestions over silent routing.
- [x] **Run-agent affordance** — chat can offer "Run" for read agents, "Review" for write agents, and "Details" for why the agent matched plus required scopes; write agents still enter the existing plan/confirmation flow.
- [x] **Agent run context in chat** — when chat starts an agent, persist a tool-call record linking the conversation to the run id and show the run status inline.

## Priority 4 — Optional local self-training

- [x] **Global opt-in** — self-training is disabled by default. Enabling it explains that it does not train the model, upload tenant data, or rewrite public manifests.
- [x] **Per-agent self-training file** — approved learned instructions are written under `userData/agent-learning/tenants/<tenantIdHash>/agents/<agentSlug>/self-training.yaml`.
- [x] **Learning event capture** — record chat routes, accepted agent suggestions, rejected write plans, confirmed write plans, repeated chat corrections, and relevant agent setting changes.
- [x] **Reflection suggestions** — propose local improvements from chat/run history, with tenant identifiers and raw Graph objects excluded from the suggestion text.
- [x] **Admin approval UI** — every suggestion is pending until accepted. Accepted entries are active, rejected entries are auditable, and users can reset learned behavior per agent/tenant.
- [x] **Prompt composition** — future agent LLM steps receive approved local self-training instructions as an overlay on top of the reviewed manifest prompt. The overlay cannot add scopes, change mode, alter connector egress, or bypass confirmation.

## Priority 5 — Large context handling

- [x] **Query before prompt** — SQL/Graph does the heavy filtering; the LLM receives compact answer packs only.
- [x] **Top-N and aggregation rules** — define caps for rows, columns, and raw JSON included in a prompt, with deterministic summaries for omitted rows. v0.2.2 reads at most 40 rows per resource and includes at most 20 compact sample rows per resource in the answer pack.
- [x] **Deterministic compaction** — for large policy sets or long text fields, include bounded samples, grouped breakdowns, and omitted-row summaries before the LLM sees the answer pack.
- [x] **Embeddings deferred** — local embeddings for long free-text policy search are allowed later, but v0.2.2 should work with deterministic search and SQL first.

## Acceptance criteria

1. An admin can open Intune Chat, ask a read-only question about the active tenant, and receive an answer grounded in cached or freshly fetched Graph data.
2. The answer shows tenant, provider residency, data freshness, and source resources.
3. The assistant response streams in the chat view as the selected provider emits deltas.
4. Chat refuses or redirects write requests instead of performing side effects directly.
5. Chat suggests an installed agent when the prompt maps to a repeatable agent workflow.
6. Starting an agent from chat preserves the existing preflight, scope review, and write confirmation behavior.
7. Graph cache refresh can be triggered manually and records failures with clear recovery copy.
8. Graph cache refresh can be scheduled per tenant and records next run, latest success, and latest failure locally.
9. The researched 150-question bank is covered by planner tests and only maps to known Graph cache endpoints.
10. Self-training is disabled by default and cannot affect any run until the admin explicitly enables it and approves a suggestion.
11. Approved `self-training.yaml` entries influence only prompt/context composition, never scopes, mode, connector egress, or confirmation policy.
12. `npm run smoke:intune-chat` launches Electron with a local tenant fixture, sends a chat prompt through the real preload/IPC path, verifies a grounded answer, agent suggestion, accepted self-training overlay, and scheduled refresh state.

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

- [x] **Agent builder docs** — added `docs/agent-sdk.md` for authoring, validating, and submitting agents.
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

# v0.1 — Public preview foundation

**Status: complete.** Tagged as v0.1.0. This was the first public-preview foundation milestone; later public-preview releases now carry the active roadmap.

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

# Marketplace in the app, first wave (2026-11-03)

Branch `marketplace/first-wave` off `main`, in its own worktree. Runs locally only until approved; no merge, so no nightly.

## Deliverable

A Marketplace sidebar item that replaces the Agent Hub. It lists the registry agents and three remote MCP servers: Microsoft Learn (`https://learn.microsoft.com/api/mcp`), KQL Search (`https://www.kqlsearch.com/mcp`) and IntuneAutomation (`https://www.intuneautomation.com/mcp/`). All three were probed on 2026-11-03: streamable HTTP, protocol 2025-06-18, no sign-in, read-only. Installing a server once makes its tools available to Chat with any provider, because OpenAdminOS runs the tool loop itself.

## Acceptance criteria

1. Sidebar shows Marketplace. The Agents page shows installed agents only; "Install from hub", the command palette entry and the `/hub` redirects open the Marketplace instead.
2. Marketplace lists all registry agents (install, details and license gating as today) and the three MCP servers, styled after `docs/mockups/25-marketplace.html`, without prices or vendor commerce.
3. Installing an MCP server shows an authentication step ("No sign-in needed") and the host its queries go to, then connects, lists its tools and stores the install in `state.json`. Uninstall and enable or disable work. A server that is unreachable shows a designed error with retry, never a silent failure.
4. Chat lists installed MCP tools to the model, calls them through the MCP client in the main process, shows each call in the tool trace with its host, and fences results as third-party content. A docs-only question answered from an MCP tool is not rejected by the tenant-evidence guard.
5. The model is told to send MCP tools only standalone public questions, never tenant names, user names, device names, IDs or tenant data. MCP tools never reach the external MCP gateway.
6. Trust copy is honest: with any MCP server enabled, the status strip and its tooltip name the hosts that receive tool queries, also when the model is local.
7. Pilot mode: the Marketplace is browsable and MCP servers can be installed; agent install stays production-only as today.
8. Unit tests for the MCP host (connect, list, call, timeout, error), the loop integration and the trust copy; renderer tests for the Marketplace page; Playwright or app screenshots in light and dark.
9. Verified live in the running app: install all three, ask Chat a question each one answers.
10. SPEC.md decision, CHANGELOG [Unreleased], separate evaluator and GPT-6.1-Sol review before any PR merge.

## Decisions (2026-11-03)

- Status strip names the MCP hosts whenever an MCP server is enabled, also with a local model.
- Small local models that skip the tool loop get no MCP tools; Marketplace and Chat say the selected model is too small for tool use.
- Pilot: the Marketplace is browsable and MCP install is allowed; agent install stays production-only.
- Every install shows an authentication step, even when it is "No sign-in needed", plus the host queries go to.
- The catalog of the three servers lives in code for now (typed module with id, name, publisher, host URL, description, auth `none`). No public catalog file yet.

## Out of scope

Vendor sign-in (designed separately as Vendor MCP authentication), local or sandboxed servers, paid listings, publishing a public MCP catalog file, MCP tools in agents or schedules.

## Steps

- [x] MCP host in the main process: catalog of the three servers, connect, list tools, call with timeout and output cap
- [x] Persist installs, IPC and preload API
- [x] Chat loop: MCP tools in the prompt, executor, trace, evidence guard, prompt rules
- [x] Trust copy for external tool hosts
- [x] Marketplace page and sidebar; move the hub out of Agents
- [x] Unit and renderer tests; live check of the MCP host against the three servers
- [x] Security review fixes: egress check, untrusted metadata, redirects, evidence guard, pilot install guard
- [ ] Screenshots in light and dark, and a live check in the running app
- [x] SPEC, CHANGELOG
- [ ] Separate evaluator and GPT-6.1-Sol reviews

# Chat steps, follow-ups and source routing (2026-11-04)

Same branch, `marketplace/first-wave`. Runs locally only. The design reference is the "Chat steps proposal" mockup, shown in the thread on 2026-11-04 (scratchpad file chat-steps.html).

## Why

A docs question ("What does the Microsoft Learn say about Defender for macOS?") never called the Learn MCP server. The run log shows a graph-cache-refresh of 8 resources and 3 cache tools. The [1] [4] [5] citations came from the local docs index (55,193 passages, version 2026-08-26). That index is injected into the prompt and never shown. The model wrote "Microsoft Learn says". The planner refreshed tenant data because the question mentioned macOS, and the evidence guard then forced device queries. While the run was in progress, the UI only showed "Investigative mode started."

## Decisions (user, 2026-11-04)

- Docs-only questions do not touch the tenant. Tenant context is offered as a follow-up.
- Follow-ups are prefilled as ghost text in the empty composer, and Tab accepts. No background model is used. The answering model returns them in its final JSON, and a deterministic rule covers docs questions that have a tenant tie-in.
- Source routing is layered: a "use for" line we write per source, the first step names the chosen sources, naming a source in the question forces it, and labels come from the steps that ran. When the Learn server is installed, it is used before the local index. The `@` picker is left out of v1.
- Small models: say plainly why tools are off and recommend 8B or larger. The status strip names MCP hosts only when the model can call them.

## Acceptance criteria

1. Chat streams every step live as a timeline row: plan, local docs index, each MCP call, Graph refresh, each cache or Graph tool, and writing the answer. Each row has a title, a detail line, a duration and an origin tag: On device, Microsoft Graph, the third-party host, or the model provider. An MCP row shows the exact text that was sent. Blocked and failed steps show as designed states.
2. After the answer, the timeline folds into one summary line: step count, total time, sources, and what left the device and where it went. The line expands to show the full timeline. Persisted messages reload with the same steps.
3. The answer separates documentation and tenant blocks. The labels come from the trace, not from model text. Every citation maps to a source card: Microsoft Learn or other MCP results with title and URL, local index passages with file and index date, and tenant resources. A citation that matches no source is not rendered as a source.
4. A docs-only question runs no graph-cache-refresh and no tenant tools, and the evidence guard does not force them. A tenant or mixed question still requires tenant evidence.
5. If the question names an installed source by name or host, that source is called. An answer only labels text as Microsoft Learn when a Learn call ran in that answer. When Learn is installed it is preferred over the local index, and the index is the fallback when Learn is offline or blocked.
6. Each catalog entry carries our own "use for" line, and the prompt lists it. The first step names the sources chosen for the question.
7. Follow-ups: the final protocol JSON accepts an optional `next` array of up to 2 strings. They are validated: read-only intent (existing write-intent check), at most 120 characters, trimmed. A deterministic follow-up is generated when a docs-only question matches tenant resources (for example "Check our 5 macOS devices for Defender in Intune", with the count from the local cache). The deterministic path also produces them.
8. Composer: when it is empty and a follow-up exists, the follow-up shows as ghost text with a Tab hint. Tab fills it, Esc dismisses it, typing hides it, and nothing is sent automatically. Tab keeps its normal behaviour otherwise. Screen readers announce "Suggestion: ..., press Tab to use it". The chips under the answer remain.
9. Small models: the notice reads, for example, "llama3.2:3b is too small for tool use. Chat answers from cached tenant data only and Marketplace tools are off. Use a model of 8B or larger." The Marketplace server cards show the same line. The status strip lists MCP hosts only when tools are actually offered.
10. Tests cover each criterion. Renderer tests run under Node 22. Live check in the running app with the Defender for macOS question, a KQL question and a mixed tenant question.

## Out of scope

The `@` picker, parallel tool calls, and changing the local index content.

## Steps

- [x] MCP egress filter review fixes S1 to S5 and N1
- [x] Source classification as the first step; docs-only questions skip the tenant refresh and tenant tools
- [x] Source routing: "use for" lines, named sources forced, Learn before the local index
- [x] Live step events with origin tags, persisted with the message
- [x] Follow-ups from the final JSON and the deterministic rule
- [x] Small-model notice wording and status strip hosts only when tools are offered
- [x] Renderer: timeline, folded summary, documentation and tenant blocks, source cards, composer ghost text
- [x] Integration test for the docs, KQL and mixed tenant questions
- [x] SPEC, CHANGELOG
- [ ] Live check in the running app with the three questions (needs an app restart; not done in this session)
- [ ] Screenshots in light and dark
- [ ] Separate evaluator and GPT-6.1-Sol reviews

## Review (2026-11-04)

- Criteria 1 to 9 are covered by tests: `chat-steps.test.ts` (classification, source plan, citations, follow-ups, relabelling, step recorder, loop routing and fallback), `chat-steps.e2e.test.ts` (the Defender for macOS docs question streamed live, a KQL question, a mixed tenant question and the deterministic path, through the app store with an in-process MCP server), renderer tests for the timeline, summary, blocks, source cards, chips and composer ghost text, and the Marketplace and status strip small-model cases.
- Criterion 10: the live check in the running app is still open, because the main-process changes need a restart of the running dev instance. The end-to-end test stands in for it until then.
- Found while testing: a final answer containing a fenced KQL block was read as malformed tool JSON and fell back to deterministic retrieval. Fixed in its own commit.


# Model-declared question kinds with a keyword veto (2026-11-04)

Same branch, `marketplace/first-wave`. Runs locally only.

## Why

A keyword classifier decided docs, tenant or mixed before the loop. A docs label skips the tenant refresh and tenant tools, so a tenant question misread as docs could get invented tenant facts. Reviews kept finding phrasings that slipped through, and the rule became so strict that most docs questions turned mixed and paid for a tenant refresh they did not need.

## Decision (user, 2026-11-04)

The answering model classifies the question, and the keyword rule stays as a veto.

## Acceptance criteria

1. No extra model call. The model's first response in the agentic loop declares the question kind (docs, tenant or mixed) and the sources it intends to use, as part of the existing JSON protocol. A malformed or missing kind gets the existing repair once, then falls back to the keyword classification.
2. The final kind is docs only when the model says docs and the keyword tenant-reference checks (TENANT_REFERENCE, TENANT_STATE, TENANT_VALUE, or a named tenant-state phrase) find no tenant reference. The planned-resources fallback is not a veto. Tenant or mixed from the model is used as given. Docs with the veto firing becomes mixed. The kind can be upgraded later but never downgraded.
3. Lazy tenant refresh in the agentic path. graph-cache-refresh no longer runs before the loop. It runs once the kind resolves to tenant or mixed, before the first tenant tool executes, or when a docs-labelled run calls a tenant tool; then the kind is upgraded to mixed, the refresh runs and the tool executes. A docs question that stays docs triggers no refresh and no Graph calls.
4. The evidence guard uses the final kind. Tenant and mixed answers still need tenant evidence.
5. The deterministic path (small models and fallbacks) keeps the keyword classification and today's pre-refresh.
6. Timeline: "Read the question" appears at once and updates with the model's kind and sources when the first response arrives. A veto says so in plain words ("Treated as docs and tenant: the question mentions your tenant."). The refresh step appears where it actually ran. Upgrades show as a visible step.
7. The prompt tells the model how to classify: docs means public product knowledge only, with no fact about this tenant needed; when unsure, mixed. Short.
8. Tests, each written to fail without its fix: model docs plus a tenant reference gives mixed; model tenant for "What are unmanaged devices?" gives tenant with a refresh; a missing or malformed kind falls back to keywords; the Defender for macOS question, "How do I enroll macOS devices?" and "Is there a script to find stale devices?" give docs with no refresh and no Graph calls when the model says docs; an upgrade gives mixed, a refresh, then the tool; the deterministic path is unchanged; the existing end-to-end tests for the three questions still pass, adjusted only where the protocol changed.
9. SPEC.md "Question kinds" rewritten, CHANGELOG [Unreleased] updated, these steps ticked.

## Steps

- [x] Planner: export the tenant-reference check and the kind resolution with its veto
- [x] Loop: kind and sources on the first reply, one repair, keyword fallback, upgrade on a tenant tool, lazy refresh hook, evidence guard on the final kind
- [x] Service: lazy refresh in the agentic path, plan step resolved by the model, deterministic path unchanged
- [x] Tests for criterion 8
- [x] SPEC, CHANGELOG

## Review (2026-11-04)

- Criteria 1 to 8 are covered by tests: `chat-steps.test.ts` (veto, kind tracker copy, declared sources, upgrade step, loop repair and keyword fallback, veto in the loop with the evidence guard, loop upgrade with refresh before the tool) and `chat-steps.e2e.test.ts` (docs questions with no refresh and no Graph calls, veto to mixed, model tenant with a refresh, upgrade with refresh then tool, missing and invalid kind, deterministic path unchanged, and the three original questions). Mutation checks: disabling model classification, the veto or the upgrade each fails its tests.
- Electron 721 of 721, renderer 359 of 359 under Node 22, runtime 224 pass and 0 fail, qa 181 pass, 4 warn, 0 fail, root typecheck clean.
- Open: the live check in the running app needs a restart of the dev instance, and the separate evaluator and GPT-6.1-Sol reviews.
- Review fixes (2026-11-04): direct answers keep the refresh first (empty-cache test), the evidence guard keys on the kind with only small talk exempt, a follow-up after a tenant answer cannot be docs only, declared sources are intent only (the TODO is resolved), a failed refresh shows on its step and the answer continues, and Stop is checked after the refresh.

# Live answer, Learn first and citable Learn results (2026-11-04)

Same branch, `marketplace/first-wave`. Runs locally only.

## Why

A live run ("how does defender onboarding for macos work?", OpenAI Codex, gpt-6-sol) showed the question and nothing under it for the whole run, then the full answer at once. The local docs index was put in the prompt before Microsoft Learn was asked, so the answer cited only local passages. The Learn source cards were titled from links inside the content ("Apple Configurator", "iMazing Profile Editor"). One follow-up spoke to the admin ("Would you like to check this tenant's macOS onboarding status?") and repeated the deterministic one.

## Acceptance criteria

1. From sending until the first answer text, the answer area always shows the scope line and the live step timeline, with a "Reading the question" skeleton row before the first step. Never blank, also when Chat is opened again during the run. Reduced motion respected.
2. With an adapter that streams incrementally, the final answer of the tool loop streams as it arrives; tool calls are never shown; the parsed reply replaces the streamed text; Learn relabelling applies to streamed text. Report which providers stream.
3. A docs question with Learn installed asks Learn first; the local index is searched only when Learn is left out, fails, is blocked or returns nothing, as its own step that names the reason, in the order it ran.
4. Learn results are read by their structure, numbered "[n] Title, URL" for the model with the numbers the cards use, and card titles come from the result titles. Checked against the live Learn server and a recorded payload.
5. Follow-ups are in the admin's voice; offers to the admin are rewritten or dropped; near-duplicates of the deterministic follow-up are dropped.
6. Each fix has its own commit with a test that fails without it.

## Steps

- [x] Root cause of the blank answer area, renderer replay test, fix
- [x] Skeleton step until the host sends one, reduced motion
- [x] Streaming flag on LLM adapters; stream the loop's final answer
- [x] Learn first, local index as a named fallback step
- [x] MCP results by structure, numbered for the model, recorded Learn payload
- [x] Follow-ups in the admin's voice, near-duplicates dropped
- [x] SPEC, CHANGELOG
- [ ] Live check in the running app (needs a restart of the dev instance; not done in this session)
- [ ] Separate evaluator and GPT-6.1-Sol reviews

## Review (2026-11-04)

- Blank answer area: a faithful replay of the host's event sequence renders the scope line and steps throughout in the page that sent the question, so the page logic was not at fault. The only way the code produced the screenshot is a Chat page instance that did not start the stream: after Chat is mounted again mid-run, the new page had no live state (not sending, no progress, only the saved question) and the events still went to the old page's handlers, so the answer appeared only once the saved message loaded. The live run is now kept outside the page. Which remount happened in the user's session could not be confirmed without the renderer console.
- Providers that stream text as the model writes it: Ollama, LM Studio, Azure OpenAI, Claude Code, Copilot, Gemini, Apple Foundation. Codex CLI 0.166.0 `exec --json` was checked live and sends one `item.completed` event, so it does not.
- The live Learn search for the question returned 27,458 characters, over the host's 12,000-character cap, so the JSON was cut and titles fell back to Markdown links inside the content. The host now returns the structured result too.

# Append-only chat timeline (2026-11-04)

Same branch. A run showed "Read the question" (9.3 s) and "Working on the answer", then "Asked Microsoft Learn" appeared between them. The scope line showed tool result text, and the sent text wrapped mid-word.

- [x] Steps append-only and chronological; one model step per loop call with its decision; classification on the model step; plan step is local planning time only
- [x] Renderer keeps visible step order
- [x] Scope line shows the current step's title only
- [x] Sent text wraps at word boundaries
- [ ] Live check in the running app (needs a restart)

# Answer header, sources and suggestions (2026-11-04)

Same branch. From two runs in the app built at 52ca085: a docs answer and the tenant follow-up "Check our 5 macOS devices for Defender in Intune".

- [x] A. Header names what the answer used; "How I checked" folded into the expanded steps
- [x] B. Summary sources from citations and steps; total time is wall time
- [x] C. One card per article, every chunk number maps to it
- [x] D. Adjacent citation chips ascending and deduplicated
- [x] E. Prompt: no description of sources, provider or tenant checks; content limits stay
- [x] F. Tenant questions do not search the local docs index
- [x] G. Follow-ups answerable with the tools (deterministic wording; model follow-ups constrained through the prompt)
- [x] H. Agent suggestion needs the agent's own topic term; at most one
- [x] I. Investigated: the 4-hour-old device cache was within the 6-hour managedDevices threshold; the lazy refresh refreshed the stale security alerts and incidents only, as configured
- [ ] Live check in the running app (needs a restart)

# Review fixes for the timeline and answer rounds (2026-11-04)

- [x] Withdraw a rejected streamed final before slow work and before falling back
- [x] No navigation back to Chat when a run finishes after the admin left
- [x] Live runs kept by stream id, with a store unit test
- [x] Stop checked after a streamed reply; Nova keeps a hosted disclosure; Graph requests in the egress line; live text throttled

## Chat UI pass (2026-11-04)

Same branch. From a screenshot of a docs answer from Microsoft Learn on a hosted model: the tenant chip on a docs answer, "Microsoft Learn" three times, citations numbered with gaps, "third-party content" on every card, the Scroll to latest button over the sources and a long hosted line under the composer.

### Acceptance criteria and status

1. [x] A docs answer that never touched the tenant shows no tenant chip; the summary row says "Tenant not used". Mixed and tenant answers keep the chip.
2. [x] Only cited sources are numbered, 1..N in order of first appearance, chips remapped; uncited sources sit under a collapsed "Also consulted"; numbering reads only the stored answer and sources, so a reload renders the same (done in the renderer, `numberCitations`).
3. [x] Scroll to latest sits in its own row above the composer, outside the scrolling conversation, and shows only away from the bottom.
4. [x] Optional `title` in the final JSON of a new chat's first answer: at most 60 characters, plain text, no links, no tenant values, no write intent; used for the sidebar and header unless renamed meanwhile; trimmed question otherwise. No extra model call.
5. [x] The source name appears once, in the summary row; the header source label is gone; block labels only when an answer has both documentation and tenant blocks.
6. [x] Hosted sentence under the composer: in full on a conversation's first message and after a provider, model or MCP host change; otherwise a shield icon with the same sentence as tooltip and accessible description, opening it in full on click. Status strip unchanged.
7. [x] "Sources · learn.microsoft.com, not verified by OpenAdminOS" once in the heading, not on each row.
8. [x] Origin icons with counts replace the coloured dots; the full timeline still expands.
9. [x] Compact source list, three shown and "Show N more"; chip hover or focus shows the excerpt, title and host (excerpts stored host-side).
10. [x] Chips 12 px with 5.7:1 (light) and 8.2:1 (dark) contrast; a click reveals, scrolls to, focuses and highlights the row; the row title links to the page.
11. [x] One row: "6 steps · 25 s · Microsoft Learn · Tenant not used" and "Sent: answer context to OpenAI Codex, search text to learn.microsoft.com", with "Sent" expanding to exactly what left the device; local runs say "Nothing left this device".
12. [x] One follow-up chip under the answer, with "Uses tenant data" when a docs answer's follow-up reads tenant data; clicking fills the composer only.
13. [x] Copy button on each numbered step (plain text); "Open in Learn" when one Learn page supplies more than half of the citations.
14. [x] Copying a numbered step includes its nested sub-items and wrapped paragraphs, two spaces per level with bullets and numbers kept; citation chips copy as the shown numbers in brackets, as the answer copy does; the screen reader announcement stays. Nested numbered sub-items have no button of their own.
15. [x] When an answer cites nothing, consulted local docs index passages are listed with the MCP results, never numbered, labelled with their title (the file when untitled) and "Local docs index, <index date>" in place of a host, without a link when they have no URL. The heading names "Local docs index on this device" and keeps "not verified by OpenAdminOS" for third-party hosts only. Derived from stored sources, so a reload renders the same.

### Review

- Tests: electron unit and end-to-end tests for `validTitle`, `sourceExcerpt`, the title protocol, title persistence and fallback, stored excerpts and `tenantFollowUps`; renderer tests for each item (`chat-steps.test.ts`, `hosted-disclosure.test.ts`, `ChatSteps.test.tsx`, `MarkdownPreview.test.tsx`, `IntuneChat.test.tsx`).
- Screenshots in light and dark from a scratch Vite and Playwright harness with a mock bridge (not committed).
- A separate review found no blocking issues; three of its lower-confidence notes were fixed (hosts of consulted rows in the heading, disclosure recorded for the running chat only, copied step announced). Both of the notes left unchanged then (uncited local index passages not listed when nothing is cited, and a step copied without its sub-items) are now done, items 14 and 15.
- Checks: typecheck clean; electron 757 of 757; renderer 53 files, 395 tests under Node 22 before the review fixes (chat files 185 of 185 after); runtime 225 pass, 0 fail; qa-graph 65 of 65; qa 181 pass, 4 warn, 0 fail; test:scripts 16 of 16; docs:check clean.
- Open: the live check in the running app, and the separate evaluator and GPT-6.1-Sol reviews. Seen in the harness at 1280 px wide and not changed here: a long chat title in the top bar runs under the status strip pill.
- Follow-ups 14 and 15: tests for a step with lists two levels deep and a wrapped paragraph, for chips copied as shown numbers (in `MarkdownPreview.test.tsx` and through `AnswerBody`), for an uncited answer with only local passages, mixed MCP and local uncited, local passages under "Also consulted", and a reload in `IntuneChat.test.tsx`. Unnumbered local rows use the new label; numbered local rows keep "file · index from <date>". Checks: typecheck clean; electron 757 of 757; renderer 53 files, 401 tests under Node 22. Screenshots in light and dark of the uncited "Consulted" list and "Also consulted" expanded with local passages, from the scratch harness (not committed).

## Review round 1 (marketplace)

Same branch, from head 86bb18f. Findings from the GPT-6.1-Sol review (G) and the separate Claude evaluator (E).

| Finding | Resolution | Commit |
| --- | --- | --- |
| G1+G2 (blocking, privacy): the egress filter was a denylist; encoded values (percent escapes, zero-width characters inside GUIDs) bypassed it and tenant data under unindexed keys (streetAddress, descriptions) could leave verbatim. | The answering model only picks the MCP tool; its params are never sent. A separate query writer call (`mcp-query-writer.ts`), on the same provider and model, writes the params from the admin's own messages, the tool's fenced description and schema, and the titles and links of earlier MCP results in this answer, plus queries already sent. It never sees Graph results, cache rows, tenant values, answers or the tenant name. The egress check stays as the second layer and runs on canonical text (`mcp-egress.ts`: NFKC, invisible characters removed, percent escapes, HTML entities and backslash escapes decoded until stable); residue encodings and non-printable characters are refused, the decoded text is sent and shown, and a link is sent only verbatim from an earlier result of the same server. Tests: percent-encoded and entity-encoded tenant name, zero-width GUID, streetAddress from `graph_get` absent from the query writer prompt and the sent params, unlisted fetch URL refused and a listed one sent, admin-typed email still blocked, writer failure and missing admin messages send nothing, and the Learn docs question end to end with the writer prompt checked. | a88849b |
| G3 (blocking): disable or uninstall did not revoke a running answer's access, and the host could reconnect. | `McpHost` keeps an authorization generation per server; disable and uninstall bump it inside the serialized write, abort calls in flight and close the session. A call carries its answer's generation, and the host reads installed and enabled state again right before dispatch and before reopening a session. A refused call sends nothing: "Test Docs was turned off during this answer. Nothing was sent." Tests: host-level revoke and state check, and app-state disable and uninstall while the model is responding, with the server receiving no call. | 7588cc3 |
| G4: documentation loaded by `afterClassification` after a final answer was recorded as consulted without reaching the model. | Such a final loads the passages first and, when any matched, the model answers again with them. Only sources whose content entered a model request are returned as consulted and citable. Tests for both the retry and the no-passages case. | 42b0d5a |
| G5: empty final answers were accepted outside voice. | Checked after fence stripping on every surface, retried within the bounded repair budget, then the fallback notice "The model returned an empty answer N times." Test. | f5569ac |
| G6 (nit): SPEC said a tenant tool on a docs question is refused with a repair turn. | SPEC now says the question becomes mixed, a step says so, tenant data is refreshed and the tool runs. | docs commit |
| E1: calls that never reached the host were titled "Could not reach <server>" and the fallback said "did not answer". | Titled "Did not send a <server> query" with the reason; the fallback says "no Microsoft Learn query was sent". Tests. | 23fd3d8 |
| E2: toggle and uninstall failures said "<server> did not respond". | Per-action titles: "Could not turn off <server>", "Could not turn on <server>", "Could not uninstall <server>". Renderer test. | 9c8b0de |
| E3: an uninstall during an install's connect was undone by the install's write. | The serialized write checks whether the server was uninstalled since the install started; if so it closes the session and reports "<server> was uninstalled while it connected. Nothing was installed." Test. | f5b36de |
| E4: `validTitle` and follow-ups skipped the tenant name terms and cached values without an MCP server. | The Chat tool context carries both regardless of MCP. Loop test and an app-state test with no server installed. | b2bdb08 |
| E5: orphaned `cappedFetch` comment in `host.ts`. | Moved above `cappedFetch`. | 5f291a2 |

Checks: typecheck clean; electron 772 of 772; renderer 53 files, 402 tests under Node 22 (the known flaky "finds a setting" failed once in the full run and passed alone); runtime 225 pass, 0 fail; qa 181 pass, 4 warn, 0 fail; test:scripts 16 of 16; docs:check clean.

Open: the round 2 GPT-6.1-Sol review of the whole diff, the separate Claude evaluator, and a live check with a real local model that the query writer writes usable Learn queries.

## Review round 2 (marketplace)

Same branch, from head 08ad4e4. Findings from the GPT-6.1-Sol review (G) and the separate Claude evaluator (E).

Owner decision (2026-11-05): "Disclose + current message only". The query writer sees only the admin's current question, not earlier messages and not queries already sent in earlier turns. The UI states plainly that the admin's words in the question can be sent to the named host after a best-effort filter. Every query is shown in its step. No extra clicks.

| Finding | Resolution | Commit |
| --- | --- | --- |
| G1 (blocking, privacy): the query writer got the admin's earlier messages, so a tenant field quoted earlier (`streetAddress: "420 Cedar Avenue"`) could be written into a later docs query. | The writer gets only the current question (`adminQuestion`), the fenced tool description and schema, and titles, links and queries of MCP calls in the same answer. Voice offers no MCP tools. `adminMessagesOf` is gone; the MCP step reads "writing the query from your question". Tests: loop test with the address in the model's question but not in the writer prompt or the sent params; end to end over three turns with persisted history, where the earlier address, the earlier Learn result title and the earlier query never reach the later writer prompt and the sent query is exactly the later question. | 0dabef2 |
| G2: the disclosure claimed tenant data stays on the device and that the model is told to send only public questions. | One text in the composer line, the shield tooltip, the status strip tooltip and the install review: "MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to <hosts>. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail." With a local model and MCP on, the composer says "Local model. Graph and cache data stay on this device." and the stored-data line no longer claims prompts stay. Acknowledgement: "I understand that words from my question can be sent to <host>." SPEC, CHANGELOG and writer comments aligned. Renderer tests for copy, local line, hosted shield, status strip tooltip and install review. | 4ac2f4c |
| G3 (nit): `parseParams` took JSON out of prose. | After one optional outer fence, the whole body must parse as one JSON object; anything else sends nothing and shows the designed not-sent step. Unit cases and a loop test with prose around a valid object. | d5737ca |
| E low 1: a connection check could reinstall a server uninstalled between its read and capturing the uninstall counter. | The counter is captured before the read, and the serialized write returns without writing when a check finds the server gone. Test for both races; the first fails on the old code. | 3d6edde |
| E low 2: an empty voice answer said the model "described a lookup without finishing it". | New `empty-answer` reason; voice says "The reasoning model returned an empty answer. No completed answer is available. Retry or open Chat to inspect the evidence."; desktop keeps "The model returned an empty answer N times. Deterministic retrieval was used instead." Loop and voice tests. | e0922ad |
| E nit 3: orphaned `withMcpSkippedNotice` doc comment. | It sat above `adminMessagesOf`; removing that function put the comment back on `withMcpSkippedNotice`. | 0dabef2 |

Checks: typecheck clean; electron 777 of 777; renderer 53 files, 403 tests under Node 22; runtime 225 pass, 0 fail (227 tests); qa 181 pass, 4 warn, 0 fail; test:scripts 16 of 16; docs:check clean.

Open: the round 3 GPT-6.1-Sol review of the whole diff, the separate Claude evaluator, and a live check with a real local model that the query writer writes usable Learn queries from the current question alone.

## Review round 3 (marketplace)

Same branch, from head 0703e27. Findings from the GPT-6.1-Sol review (G) and the separate Claude evaluator (E).

| Finding | Resolution | Commit |
| --- | --- | --- |
| G1 (blocking, privacy): follow-ups written by the answering model after it read tenant data could carry an unindexed field (`streetAddress: "420 Cedar Avenue"`) into a suggestion; sent by the admin, it became the query writer's current question. | After an answer that read tenant data (a tenant or mixed kind, a Graph refresh or any tenant tool), the model's `next` is dropped, in the loop and again in `answerFollowUps`, which every surface reads (stored message, chip, composer ghost text; voice shows no follow-ups). Such an answer offers only `tenantAnswerFollowUp`: the device template built from the platform the question names and the cached count, and only when it does not repeat the question; otherwise none. Docs answers that read no tenant data keep the model's follow-ups. `title` stays model-written with its checks. Tests: loop test with a `graph_get` result holding the address and the model returning it in `next`; end to end over two turns where the stored follow-ups hold no address, the admin sends the offered one, and the address never reaches the query writer prompt or the sent params; unit cases for the template and the near-duplicate rule. TODO(ugur) in code: tenant answers on other resources now offer no follow-up. | 4a8abf8 |
| G2: once the source repair budget was spent, a final answer that never called a required source was accepted silently. | The kept answer ends with "Microsoft Learn was not consulted for this answer. The model answered without calling it." (names joined, plural form for several). Test with three final replies and no tool call. | 0c749e4 |
| G3 (nit): `MCP_TOOL_RULES` said the query is written from "the admin's own messages". | Now "from the admin's current question and the tool's schema only". Test. | 7a6d271 |
| E low: the hosted send confirmation named only the hosted provider. | The prompt carries the enabled MCP hosts (`chatToolHosts`, shared with the status strip), `deriveTrustCopy` gets them, and "What leaves this device" adds the tool host disclosure. Renderer tests with Learn enabled and with no server enabled. | 5e3ec4d |
| E nit: SPEC and the round 2 record said "on voice the current utterance". | Replaced: voice offers no MCP tools. | 0fb13fe |

Checks (Node 22): typecheck clean; electron 782 of 782; renderer 53 files, 405 tests (the known flaky "finds a setting" failed once in the full run and passed alone); runtime 225 pass, 0 fail (227 tests); qa 181 pass, 4 warn, 0 fail; test:scripts 16 of 16; docs:check clean.

Open: the round 4 GPT-6.1-Sol review of the whole diff, the separate Claude evaluator, the per-resource follow-up question for tenant answers, and a live check with a real local model.

## Review round 4 (marketplace)

Same branch, from head e1f4b1c. Findings from the GPT-6.1-Sol review (G), the separate Claude evaluator (E) and CI.

| Finding | Resolution | Commit |
| --- | --- | --- |
| CI: the Electron Intune Chat smoke waited for a "How I checked" disclosure, which the Chat UI pass replaced with the step summary row. | The smoke expands the answer's step summary (the button with "N steps") and asserts `/deviceManagement/managedDevices` in the tenant sources; `hasSourceDetails` is read there, since the expansion does not survive switching conversations. The stale comment in `IntuneChat.tsx` and the SPEC sentence name the step summary row. Smoke passes locally under Node 22. | 34b66b2 |
| G1 (blocking, privacy): model follow-ups still leaked private context through a legacy tenant answer in the conversation memory (no steps or tenant markers, only source rows) and through attached workspace evidence, notes or instructions; both produced "Explain support at 420 Cedar Avenue". | Provenance, not question kind. `PromptProvenance` records, where the answering prompt is built on the send and stream paths, whether it held anything besides the current question, public documentation and MCP results, and the app's instructions: conversation memory (any earlier answer, legacy ones included), workspace context, the deterministic answer pack, or tenant data (`readTenantData`). After a private prompt `answerFollowUps`, which the stored message, the chip and the composer ghost text all read, offers only code-built follow-ups. The answer stores `privatePrompt` in `answer_meta_json`, so a reload keeps it. Tests on both paths: a legacy tenant answer in history, workspace evidence, a note and instructions, each with the model returning the address in `next`; and a fresh docs question with no history that keeps the model's follow-up and has no flag. The new tests fail on the previous service code. | b045aee |
| E medium: the keyword planner's access block ran before the question was classified, so "How does Microsoft Sentinel correlate alerts into incidents?" on an Intune-only tenant answered "Defender is not connected for this tenant. Add it in Settings, Tenants." | `accessBlockTiming`: with a documentation source (an MCP server offered to the model or the local docs index), a docs kind is not blocked; in the tool loop the block is deferred and `loadTenantData` raises it once the kind settles to tenant or mixed, before any tenant data is read; without any documentation source the line stays the answer at once. Tests on both paths with Intune-only grants: the Sentinel docs question answers from Learn with no Graph paths, and "List our open security incidents" still gets the access line with no follow-ups; with no MCP server and no index the docs question gets the access line and no model call. | a3bb5e7 |
| E nit: `readTenantData` sat between `withMcpSkippedNotice` and its doc comment. | Comment moved back. | 608a89c |

Note: the tenant display name stays in the tool-loop system prompt as app context; follow-ups are still checked against the tenant name terms and cached values.

Checks (Node 22): typecheck clean; electron 949 of 949; renderer 58 files, 485 tests; runtime 256 pass, 0 fail (258 tests); qa 197 pass, 4 warn, 0 fail; test:scripts 18 of 18; docs:check clean; smoke Intune Chat, Office and report issue pass (Office failed once with "Office game animation is not running" while the test suites ran in parallel, and passed alone).

Open: the round 5 GPT-6.1-Sol review of the whole diff, the separate Claude evaluator, the per-resource follow-up question for tenant answers, and a live check with a real local model.

---

# Own app registration as a first-class choice (2026-11-03)

## Decisions (2026-11-03)

- The connect dialog preselects neither option. The admin must choose before Approve is enabled. Entry points that already express intent (the welcome screen's own-registration link) may open with that option chosen.

## Why

Connecting with your own Entra app registration has worked since v0.5.0 (issue #98), but it is hidden behind a link on the welcome screen and a disclosure in the connect dialog. Admins read the product as "privacy first, but you must use our multi-tenant app". Many organisations block third-party multi-tenant apps, or need a tenant-owned app for Conditional Access targeting, sign-in log attribution and consent governance. Connecting with your own registration should be an equal choice wherever a tenant is connected: first run, Connect tenant, and the pilot mode banner.

## Acceptance criteria

1. Every connect entry point (first-run welcome, tenant switcher, Settings > Tenants, pilot banner, PilotAgentsHome, contextual gates) opens the same dialog, which starts with two equal choices: "OpenAdminOS app" and "Your own app registration". Neither is hidden behind a link or disclosure.
2. Each choice states plainly what it means: which app appears in the tenant's sign-in logs and enterprise apps, that no client secret is used, and that tokens stay on the device in both cases.
3. Custom registrations are remembered locally (client ID, optional directory ID, optional label; no secrets) and preselected next time. Saved registrations can be removed in Settings > Tenants.
4. Settings > Tenants and the tenant switcher show which registration each tenant is connected with (OpenAdminOS app or the custom client ID).
5. Scheduled Teams and Outlook delivery use the tenant's own registration. Today `run-delivery.ts:563` and `:884` call `host.getMsalClient()`, which always resolves the default client, so delivery fails silently for BYO tenants. A test covers a BYO tenant delivering a report.
6. Sign-in errors name the registration actually used (no "Microsoft Graph CLI" wording) and give a specific fix for the common BYO misconfigurations: missing `http://localhost` redirect (AADSTS50011), public client flows disabled (AADSTS7000218), app not found in the directory (AADSTS700016), single-tenant app used without a directory ID (AADSTS50194), and consent missing (AADSTS65001).
7. Host-level tests cover `connectTenant` with a custom registration (authority, per-client token store, persisted `appRegistration`) and MSAL client isolation per client ID.
8. End-to-end check in a lab tenant: connect with a custom single-tenant registration, refresh the cache, run a read agent, deliver a scheduled report. Graph calls verified per the Graph verification rule.
9. SPEC.md first-launch section, connect-tenant docs, and CHANGELOG updated.

## Out of scope

- Sovereign clouds and custom authority hosts.
- Two registrations side by side for the same tenant.
- App-only or certificate auth.
- The v0.5 legacy token cache question (tenants pinned to the Graph CLI client resolve to `tokens-14d82eec….bin`, not `tokens.bin`). Investigate separately before changing.

## Steps

- [x] Connect dialog: replace the own-registration disclosure with a two-option choice at the top of the permissions step
- [x] Welcome screen: keep two primary choices (pilot, connect); the connect path lands on the choice
- [x] Saved registrations: persist in state.json, IPC to list and remove, preselect last used
- [x] Registration shown per tenant in Settings > Tenants and the tenant switcher
- [x] Fix delivery to resolve the MSAL client per tenant, with test
- [x] Rewrite `humanizeMsalError` for the actual registration and BYO error codes, with tests
- [x] Host tests for custom-registration connect and client isolation
- [ ] Lab tenant end-to-end check
- [x] SPEC, docs, CHANGELOG
- [ ] Separate evaluator review and GPT-6.1-Sol PR review

# Vendor MCP authentication (design, 2026-11-03)

Design only. Deliverable: a SPEC section and a public user-facing issue.

Decided 2026-11-03: a connection is stored per tenant, and the user can reuse it for another tenant (an explicit copy, never automatic).

## Acceptance criteria

1. Every MCP listing declares its authentication in its manifest, including an explicit `none`. The install flow always shows an authentication step, even if it only says no sign-in is needed.
2. Supported methods: none, Microsoft Entra (reuses the tenant sign-in), OAuth 2.1 per the MCP authorization spec, and API key. No tenant client secrets.
3. A credential belongs to a connection, not to a listing. A connection is defined by the publisher (verified domain plus connection id) and lists the hosts it may be sent to. Listings from the same publisher that name the same connection share it, so the user enters a secret once.
4. Connections are stored in the OS keychain through safeStorage, bound to a tenant, and are only attached to requests to the hosts the connection declares. A sandboxed local server receives the secret only at spawn and can only reach the declared hosts.
5. Settings shows each connection, the listings using it, when it was added, and lets the user rotate, sign out or delete it. Removing the last listing that uses a connection asks whether to delete the credential.

# Services as modules (2026-11-04)

Branch `services/modular`, stacked on `tenant/own-app-registration` (PR #162). Worktree `.claude/worktrees/services-modular`.

## Why

An admin who only works in Intune still consents to Entra and Defender reads. Every permission area starts selected, and the required "directory" area includes `Directory.Read.All`. Areas mix services: "Apps" covers both Intune and Entra, and "Security and sign-ins" covers both Entra and Defender. Agents, cache resources, pages, the setup script and the docs know nothing about services. An own app registration requests a fixed list and never checks what it was granted. A finished run marks an agent's declared scopes as granted (`runs.ts`), which hides real gaps. Everything assumes Microsoft Graph.

## Decisions (user, 2026-11-04)

- Baseline is sign-in only: `openid`, `profile`, `offline_access`, `User.Read`. Each service pulls in the shared scopes it needs.
- Own app registration: sign in with the registration's `.default` scope, read what was granted, and switch on the matching services. Missing services show the exact permissions to add, a script that adds them to the existing app, and Check again.
- First wave: Intune, Entra and Defender, all on Graph. Exchange, Teams and SharePoint are documented as planned. The scope model records the audience so they can be added later.
- Build now, stacked on PR #162.

## Acceptance criteria

1. One service registry in `packages/agent-sdk` is the only source for services, parts, scopes, reasons, audience, cache resources, roles and licences. Every default read scope belongs to at least one part. Shared scopes are deduplicated. The baseline is exactly the four sign-in scopes. `Directory.Read.All` is not in any service and is requested only when an agent that declares it runs.
2. Connecting with the shared app shows a picker by service, and each service expands to its parts. At least one service is required. Intune-only consent requests the baseline plus the Intune part scopes and nothing else, which a test asserts exactly. Preselection is flagged as `TODO(ugur)`.
3. From Settings, and from any "not connected" state, a service can be added later. Consent is requested for that service only and merged with the existing grants.
4. With an own registration:
   - Sign-in uses `https://graph.microsoft.com/.default`, and granted scopes come from the token.
   - A service or part switches on only when all of its scopes are granted.
   - A missing part lists its exact permissions. It offers a PowerShell script that adds them to the existing app ID, keeps the permissions the app already has, and grants consent. It also offers a `requiredResourceAccess` JSON snippet and a Check again action that gets a new token.
   - The script can still create a new registration, now per service.
5. Grants reflect the token only. The run-time merge of declared scopes into `grantedScopes` is removed. Tenants without `grantedScopes` keep the current all-defaults behaviour until their next sign-in. Stored grants carry their audience, with a migration and tests.
6. The app adapts to connected services:
   - Chat names a missing service, for example "Defender is not connected for this tenant. Add it in Settings, Tenants."
   - Cache refresh skips resources of services that are not connected.
   - Agents and the Marketplace show which services an agent needs and filter by service.
   - Navigation shows a designed "not connected" state instead of an error.
7. Agent manifests declare `services`, which the schema and SDK types accept. The registry QA fails when an agent's scopes are not covered by its services. All bundled and registry agents are updated, and `agents/index.json` is regenerated.
8. Docs, with `docs/gitbook` as the source and `npm run docs:check` passing:
   - a generated "Permissions by service" reference, built from the registry;
   - Intune, Entra and Defender guides covering what each service does, its permissions with reasons, the least-privilege roles, licences, the Chat questions it answers and its agents;
   - a "Planned services" page for Exchange, Teams and SharePoint;
   - setup pages split into "Shared app" and "Own app registration", the latter with per-service tables, the script and the manifest snippet;
   - a roles guide;
   - a troubleshooting page for consent errors;
   - authoring docs that require `services` and least-privilege scopes;
   - a SPEC section on services, with wording reframed from Intune-first to "Microsoft 365, starting with Intune, Entra and Defender";
   - a CHANGELOG line.
9. Every scope name, permission ID and endpoint in the registry is verified with Lokka and the msgraph skill. Results are recorded below.
10. Typecheck, electron, renderer (Node 22), runtime, qa and docs:check are green. The UI is checked with screenshots in light and dark. A separate Claude evaluator and the GPT-6.1-Sol review of the whole diff pass before any PR.

## Out of scope

- The Exchange, Teams and SharePoint implementations, and non-Graph tokens. The model only records the audience.
- Defender advanced hunting (`ThreatHunting.Read.All`) as a Chat tool. It is listed as a planned Defender part.
- Renaming internal `intune-chat` ids.

## Lokka verification

Checked with Lokka on 2026-11-04 (lab tenant, app-only connection): `GET /v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?$select=oauth2PermissionScopes` returns 867 delegated scopes. Every scope below is present and enabled. The ID is the delegated permission ID, and the last column shows who can consent.

| Scope | Delegated permission ID | Consent |
| --- | --- | --- |
| openid | 37f7f235-527c-4136-accd-4a02d197296e | User |
| profile | 14dad69e-099b-42c9-810b-d002981feec1 | User |
| offline_access | 7427e0e9-2fba-42fe-b0c0-848c9e6a8182 | User |
| User.Read | e1fe6dd8-ba31-4d61-89e7-88639da4683d | User |
| DeviceManagementManagedDevices.Read.All | 314874da-47d6-4978-88dc-cf0d37f0bb82 | Admin |
| DeviceManagementConfiguration.Read.All | f1493658-876a-4c87-8fa7-edb559b3476a | Admin |
| DeviceManagementApps.Read.All | 4edf5f54-4666-44af-9de9-0144fb4b6e8c | Admin |
| DeviceManagementServiceConfig.Read.All | 8696daa5-bce5-4b2e-83f9-51b6defc4e1e | Admin |
| DeviceManagementScripts.Read.All | d32381d8-ee89-4220-9c83-b672aa68d404 | Admin |
| DeviceManagementRBAC.Read.All | 49f0cc30-024c-4dfd-ab3e-82e137ee5431 | Admin |
| Device.Read.All | 951183d1-1a61-466f-a6d1-1fde911bfd95 | Admin |
| GroupMember.Read.All | bc024368-1153-4739-b217-4326f2e966d0 | Admin |
| Organization.Read.All | 4908d5b9-3fb2-4b1e-9336-1888b7937185 | Admin |
| Directory.Read.All | 06da0dbc-49e2-44d2-8312-53f166ab848a | Admin |
| User.Read.All | a154be20-db9c-4678-8ab7-66f6cc099a59 | Admin |
| User.ReadBasic.All | b340eb25-3456-403f-be2f-af7a0d370277 | User |
| Policy.Read.All | 572fea84-0151-49b2-9301-11cb16974376 | Admin |
| Application.Read.All | c79f8feb-a9db-4090-85f9-90d820caa0eb | Admin |
| AuditLog.Read.All | e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20 | Admin |
| IdentityRiskyUser.Read.All | d04bb851-cb7c-4146-97c7-ca3e71baf56c | Admin |
| SecurityEvents.Read.All | 64733abd-851e-478a-bffb-e47a14b18235 | Admin |
| RoleManagement.Read.Directory | 741c54c3-0c1e-44a1-818b-3f97ab4e8c83 | Admin |
| AdministrativeUnit.Read.All | 3361d15d-be43-4de6-b441-3c746d05163d | Admin |
| Domain.Read.All | 2f9ee017-59c1-4f1d-9472-bd5529a7b311 | Admin |
| SecurityAlert.Read.All | bc257fb8-46b4-4b15-8713-01e91bfbe4ea | Admin |
| SecurityIncident.Read.All | b9abcc4f-94fc-4457-9141-d20ce80ec952 | Admin |
| ThreatHunting.Read.All | b152eca8-ea73-4a48-8c98-1a6742673d99 | Admin (planned part only) |

Microsoft Graph app ID: 00000003-0000-0000-c000-000000000000.

Not covered by this check:
- The `.default` delegated sign-in. Lokka runs app-only, so it cannot exercise this. It needs a live sign-in with an own registration in the lab tenant.
- The Defender endpoints. The Lokka app lacks SecurityAlert, SecurityIncident and ThreatHunting permissions. Before the Defender service ships, verify the alerts, incidents and Secure Score endpoints with a delegated or permissioned connection.

Checked with Lokka on 2026-11-04: `GET /v1.0/oauth2PermissionGrants?$filter=clientId eq '<service principal id>'&$select=id,clientId,consentType,resourceId,scope` works. It returns one grant per resource, with `consentType` `AllPrincipals` and a space-separated `scope`. This is the read path behind `Get-MgOauth2PermissionGrant -Filter "clientId eq ..."` in the extend script. One app in the lab carries grants for two resources, so the script must keep filtering on `resourceId` (it does).

Still to test in the lab before merge: the writes in the extend script (`PATCH /applications/{id}` requiredResourceAccess and `PATCH /oauth2PermissionGrants/{id}` scope), and the `.default` delegated sign-in with an own registration.

## Review round 1

Findings from the GPT-6.1-Sol review of the whole diff and from the separate Claude evaluator, numbered in the order of the fix brief.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | GPT-6.1-Sol, blocking | Display-name escaping handled only the ASCII apostrophe. PowerShell also ends a single-quoted string at U+2018, U+2019, U+201A and U+201B. | On PR #162: validation rejects those four characters and points to the straight apostrophe, which is still doubled. A second commit writes non-ASCII display-name characters as `[char]` codes, because Windows PowerShell 5.1 reads a BOM-less .ps1 in the system code page and Windows-1252 decodes UTF-8 bytes of letters such as U+00C2 as quote delimiters. Both create and extend modes were checked after the rebase; the only other user value, the client ID, is GUID-validated. Tests run the generated assignment in pwsh when it is installed. | `b8f79f4`, `af761fd` (PR #162 branch) |
| 2 | GPT-6.1-Sol, blocking; also the evaluator's account-verification finding | Check again (interactive fallback) and Add access accepted whatever account signed in. | The stored username is sent as `loginHint`. After sign-in the returned homeAccountId and tenant ID must match the stored tenant; otherwise nothing is saved and `TenantAccountMismatchError` names both accounts. The same check covers the connector session, Entra tier probe and run delivery fallbacks. Correction from round 2: the earlier text said the run path was covered. It was not; the `buildGraph` fallback behind agent runs, Chat Graph tools and cache refresh still signed in without the hint or the check (round 2, finding 1). | `39c9cc7` |
| 3 | GPT-6.1-Sol, should fix | Gating checked single scopes, so an own registration with only SecurityAlert.Read.All showed Defender as not connected while alerts refreshed and Chat used them. | `availableScopeSet`: a part scope counts only when a part that lists it is fully granted. It backs cache refresh, Changes, missing-service copy, Chat planning and tools, and the run review, matching Settings and agent preflight. Unrecorded grants and the sample tenant stay fully connected. | `afd43ae` |
| 4 | GPT-6.1-Sol, should fix | Agents without Graph reads were tagged `intune` with `TODO(ugur)`. | `services: []` is allowed only without Graph scopes (schema, SDK types, parser, `services-cover-scopes`, preflight). Both team agents use it, the TODOs are gone, the index is at revision 10 and the generated docs are refreshed. | `0b571dd`, `4b1b235` |
| 5 | GPT-6.1-Sol, should fix | Inference for manifests without `services` dropped unowned scopes, so Group.Read.All meant no dependency. | Group.Read.All, GroupMember.ReadWrite.All, IdentityRiskyUser.ReadWrite.All (Entra), SecurityAlert.ReadWrite.All and SecurityIncident.ReadWrite.All (Defender) are agent-only scopes with reasons. Any scope still unmapped blocks preflight and the run review: "This agent uses <scope>, which OpenAdminOS does not map to a service yet." | `89e56d6` |
| 6 | Evaluator | Chat answered silently when some planned resources were dropped. | A partial answer ends with "Not included in this answer: <resources>." plus the missing service or part and "Add it in Settings, Tenants.", in both the sent and the streamed answer. | `0be8b0b` |
| 7 | Evaluator | Reconnecting overwrites stored grants. | Kept on purpose. Grants mirror the token on every sign-in (criterion 5). | none |

Lokka check on 2026-11-04 (lab tenant, app-only), `GET /v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?$select=oauth2PermissionScopes`: Group.Read.All `5f8c59db-677d-491f-a6b8-5f174b11ec1d`, GroupMember.ReadWrite.All `f81125ac-d3b7-4573-a3b2-7099cc39df9e`, IdentityRiskyUser.ReadWrite.All `e0a7cdbb-08b0-4697-8264-0069786e9674`, SecurityAlert.ReadWrite.All `471f2a7f-2a42-4d45-a2bf-594d0838070d` and SecurityIncident.ReadWrite.All `128ca929-1a19-45e6-a3b8-435ec44a36ba` are enabled delegated scopes needing admin consent. Device.ReadWrite.All is not a delegated scope, so it was not added.

## Review round 2

Findings from the second GPT-6.1-Sol review of the whole diff and from the separate Claude evaluator.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | GPT-6.1-Sol and evaluator, blocking | The `buildGraph` interactive fallback, which serves agent runs, Chat Graph tools and cache refresh, signed in without `loginHint` and without `assertSignedInAccount`. Round 1 wrongly listed the run path as covered. | The fallback goes through `interactiveSignIn` with `loginHintFor(tenant)` and calls `assertSignedInAccount` before returning the result, so another account or directory throws `TenantAccountMismatchError` before any Graph request and before `recordTokenGrants`. Tests through `buildGraph` cover both mismatch cases (no fetch, grants unchanged) and the matching account. Every interactive path now has the hint and the check: `buildGraph` (runs, Chat, cache refresh, drift), the connector session, Add access, Check again, the Entra tier probe and both run delivery fallbacks. First connect has no stored account, so it takes no hint. | `ac12d03` |
| 2 | GPT-6.1-Sol, should fix | Multi-tenant Chat preflight took missing access only from cached Graph errors. A tenant granted only User.Read was ready for a Windows compliance comparison, and refresh skips were dropped, so old or empty cache rows of an unavailable service read as a current scan. | Preflight applies `availableScopeSet` per tenant: unavailable resources make the tenant `missing-scopes`, list the scopes to add and name the service ("Not included: ..." plus the missing service copy), and their cache rows and errors no longer count. A refresh skip of managed devices marks the tenant skipped with the service named; other skips add the same warning. Either way the job ends partial. Tests cover the User.Read-only tenant, a tenant whose Intune access was removed after rows were cached, and grants removed between preflight and refresh. | `863d69f` |
| 3 | Evaluator, nit | `services: []` was refused for an agent with only baseline sign-in scopes, because the parser and `services-cover-scopes` counted User.Read while `scopesNotCoveredByServices` exempted it. | `scopesRequiringService` in the service registry is the one rule: baseline scopes need no service. The parser, the QA check and `scopesNotCoveredByServices` use it; the schema description and authoring docs say so. | `062e16c` |

## Review round 3

Findings from the third GPT-6.1-Sol review of the whole diff and from the separate Claude evaluator.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | GPT-6.1-Sol, blocking | Silent token acquisition picked the cached account by homeAccountId only. A B2B guest shares one homeAccountId across directory profiles and MSAL returns the first, so Check again for tenant B could silently get tenant A's token and save A's grants under B. | `findTenantAccount` matches homeAccountId and tenant ID among the per-profile accounts that `getAllAccounts` returns in msal-node 5.3.1 (msal-common 16.11.0). Silent requests use `tenantAuthority(tenantId, configured authority)`, which keeps the registration's host. Interactive sign-ins for a stored tenant use the same authority through `signInTargetFor`. `acquireTokenSilent` and `createTenantSession` check every silent and interactive result with `assertSignedInAccount`, which also compares the token's tenant ID, before the token is used or grants are recorded. This covers the connector session, `buildGraph`, Add access, Check again, the Entra tier probe and run delivery. A silent mismatch never falls back to sign-in. | `660845b` |
| 2 | GPT-6.1-Sol, should fix | The parser checked coverage only for `services: []`, so an agent with Intune scopes declaring `services: [entra]` passed run preflight with Entra connected and Intune missing. | The parser applies `scopesNotCoveredByServices` to every explicit declaration and suggests the covering services. Run preflight and the run review block an installed agent whose stored services leave a scope uncovered (`uncoveredScopesCopy` names the scopes and the service to declare), which covers agents installed before the check. Manifests without `services` still get them derived. The schema description and authoring docs say which checks enforce it. | `7ef5036` |
| 3 | Evaluator, coverage gap | No account-mismatch tests for the connector tenant session, the Entra tier probe and both run delivery fallbacks. | Tests for each, asserting no Graph request and nothing saved. They found two gaps, fixed in their own commits: the tier probe saved an unknown tier and cleared licences on a mismatch, and the Teams and Outlook connectors hid the mismatch behind a generic token error that was then retried. | `102a6ec`, `8ad2794`, `a0bfbd0` |

## Review round 4

Findings from the fourth GPT-6.1-Sol review of the whole diff and from the separate Claude evaluator.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | GPT-6.1-Sol, blocking | One invalid bundled, user-authored or local manifest made `listAgentsInRoot` throw, so `getAppState()` failed and tenants, installed agents and history did not load. The stricter services coverage check (round 3, finding 2) adds a new way to hit this. | Validation stays strict, but each manifest is parsed on its own. `listAllRegistryAgentsWithIssues` returns the valid agents plus an `InvalidAgentManifest` per failure (id or folder, registry path, file path, reason, source, and the text of a user-authored manifest). `AppState.invalidAgents` carries them, and an installed agent whose folder matches gets `manifestError`, derived on every read and not persisted. The Agents list shows it as unavailable with the reason and a disabled Run; the hub lists each invalid manifest with the reason, file and Edit manifest; the agent page shows the designed notice with Edit manifest (local agents, through the existing editor and `updateUserAgentDraft`) and Uninstall (which already removes a local agent's folder). `startRun` refuses it from every caller, enabling its schedule is refused, and the scheduler skips it without recording a run. Tests: the runtime listing with a services mismatch and broken YAML, `getAppState()` with one invalid local manifest (Intune scopes declared as `services: [entra]`) loading tenants, history and the other agents, run and schedule refusal, the scheduler skip, and the renderer list, hub row and agent notice. The Claude evaluator noted that installed agents cannot carry a `services` field from before this branch, so the new check cannot break an existing install by itself; it can break a local manifest edited or authored on this branch. The fix also covers the older weakness where any invalid user manifest broke listing. | `f2d594a`, `e1aceb9` |
| 2 | GPT-6.1-Sol, should fix | Entra tier probe account mismatches were swallowed: Check again, connect and `probeAllTenants` discarded the probe's rejection, so a mismatch kept the stored tier silently and Check again reported plain success. | `probeEntraTierWithWarning` runs the probe for those callers, keeps the stored tier and licenses, and saves `tierProbeWarning` (message, `accountMismatch`, time) on the tenant, using the `TenantAccountMismatchError` text. Other probe rejections were also silent, so they are saved the same way; failures inside `probeSubscribedSkus` still save an unknown tier as before. Check again awaits the probe and returns the warning with the new grants; Settings and the add permissions dialog show "Permissions checked, but the license check did not finish." with the recovery text instead of success. Settings, Tenants and the tenant switcher show the warning. A probe that finishes, a new sign-in or new grants clear it. Tests through `refreshTenantGrants`, `connectTenant` and `probeAllTenants`, plus renderer tests for Settings, Check again and the switcher. | `5933d67`, `4493007` |

## Review round 5

Findings from the fifth GPT-6.1-Sol review of the whole diff and from the separate Claude evaluator.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | GPT-6.1-Sol, blocking | `probeSubscribedSkus` returned null for HTTP errors, network errors, cancelled sign-in and malformed answers, and the caller saved tier unknown, licences [] and cleared the warning, so Check again reported success. | The probe throws `SubscribedSkusProbeError` with a reason (`http` with status, `network`, `timeout`, `malformed`) and passes token errors through. Any failure keeps the stored tier, licences and `intuneLicensed`, and saves `tierProbeWarning` with `reason`: `http` (and `status`), `network`, `timeout`, `malformed`, `cancelled`, `account-mismatch` or `sign-in`. Only an answer clears it. Without Organization.Read.All the probe does not run and no warning is saved; Settings and the switcher show "Licenses not checked". Tests: each failure through `probeAllTenants`, Check again with HTTP 500, the not-granted case, and the runtime probe. | `5388160`, `b1a09ae`, `aa87a91` |
| 2 | GPT-6.1-Sol, should fix | Check again had no working cancel and the probe fetch had no deadline. | Check again, Retry license check and Add access run as tenant checks: one per tenant, a cancel IPC (`cancelTenantCheck`) whose AbortSignal reaches silent MSAL, the interactive sign-in and the Graph fetch, a five minute deadline for the whole check, and a 30 second deadline on the fetch. `AppState.tenantChecks` carries the phase, so the UI shows "Waiting for Microsoft sign-in" while a sign-in window is open. Grants and the probe result are saved in one write after the probe, so a cancel leaves both as they were and ends in a designed message; a deadline during the probe saves the grants with a `timeout` warning. Tests: cancel during sign-in and during the fetch, cancel of a retry, deadline before a token and during the fetch, and the renderer waiting and cancelled states. | `8367935`, `b1a09ae`, `aa87a91` |
| 3 | GPT-6.1-Sol, should fix | A failed licence check could not be retried when grants were unchanged, because `TenantGrantsUnchangedError` was thrown before the probe. | With a `tierProbeWarning`, Check again runs the probe even when grants are unchanged; without one it still reports unchanged grants. Shared-app tenants retry through item 5. Tests for both cases. | `b1a09ae` |
| 4 | GPT-6.1-Sol, should fix | Invalid-manifest detection skipped agent update overrides in `<userData>/agent-updates/<slug>/manifest.yaml`, and invalid bundled entries were dropped once the registry index loaded. | `effectiveAgentManifestIssue` in the runtime validates the manifest the resolver would load for each installed agent, whatever the index holds. `getAppState`, `startRun`, schedule enable and the scheduler use it, and its entry replaces a listing entry for the same folder, so a valid update over an invalid bundled copy runs. An update source is labelled `update` with its own recovery text. Tests: an invalid update is unavailable, refused and skipped by the scheduler; a valid update runs; a populated index does not hide an invalid bundled manifest; the renderer names the update source. | `34423a9` |
| 5 | Evaluator | Shared-app tenants never got a licence probe after Add access, and their warning could not clear. | Add access clears the warning and runs the probe with the new grants before saving both. The warning in Settings, Tenants and the tenant switcher offers Retry license check for every tenant kind, through `retryTenantLicenseCheck`, which runs only the probe with the same cancel and deadline. Add access stays open with the warning when the probe did not finish. Tests through `addTenantAccess`, `retryTenantLicenseCheck` for both tenant kinds, and the renderer. | `b1a09ae`, `aa87a91` |
| 6 | Evaluator | The agent page showed the manifest error twice for an invalid agent, the second with the wrong recovery and a missing period. | The page does not load a manifest already known to be invalid and waits for the app state before loading one. Load errors end with a period before the recovery. Tests fail on the old code. | `70d80e1` |
| 7 | Evaluator | The `InvalidAgentManifest` JSDoc sat on `TenantTierProbeWarning`. | Moved back. | `91248be` |

## Review round 6

Findings from the sixth GPT-6.1-Sol review of the whole diff (G) and from the separate Claude evaluator (E). The round 5 design, which saved grants and the license result in one write after the probe, with the cancel guard outside the write queue and a busy guard for foreground checks only, caused most of them. It was replaced by a simpler one: grants are saved as soon as the token is verified and a cancel never rolls them back; the license check is its own step that only changes tier, licenses and `tierProbeWarning`; every check and probe runs as one operation per tenant that rejects as soon as its signal aborts; and saves check a per-connection `connectionId` inside the write queue. `saveGrantsWithLicenseCheck`, `probeEntraTierWithWarning`, `settleEntraTierProbe`, `rejectOnCancel`, `throwIfCancelled` and the public `probeEntraTier` were removed.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| G1, E-B | GPT-6.1-Sol and evaluator, blocking | A cancel after the save was queued still committed while the UI said nothing changed. | Grants from a verified token are saved without a cancel check, and the operation records that before queuing the write, so a cancel says "Access was added. The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them." Test: cancel while the save waits behind another write. | `037a3e9` |
| G2 | GPT-6.1-Sol, blocking | The deadline did not cover `findTenantAccount`/`getAllAccounts`, so a stalled cache read hung Check again and kept the tenant guard. | `findTenantAccount` waits through the signal, and the operation itself rejects on any abort, cancel or deadline, so the guard is always released. Tests: runtime stalled cache read, and a stalled read that reaches the deadline and lets the next check start. | `d4e15cb`, `037a3e9` |
| G3 | GPT-6.1-Sol, blocking | An old check could save grants onto a replacement connection of the same tenant ID. | `TenantRecord.connectionId` changes on every connect; connect and disconnect stop the running operation, and every save re-reads the tenant in the write queue and drops results from another connection. Token grants recorded during runs follow the same rule. Test: a reconnect during Add access, with the old sign-in answering late, saves nothing. | `037a3e9` |
| G4 | GPT-6.1-Sol, should fix | The background connect probe bypassed the per-tenant guard, so a slow older probe could overwrite a newer retry and two sign-ins could compete. | Connect and `probeAllTenants` probes run as tenant operations (skipped while another one runs); a foreground check gets the busy message and can cancel it. A stopped operation saves nothing, and a license result older than the last saved one is dropped. Test: a slow background probe, cancelled, then a successful retry, then the late answer; the retry's tier stays. | `037a3e9` |
| G5, E-C | GPT-6.1-Sol and evaluator, should fix | "The tenant's permissions are unchanged" was false after Microsoft consent succeeded. | The host builds the message from what the operation did: "Sign-in was cancelled. Nothing changed." before a token, the added or updated access plus the license line after it. The renderer shows the host's message. A cancelled or expired license check is saved as a warning, so Retry license check is offered. | `037a3e9`, `2dd0075` |
| E-A | Evaluator, should fix | Progress and Cancel rendered only in the component that started the check. | `TenantCheckStatus` reads `AppState.tenantChecks` and renders in the Settings row, the add access dialog and each switcher row, whichever view started the check. Test: the switcher starts Retry license check, its menu closes, and Settings shows the progress and a working Cancel. | `2dd0075` |
| E-D | Evaluator, should fix | Check errors showed Electron's "Error invoking remote method ..." prefix. | `toError` in AppStateContext strips the prefix once and keeps the host's error name, which tells a cancel from a failure. Tests for a named cancel and a plain error. | `b5eae66`, `2dd0075` |
| UI | Evaluator, nits | The switcher cancel X sat next to the disconnect X; "Licenses not checked" showed twice on the Settings row; Add permissions stayed enabled during Check again. | Cancel is a labelled "Cancel check" button under the tenant; the Settings row names it once; Add access, Add permissions and the part buttons wait while a check runs. Tests for each. | `2dd0075` |

## Review round 7

Findings from the seventh GPT-6.1-Sol review of the whole diff (G) and from the separate Claude evaluator (E). Each fix has tests that fail on the code before it.

| # | Source | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| G1 | GPT-6.1-Sol, blocking | `saveTierProbeOutcome` checked the cancel before `await this.read()` in the write queue, so a cancel or deadline during the read still wrote the new tier and licenses, and the queued cancel warning kept them while the message said the old values were kept. | One commit point inside the serialized callback, after the read and right before the write: a stopped operation, an older result or another connection saves nothing. Past it `operation.committed` is set and cancel and deadline are ignored, so the check reports the result it saved. For grants the commit point stays the verified token, as in round 6: `operation.grants` is recorded before the save is queued, a cancel keeps them and says so, and inside the queue only the connection is checked after the read. Tests: cancel while the save's read is held (tier kept, cancel warning saved), cancel while the write is held (normal result, new tier, no warning). | `a092205` |
| G2 | GPT-6.1-Sol, should fix | `runTenantCheck` releases the caller on abort without stopping the work, so a sign-in that ignored the signal and answered later was still verified and saved. | `tenantCheckSignIn` (Add access, the Check again fallback and the license check sign-in) and the silent token in Check again reject with `signal.throwIfAborted()` as soon as the token returns, before grants are recorded. Grants recorded and queued before a cancel are still saved. Tests: Add access with a sign-in that ignores the cancel and answers late saves nothing (fails before the fix); the same for the silent token in Check again (regression guard; the runtime already drops it). | `d15a63c` |
| E1 | Evaluator, low | A reconnect in the gap before a check registered made `saveCheckGrants` and `saveTierProbeOutcome` return quietly on the connection mismatch, so the dialog reported success. | Both throw `TenantCheckSupersededError`: "This tenant was reconnected while the check ran. Run the check again.", or a disconnected variant. Connect stops an operation on another connection again after `forgetReplacedSignIn`, right before its background license check, so a stale check that registered in between cannot block it. Tests: Add access whose read is held across a reconnect rejects with the message; a stale check that registers during the reconnect is stopped and the new connection's license check saves P2. | `586d94e` |
| E2 | Evaluator, copy | "Sign-in was cancelled. Nothing changed." can be false when consent was accepted on Microsoft's page before the cancel. | "Sign-in was cancelled. OpenAdminOS saved nothing." The Check again cancel and both deadline messages had the same claim and use the same words. | `2180c2c` |
| E3 | Evaluator, copy | The Marketplace service filter labels prefixed "✓ ". | The prefix was the established pattern for every filter on the Agents page, so all of them changed. `Menu` items take `checked` (and `radio`), rendered as `menuitemradio` or `menuitemcheckbox` with `aria-checked`, the selected background and a check icon, as in the tenant switcher. Keyboard navigation covers every item kind. Tests: Menu checked state and focus, the service filter's checked state. | `8753761` |
| G3 | GPT-6.1-Sol, nit | SPEC said Connect used the same per-tenant operation mechanism. | SPEC says Connect has its own controller and cancel, stops a running check after saving the new connection, and starts the license check as an operation on the new one. It also records the commit point and the reconnect message. CHANGELOG line updated. | `cbaab3d` |

Verification: typecheck, electron 774 pass, renderer (Node 22) 398 pass in 53 files, runtime 254 pass and 2 skipped, qa-graph 71 pass, `npm run qa` 197 pass, 4 warn, 0 fail, test:scripts 18 pass, docs:check clean.

## Criterion 10 evidence

- Light and dark screenshots of the service picker, the own-registration view, the Settings per-service rows and dialogs, the not-connected panel, the Changes gate, the Marketplace chips and filter, the agent detail notice and the run review were captured on 2026-11-04 in `/private/tmp/claude-501/-Users-ugurkoc-Desktop-GitHub-OpenAdminOS/330f8253-e29b-4f12-aead-2997aec35ed3/scratchpad/services-shots/`. They are local only and not committed.

## Review round 8

- **GPT-6.1-Sol:** no blocking issue. The round 7 fixes were checked: licence commit point, late tokens rejected, the superseded error, cancel copy against what is saved, Menu roles, and SPEC. 177 focused tests pass. One nit: CONTRIBUTING.md said `services: []` was allowed only with no Graph scopes. Fixed in 7d75e1b to say "beyond the sign-in baseline".
- **Claude evaluator:** no blocking issue. All suites are green: electron 774, renderer 398, runtime 254 with 2 skipped, qa-graph 71, qa 0 fail, scripts 18, docs:check clean. Criteria 1 to 9 pass. Criterion 10 was pending only on this GPT round. The menus were checked live for keyboard and screen reader behaviour. Screenshots are r8-*.png.
- **Known edge, not fixed:** a cancel after "Access was added" followed by a complete interactive reconnect while the grants save is still queued. The save then throws superseded, but the cancel message already said access was added. This needs a full reconnect inside a write-queue wait, so it is left as is.

## Status before PR

- Both reviewers are clean at 7d75e1b.
- Still open, needs the owner:
  - The lab checks: `.default` delegated sign-in with an own registration, the Defender alerts, incidents and Secure Score endpoints with a permissioned connection, and the extend script's PATCH writes.
  - The `TODO(ugur)` decisions in code.
  - Approval to push the two PR #162 fixes (b8f79f4, af761fd) and to open the stacked PR.

## PR 167 review

| # | Severity | Finding | Resolution | Commit |
| --- | --- | --- | --- | --- |
| 1 | Blocking | About 11 tier probe tests were cancelled on Node 22 because the tenant check deadline in `runTenantCheck` used an unreferenced timer, so a process with nothing else pending exited before it fired. | The deadline is a referenced timer started right before the operation runs and cleared in its finally block on success, failure, cancel and supersede, as `entra-tier.ts` already does since 42e07c6. No other deadline timer was added unreferenced by this PR; the remaining `AbortSignal.timeout` and `.unref()` uses predate it. `tier-probe-warning.test.ts` on Node 22: 35 pass, 0 cancelled (was 24 pass, 11 cancelled). | `c1b3884` |
| 2 | Should fix | The Changes permission filter only affected status rows; the timeline and comparisons still read snapshots of a service that is no longer connected as current. | Timeline, baseline drift, new baselines, time, bundle and cross-tenant compare, rollback plans and fleet counts apply the part-level `availableScopeSet` rule and return `omittedResources`. Changes and Fleet name the service ("Intune is not connected. Its earlier snapshots are not compared."), and entry detail from those snapshots is labelled "Historical snapshot, no longer refreshed." Tests: an Entra-only fixture requesting deviceConfigurations gets no current comparison and a visible omission; renderer tests for the timeline notice, the compare notice and the historical label. | `7d8a3ee`, `fa4b7fe` |

Verification on Node 22: electron 796 pass, renderer 407 pass in 53 files, runtime 255 pass and 2 skipped, test:scripts 18 pass, `npm run qa` 197 pass, 4 warn, 0 fail, typecheck and docs:check clean.

# Marketplace MCP servers, second wave (2026-11-05)

Branch `marketplace/second-wave` off `main` (98ddfc3). The owner asked to add three servers that need no sign-in. Each was probed live on 2026-11-05 with initialize, notifications/initialized and tools/list: no 401 and no OAuth metadata.

| Server | Endpoint | Operator | Transport seen | Tools listed |
| --- | --- | --- | --- | --- |
| Microsoft Release Communications | `https://www.microsoft.com/releasecommunications/mcp` | Microsoft (Microsoft API Terms of Use) | SSE, no session id, protocol 2025-06-18 | `get_recent_m365_roadmaps`, `get_m365_roadmap_by_id`, `get_recent_azure_updates`, `get_azure_update_by_id` |
| WindowsForum | `https://mcp.windowsforum.com/` | WindowsForum.com staff | SSE | 29 readOnly tools, among them `search_kb`, `get_kb_article`, forum search and member lookups |
| endoflife.ai | `https://mcp.endoflife.ai/mcp` | Not named on the site (built on endoflife.date data) | plain JSON | `check_eol`, `get_product_lifecycle`, `get_upcoming_eol`, `get_kev_exposure`, `get_risk_score`, `get_upgrade_path`, `scan_stack`, `check_sbom`, `list_products`, `get_edge_device_status` |

## Acceptance criteria

1. The catalog in `apps/desktop/electron/mcp/catalog.ts` lists the three servers. Each has its name, publisher, URL, description, pitch, `useFor` line, aliases and topics. Where the operator is not named, the publisher says so plainly ("Operator not named"). Nothing implies Microsoft runs a server it does not run.
2. **Tool allowlist.**
   - A catalog entry can list the tool names it exposes. The host still lists tools live, but Chat, the Marketplace tool list and the query writer only ever see allowlisted tools.
   - A call to any other tool is refused before anything is sent.
   - If an allowlisted tool is missing from the server, the Marketplace shows a designed state naming the missing tools, and Chat skips that server.
   - Allowlists:
     - WindowsForum: `search_kb` and `get_kb_article` only.
     - endoflife.ai: everything except `scan_stack` and `check_sbom`, which take bulk software inventories.
     - Release Communications: all four tools, by their live names.
   - Existing servers stay as they are (no allowlist means every tool the server lists).
3. **Transports.** The MCP host works with SSE replies that carry no session id (Release Communications), with plain JSON replies (endoflife.ai) and with SSE plus a session (WindowsForum). Unit tests cover each shape with fixtures. A live probe test runs the handshake, tools/list and the allowlist check against all three; it is skipped when offline or in CI, like the existing live test.
4. **Query writer.**
   - It writes these servers' arguments from the current question only, as for the first wave.
   - An argument that names a specific item (a roadmap ID, an Azure update ID, a KB article number) is sent only when it appears in the current question or in an earlier result from the same server in the same answer. This follows the existing rule for Learn fetch URLs.
   - The egress filter applies unchanged.
5. **Results.**
   - Results are parsed by structure into sources: title, URL where the server gives one, and a short excerpt.
   - Results are numbered and cited like Learn results and fenced as third-party content.
   - Forum and KB text is treated as untrusted.
   - A server that answers with an error or an empty result shows a designed state and never fails silently.
6. **Routing.** Naming a server or its alias calls it. Topic words choose it for docs questions:
   - roadmap, retirement, "what's new", rollout, Azure update: Release Communications;
   - KB, cumulative update, known issue, patch, update history: WindowsForum;
   - end of life, end of support, lifecycle, EOL, support ends: endoflife.ai.

   Learn stays the default docs source.
7. **Disclosure.**
   - The status strip, composer, tooltips and hosted send confirmation name the new hosts when the servers are enabled.
   - The install review shows the operator, the host, a terms or privacy link where one exists, and the tools that will be offered.
   - For endoflife.ai it says the operator is not named and no privacy page was found.
   - For WindowsForum it says forum content is community text.
8. **Docs.** SPEC, CHANGELOG `[Unreleased]` and the Marketplace page in `docs/gitbook` describe the three servers, the allowlists and the reasons for them. `docs:check` passes.
9. **Tests and reviews.**
   - All suites pass under Node 22, as CI runs them.
   - The renderer covers the Marketplace cards and install review for each server.
   - Light and dark screenshots of the cards and install reviews.
   - A separate Claude evaluator and GPT-6.1-Sol review the whole diff with no open blocking findings.
   - A live check in the running app asks one question per server.

## Status (2026-11-05)

1. [x] Catalog: three entries with name, publisher, URL, description, pitch, useFor, aliases, topics. Deviation: endoflife.ai does name its operator (EndofLife AI Inc., Alberta) and has a privacy page (https://endoflife.ai/privacy), so the catalog says so instead of "Operator not named". WindowsForum's own server text names Fara Technologies LLC.
2. [x] Tool allowlist in catalog, host (listing and calls, nothing sent), state (summaries, Chat skip) and renderer (missing tools state, status strip).
3. [x] Transports: replay tests for SSE without session, plain JSON, SSE with session and log notifications; live probe test, skipped in CI, with OPENADMINOS_SKIP_LIVE and offline. WindowsForum issued no session id on 2026-11-05.
4. [x] Query writer: item params (roadmap id, Azure update id, kb_id) only from the question or an earlier same-server result; generalizes the Learn link rule. Live check added null-param dropping and catalog query hints.
5. [x] Results parsed by catalog formats into numbered, cited sources; designed empty ("found nothing") and error ("returned an error") states; WindowsForum results marked community text.
6. [x] Routing topics and aliases as listed; topics match before digits; names match only as whole words; Learn stays default.
7. [x] Disclosure: strip, composer, tooltip and hosted confirmation name the hosts; install review adds Who runs it and Tools Chat will be offered.
8. [x] SPEC, CHANGELOG, new docs/gitbook/features/marketplace.md; docs:check passes.
9. [ ] Tests under Node 22 pass (typecheck, electron 973, renderer 493, runtime, qa, test:scripts, docs:check, three smokes); renderer covers each card and install review; light and dark screenshots taken; separate Claude evaluator run (one finding, fixed). GPT-6.1-Sol reviewed the whole diff in five rounds; round 5 at 47a4648 found nothing. Open: a live check in the GUI app. The live check ran through the main-process Chat path with gpt-oss:20b: WindowsForum answered with results and a get_kb_article call on an ID from its own search; Release Communications sent a valid OData query and showed the empty state; endoflife.ai showed the error state. Answer quality from gpt-oss:20b was poor (tenant-evidence guard, protocol drift), unrelated to this branch.

## Review round 1 (2026-11-05)

GPT-6.1-Sol review of the whole diff against 98ddfc3. All six findings fixed, each with a test that fails before the fix:

1. [x] Blocking: IDs in OData `filter` bypassed the item-ID rule. A catalog `itemIds.filter` entry names the filter param and its item fields (`id`, `baseId`); `electron/intune-chat/mcp-filter.ts` parses the filter before sending, checks every value compared with an item field, writes it as the server compares it (number for roadmaps, text for Azure updates, both checked live) and refuses a filter outside its grammar with a designed message.
2. [x] Normalization collisions. Each tool declares an ID form (roadmap: digits; Azure update: digits or lowercase slug, as live IDs such as `2021regions` show; KB: digits with optional KB prefix). The question is split on characters the form cannot hold, only the KB prefix is an equivalent, and the canonical ID is sent.
3. [x] KEV citations lost their URL. Result formats can name `inheritUrl` keys; CVE entries take the enclosing `source.url`.
4. [x] www.microsoft.com named Release Communications. `sharedHost` entries are named by name, aliases or full URL with path; host matches refuse a following label.
5. [x] Details said a skipped server receives the query text; it now says Chat sends nothing until the tools are back.
6. [x] The query writer prompt contradicted itself on IDs; it now has one rule for item IDs.

## Review round 2 (2026-11-05)

GPT-6.1-Sol review of the whole diff against 98ddfc3. Four findings, all fixed, each with a test that fails before the fix:

1. [x] Important: KEV entries that share one citation lost later CVE identities. In the numbered excerpts, an item whose title differs from its group's first title now starts with its own title, for every server.
2. [x] Important: formatted lists lost completeness and paging. The reader counts every matching record past the ten it lists and keeps the number and true or false fields of the list's top-level record. The model reads those counts, how many records were left out and whether the server has more (a hasMore flag, or a record total above offset plus records), with the words to use ("Showing 10 of 33"). The step reads "10 of 33 results" and "the server has more". The query writer of a further call to the same tool sees what earlier calls sent, listed and counted, so it can set skip; checked live (skip 50 gives offset 50, hasMore true).
3. [x] Minor: an empty or blank optional param, such as `"filter": ""`, is left out like null; a required one left empty is refused before sending with a designed message.
4. [x] Minor: `windowsforum.com` is an alias of WindowsForum; an email address or longer domain still names nothing, and sharedHost is unchanged.

A separate Claude evaluator found no blocking issue; its below-threshold notes (a count above the records returned without a hasMore flag, totalPages read as a total) were fixed too.

## Review round 3 (2026-11-05)

GPT-6.1-Sol review of the whole diff against 98ddfc3. No blocking finding; one important finding, fixed with tests that fail before the fix:

1. [x] Important: missing-tool gating was bypassed on automatic reconnect. After a restart, the stored listing still offered the server, and a session opened for a call found a tool missing but still dispatched the others. The host now refuses every call while the session lacks an offered tool (`tools-missing`, nothing sent, the message names the tool and Check connection), and a session opened for a call stores its listing so the Marketplace shows "Installed · tools missing" and Chat skips the server.

## Review round 4 (2026-11-05)

GPT-6.1-Sol review of the whole diff at 6aa2c13. No blocking finding.

1. [x] Important: the session promise awaited the listing report, which takes the store lock, while uninstall and disable hold that lock and wait on the session. Fixed in e0176a3 (also flagged by the automated security review): the report runs in the call after the session opens; a test closes a session while its report is held.
2. [x] Minor: a failed listing save was dropped and never retried. The next call on the session retries, the refusal says the Marketplace still shows the old tool list, and the error detail goes to the local log only, since the message reaches the model.

## Review round 5 (2026-11-05)

GPT-6.1-Sol review of the whole diff at 47a4648: no blocking, important or minor findings. Both round 4 fixes held, including Check connection racing a call that opens a session.

# Model first, services as connections (2026-11-08)

Direction approved 2026-11-08 (SPEC §4a, "Decided 2026-11-08"). Design: `docs/mockups/32-connections-first-run.html`. Branch `design/connections-first-run` holds the design only; implementation gets its own branch off `main`.

## Decisions (2026-11-08)

- The shell scope is an organization that holds one Microsoft 365 tenant and one instance per other vendor service.
- No-sign-in MCP servers are suggested on the empty Chat, never preinstalled.
- Order: mockup, SPEC and public issue first, then implementation.

## Acceptance criteria for the implementation

1. A fresh install with a ready model opens Chat with no welcome screen and no setup dialog; with no ready model, Chat shows the inline model choice and a "Preview with sample data" link. Nothing else is required to send a message.
2. With no organization, a docs question sends and is answered from the model, the local docs index and enabled public references; no Graph call and no sign-in prompt happen.
3. A tenant or mixed question with no organization, or with the needed service not connected, returns the not-connected card naming the service, part and permissions, with Connect, own registration and send-to-admin actions. The draft is kept; after a connect the admin resumes explicitly.
4. The empty Chat suggests public references with their hosts and none are installed by default. With a local model and no reference, the status strip says nothing leaves the device. With a hosted model, the strip and composer name the provider and its region before any reference is added, and add every reference host once one is.
5. Organizations: created by the first connection, renamable, at most one Microsoft 365 tenant each; existing tenants migrate to one organization each with no loss of runs, conversations, cache, schedules, drift or registrations; the sample tenant becomes a labeled sample organization.
6. The Connections page shows the reach map and per-service rows, merges Settings, Tenants and Settings, Connectors, and its lists match the status strip.
7. Agents show their services and the action names what is missing. Only an agent that calls no service API (no Graph or vendor scopes, not even the sign-in scopes) runs without an organization; a test proves that an agent with `services: []` and only baseline scopes such as `User.Read` still needs an organization.
8. Hard constraint 3 wording is updated in `CLAUDE.md` and `AGENTS.md`, and every `requireTenant` gate is reviewed against it with tests.
9. Unit and renderer tests for each criterion, Playwright screenshots in light and dark, and a live check in the running app from a fresh profile.
10. SPEC and CHANGELOG updated, separate evaluator and GPT-6.1-Sol review before merge.
11. Each schedule belongs to one organization; migration moves existing schedules to the organization of the real tenant active at migration and says so; with no real tenant active (none, or pilot mode alongside real tenants) they stay paused and unassigned until the admin assigns them, never to the sample organization. Migration tests cover all three starting states, and a test proves a schedule never runs while another organization is active.
12. The first hosted send without an organization asks for confirmation naming provider, model, region and what leaves; a test proves that acknowledgement is refused for a send with tenant context, and the first send in an organization asks again.
13. A manual run without an organization opens the preflight, which names the services the agent needs; tests cover the Chat gate, hosted acknowledgement and preflight changes named in the SPEC block.

## Out of scope

Jamf Pro and Google Workspace connectors (separate issues; the mockup fixes the pattern only), MCP tools in agents, public catalog file.

## Steps

- [x] Mockup `32-connections-first-run.html`, checked at desktop and phone widths in light and dark
- [x] SPEC §4a decision block, mockup table row, CHANGELOG line
- [x] Public issue #171
- [x] Implementation plan with the `TenantRecord` to organization migration (part B, below)

## Part B plan: organizations and Connections (branch `organizations/connections`)

Criteria 5, 6, 7, 8, 11 and 13. Part A (criteria 1 to 4 and 12) is built on `first-run/without-sign-in`.

Data model: `TenantRecord` stays the Microsoft 365 connection. `OrganizationRecord` sits above it in `state.json` with an id, a name, an optional `kind: "sample"`, and `connections.microsoft365.tenantId`; other vendor services each add one keyed connection later. The active organization is the one that holds the active tenant, so `activeTenantId` stays the single source and every tenant-keyed store (runs, conversations, cache, drift, office) keeps working unchanged. Organization ids are derived from the tenant id (`org-<tenantId>`), so the migration is deterministic and idempotent at read time even though `read()` does not persist.

- [x] SDK types: `OrganizationRecord`, `AppState.organizations`, `AgentSchedule.organizationId`, migration notice, `agentCallsNoServiceApi`
- [x] Host: organization reconcile and migration on read, rename, choose No organization, schedule assignment, schedules gated by organization, service-free runs without a tenant
- [x] Host tests: migration from current state files (one real tenant active, none active, pilot alongside real tenants), idempotency, invalid records, schedule isolation, `services: []` with `User.Read` still needs an organization
- [x] Renderer: organization switcher, Connections page with reach map, routes and redirects, sidebar item, account menu, Settings sections removed
- [x] Renderer: agent service needs and named actions, preflight without an organization, schedules surfaces for unassigned schedules
- [x] Gates: review every `requireTenant` and `requireTenantAndProvider` call against hard constraint 3, with tests. Agent runs (Agents list, agent drawer, command palette, Run again) no longer gate on a tenant: they open the preflight, which names the services. Cache refresh, Changes, schedules (Run due now, Schedules page) and Chat keep the gate, because they always read a service. Chat is part A.
- [x] Docs: `CLAUDE.md`, `AGENTS.md`, SPEC, CHANGELOG, GitBook pages, `docs:generate`
- [x] Verification under Node 22, app launch on a migrated state file, screenshots light and dark

### Part B review (2026-11-09)

- Node 22: typecheck clean; electron `node --test` 1011 pass, 0 fail; runtime 256 pass; scripts 18 pass; renderer 518 pass in 60 files; `npm run qa` 197 pass, 4 warn, 0 fail; `npm run docs:check` clean.
- Live check: the dev Electron build on a state file in the current-version shape (two tenants, Woodgrove Bank active, two schedules, three runs, a saved custom registration, two references, a Teams delivery rule) with Anthropic through the Claude Code CLI, model `claude-sonnet-5`. Read gave two organizations named after the tenants, both schedules on Woodgrove Bank with the notice, runs on their tenants, and an untouched file; the first write saved it. With No organization, Find inactive devices was refused with the designed message, and Team PowerShell draft completed on `claude-sonnet-5` with no tenant. Screenshots in `docs/screenshots/organizations/`.
- Not verified here: a real Microsoft sign-in and Graph calls (no tenant tokens on the test profile), and Agent Team persona schedules, which keep their own tenant binding.
- Open: hosted provider region source for the reach map (`TODO(ugur)` in `apps/desktop/src/copy/connections.ts`).

## Design review (2026-11-08)

A separate design reviewer checked the mockup and SPEC block. Fixed: the reach map now lists every destination (references, result connectors, hosted provider) with a text alternative; strip strings and the MCP composer line match `apps/desktop/src/copy/trust.ts`; agents run without an organization only when they call no service API (`services: []` still allows sign-in scopes); the SPEC block names the rules it overrides; one primary action per view; starters use the registry's `chatExamples`; the admin request uses an admin consent link, and the consent role is Cloud Application Administrator (checked on Microsoft Learn); host text uses the higher-contrast token; the reach map collapses below 1180px; the real organization is no longer named like the pilot tenant; Jamf secret and partial states corrected.

Open states for the implementation plan: connecting a tenant that already belongs to another organization; adding Microsoft 365 to a Jamf-only organization; hosted provider with no organization (shipped copy says "tenant context sent"); wording that says "tenant" today; model install progress and failure; a model too small for tool use while references are suggested; a reference offline or failing to install; pilot Chat once a model is ready; schedules while "No organization" is active; renaming and deleting an organization.

## PR #173 review round 1 (GPT-6.1-Sol, 2026-11-08)

1. [x] Blocking: criterion 4 said the strip reports nothing leaves until a reference is added, which is false with a hosted model. It now applies to local models only and requires the provider and region with a hosted model before and after references.
2. [x] Criterion 7 kept the "declares no service" ambiguity. It now uses the SPEC condition and requires a test that `services: []` with baseline scopes still needs an organization.
3. [x] The Connections page said every report send shows a preview, but saved delivery rules post automatically. The page, the reach map label and the SPEC block now say reports go out under saved delivery rules.
4. [x] "References never receive tenant data" overstated the boundary. SPEC and mockup now say they receive no Graph or cache data, and private details typed into a question can reach them.
5. [x] planned.md applied Microsoft-only rules to Jamf. Those rules are now scoped to Microsoft 365 services, with a Jamf paragraph on API client access; the website copy is regenerated.

## PR #173 review round 2 (GPT-6.1-Sol, 2026-11-08)

Round 1 fixes confirmed. No blocking findings.

1. [x] SPEC and mockup said schedules are per tenant today; they belong to the agent and run against the active tenant (`state.ts` `fireDueSchedules`). Corrected, with schedule ownership, migration and isolation in the SPEC and criterion 11.
2. [x] The SPEC block did not name the Chat tenant gate, the tenant-bound hosted-send acknowledgement or the manual-run preflight. Named; consent for a hosted send without an organization is defined, with criteria 12 and 13.
3. [x] Jamf is OAuth client credentials (secret exchanged for an access token), not an API key. SPEC, mockup and planned.md corrected.

## PR #173 review round 3 (GPT-6.1-Sol, 2026-11-08)

Round 2 fixes confirmed. No blocking findings.

1. [x] Schedule migration had no destination when no real tenant is active or pilot mode is active. Such schedules now stay paused and unassigned until the admin assigns them, never to the sample organization; criterion 11 requires migration tests for all three states.
2. [x] The KQL example said "newest first" but sorts by failure count. Copy now says "largest groups first".

## Part A implementation: Chat without sign-in (2026-11-08)

Branch `first-run/without-sign-in`. Criteria 1, 2, 3, 4 and 12 above; part B (organizations, Connections, agents, schedules, hard constraint 3, preflight) is a separate branch. The scope is still a tenant in this part.

- [x] Remove the first-launch welcome; Chat opens with nothing configured and no dialog opens on its own (criterion 1)
- [x] Inline model choice in Chat when no model is ready, with "Preview with sample data" (criterion 1)
- [x] Chat sends with a model and no tenant; docs questions answer with no Graph call (criterion 2)
- [x] Not-connected card in the transcript for tenant and mixed questions with no tenant or with the service not connected; Connect preselects the service part, own registration, ask an admin (criterion 3)
- [x] Empty Chat starters labeled Works now or Needs a service, reference suggestions with hosts, strip and composer name the provider and region (criterion 4)
- [x] Hosted send without a tenant asks for its own confirmation, bound in main to no tenant plus provider and refused with tenant context (criterion 12)
- [x] First-launch model scan screen (scope change from the maintainer, 2026-11-09): parallel local-only checks with timeouts and Retry, outcome under the provider rules, Scan again in Settings, Providers; mockup 32 section B updated
- [x] Renderer and main tests per criterion, screenshots light and dark, SPEC, CHANGELOG, docs

## PR #175 review round 1 (separate Claude evaluator, GPT-6.1-Sol and Muse Wonder Full, 2026-11-09)

Reviewed commit 692241f. Each fix has a regression test. Findings 1 to 7 touch the same scan functions, so they landed in three layered commits (runtime 0e46f1b, host 9c2702a, screen 0eb25e5) instead of one per finding; each test names its finding.

Blocking
1. [x] The scan promised local answers while a remembered hosted choice stayed selected. A local model found next to the admin's own choice is now `local-available`: shown as "ready on this device, not selected" with an explicit switch; nothing is switched. Host and renderer tests.
2. [x] The Copilot probe listed models from GitHub. The scan uses an install-only Copilot probe (`copilot --version`); a fake-CLI test pins the arguments each CLI runs during the scan.
3. [x] App state ran unbounded provider detection, including off-device endpoints, before the scan. While the scan is pending, app state loads without provider detection, and scan checks never contact an Ollama or LM Studio endpoint off the device. Tests with a stalled provider list and an off-device `OPENAGENTS_OLLAMA_URL` with a fetch spy.

Should fix
4. [x] Timeouts did not stop probes. The scan timeout aborts the check; Claude Code and Codex probes kill their CLI and try no further binaries, CLI discovery terminates `--version`, Ollama requests abort. Tested with a hanging fake CLI that must be killed. Not done: the Apple Foundation helper probe still runs to its own 10 second limit.
5. [x] LM Studio with no loaded model counted as ready. It is now "Running, no model loaded" and not ready, in the scan and in shared provider readiness.
6. [x] A successful Retry kept the old outcome. Retry returns the whole scan with its outcome applied; renderer test for a timed-out hosted tool found on Retry.
7. [x] Failed checks were shown as negative results. HTTP errors, unreadable capabilities and CLI request failures are could not check with Retry; signed out stays a found, negative result.
8. [x] A multi-service card offered only the first service. It offers Add for each service still missing and Ask again once none is; tested by granting two services in sequence.
9. [x] A blocked tenant question asked for the hosted confirmation. The host requires no confirmation for a question blocked before any model call, and the renderer skips the dialog through a preview. With the tool loop the model classifies the question, so the question is sent and the confirmation stays.
10. [x] The remembered no-tenant confirmation ignored the model. It is keyed by provider and model now. Response: the tenant-bound key has never included the model; it is unchanged here so remembered tenant decisions keep working.
K. [x] Status commands may contact the vendor. The scan copy says each tool's own sign-in status command may check with its provider and that no prompt is sent; the arguments are pinned by test; the 2.5 second timeout covers version and status together.
L. [x] No in-flight guard. A second scan shares the running one, and progress carries a scan id the window filters on. Host and renderer tests.
M. [x] Code requests with "our" or "which" got the card. With nothing connected, any request to write a query or script is docs; tests for both phrasings; SPEC note updated.

Missing tests: added the positive no-tenant acknowledgement on the stream path. Response: the card's Connect, own registration, Ask an admin to approve and Ask again actions, and "no sign-in prompt for a docs question with no tenant", are covered by the IntuneChat renderer tests added in a254571 ("connects with the part preselected ... asks again only when chosen", "opens the own registration path from the card", "copies a message with the admin consent link", "sends a docs starter at once with no tenant, no setup dialog and no hosted confirmation").

Nits
N. [x] Card heading ids use `useId`; tested with two cards for one part.
O. [x] SPEC scan bullet says Gemini shows "sign-in not confirmed" until a Test.
P. [x] Nova voice with no tenant names the voice surface; tested.
Q. [x] `.cmd` shims are accepted on Windows. No test: the lookup reads the real file system.
R. [x] Leftover double block removed.

## PR #175 review round 2 (GPT-6.1-Sol and Claude evaluator, head 324eff4, 2026-11-09)

Blocking
1. [x] Hosted sends bypass confirmation: preview and execution classify differently. One shared routing decision; consent enforced right before every hosted model call; deterministic-path test on both send paths.
2. [x] Startup discovery while the scan is pending (Office tick, menu bar, schedulers). Gate every background discovery path; test the startup sequence from a fresh store.

Should fix
3. [x] Start LM Studio polls `/v1/v1/models`. Poll `${endpoint}/models`; test the store wiring with a stub server.
4. [x] Cancellation gaps: `discoverCli` spawns before checking the signal, Claude wrapper child survives, LM Studio drops the signal, Apple helper not abortable.
5. [x] Azure secret read blocks the whole scan; move into Azure's bounded check.
6. [x] HTTP failures look like install results; separate refused from timeout, parse and protocol failures.
7. [x] Retry and Start bypass the scan generation and in-flight guard; Start failure should not run a full scan.
8. [x] A failed Start of the secondary runtime is invisible.
9. [x] Manual scan with an enabled reference still says "Nothing leaves this device".
10. [x] Say that a started runtime keeps running after quit.
11. [x] Copilot row shows a command that no longer runs; show what actually runs per row.

## PR #175 Muse Wonder Full round 2 (head 324eff4, run on Node 26)

Blocking
A. [x] `listProviders` has no first-run gate (setActiveModel, list-providers IPC, testProvider, send preview).
B. [x] A shared in-flight scan drops the second caller's progress and scan id.

Should fix
C. [x] Pending app state reports unchecked providers as available; show not checked and a loading surface.
D. [x] switchLocal sets provider and model in two calls; one host call with rollback.
E. [x] Exit actions stay enabled while an action is busy.
F. [x] Clear start and action errors on a new run.
G. [x] Inner HTTP timeouts, Azure and Apple failures map to negative results; pass the remaining budget; Apple SIGKILL escalation.
H. [x] Code-authoring detection needs a leading write or draft; widen request prefixes and verbs.
I. [x] Voice-hosted boundary passes no provider id or noTenant flag.
J. [x] Subtitle and ledger overstate what ran; state per row what ran.
K. [x] Cap concurrent Ollama `/api/show` calls.
L. [x] Focus management on open, settle, retry and close.
M. [x] The global key handler settles on Enter and Space from buttons.
N. [x] Continue to Chat before settle.

Nits
O. [x] Windows Start: `.cmd`, `windowsHide`, missing `lms`.
P. [x] No-tenant multi-service card after a partial connect; card with a removed tenant.
Q. [x] Remember label and consent payload should name the model; host verifies it.
R. [x] Hosted with-tenant strip, boundary and confirmBody name the region.
S. [x] The sample data link misses its suffix.
T. [x] Tests: host Retry and concurrency, Codex and Copilot or Gemini hang-kill, tool-loop no-consent, empty `/models` integration.

### Round 2 responses

Review items (one commit each where practical, each with a regression test):
- 1: `a03b21ca`. `noTenantRoute` is shared by preview and send; `gateHostedLlm` refuses every hosted model call until the confirmation is verified, on both send paths.
- 2: `8f7b49c2`. While the first-run scan is pending, background discovery (Office tick, menu bar, schedulers) serves scan results or `not-checked`; startup tested from a fresh store.
- 3, 7, 8, 10, 11: `c3887561`, `f29fcb4c`. Ready check polls `${endpoint}/models`; Retry and Start go through the single-flight queue and carry a generation; a failed Start returns its message without a scan and shows on its own row; the Start note says the runtime keeps running after quit; each row states what ran.
- 4, 5, 6: `fb99c078`. Signals checked before every spawn, process-group kill for CLI wrappers, LM Studio and Apple helper stoppable, Azure settings read inside its bounded check, refused separated from timeout, parse and protocol failures.
- 9: `c3887561`. A scan with an enabled reference names the reference hosts instead of "Nothing leaves this device".

Muse round 2 items:
- A to G, J to N, S, T: `8f7b49c2`, `c3887561`, `f29fcb4c`, `fb99c078`.
- H: `51b1139d`. Request prefixes (can you, please, I need, help me) and verbs (write, draft, generate, create, build, make, give me, show me, produce) count as a code request.
- I: `685c70a7`. The voice boundary passes the OpenAI provider id and the no-tenant flag.
- O: `c43b9a0f`. Start spawns through the shared CLI launcher (`windowsHide`, `.exe` before `.cmd`, a refused batch launcher returns its reason); LM Studio installed without `lms` gets its own message.
- P: `f4ee27e0`. A no-tenant card follows the tenant a partial connect added and offers Add per missing service; a card whose tenant was removed offers Connect.
- Q: `1fba983b`. The consent payload carries the model; the host refuses a no-tenant confirmation for another model, and a tenant confirmation that names another model; the no-tenant remember label names provider and model.
- R: `1a56406c`. Hosted with-tenant strip, boundary and confirmation name the documented data location, or "region not stated".

## PR #175 CI on Linux (head 259d36d, run 42589502276, Node 22)

1. [x] `model-scan-cancel.test.ts` "only a refused connection as not running" got could not check on Linux. Reproduced in a `node:22` Linux container: the earlier timed-out checks left keep-alive sockets in fetch's pool, and after the server stopped the next check reused one and failed with `UND_ERR_SOCKET` ("other side closed") instead of `ECONNREFUSED`. That is an app bug on real machines too (Ollama or LM Studio stopped between two checks reads as could not check). `fetchLocal` retries once on a new connection after `UND_ERR_SOCKET`, which is then refused; used by the Ollama tags check and the LM Studio probe. `isConnectionRefused` also reads an AggregateError without a top-level code (`localhost` refused on IPv6 and IPv4) and counts it only when every address was refused. Tests: the real-socket sequence, plus injected refused, stale-then-refused and failed shapes, so the result does not depend on the host.
2. [x] `model-scan.test.ts` "runs no provider detection outside the scan" asserted every catalog provider connected after the scan; off macOS Apple Intelligence is not checked and stays not checked. The test pins the local endpoints to loopback and asserts per provider: connected when the scan checked it, not checked otherwise, and no detection outside the scan.

## PR #175 review round 3 (GPT-6.1-Sol, head 259d36d, 2026-11-09)

Blocking
1. [x] Leaving the scan restarts unrestricted discovery: `completeFirstRunScan` clears the gate and `getAppState` runs full provider discovery on every exit (Continue, Preview, Open chat). Keep serving the scan results after the first run; detect a provider only when the admin acts on it (select, test, refresh in Settings). Tests for every exit path.

Should fix
2. [x] Gemini and Copilot wrapper children survive cancellation: discovery spawns without its own process group. New process group on POSIX, tree kill on Windows; test with wrappers that start children.
3. [x] Start can return a scan from before the runtime was ready by joining an in-flight scan. Queue a fresh scan after readiness; test Start overlapping a scan.
4. [x] HTTP Retry stops at about 2.3 s: Ollama and LM Studio always get the first-scan budget. Pass the current check's budget; test a 3 s response on Retry.
5. [x] Apple helper failures show as "Not available": handle `checkFailed` before provider-specific negatives; end-to-end test.
6. [x] The scan can name a model Chat does not use (Ollama with Qwen chosen and OpenAdmin 8B installed). Resolve the saved model; prefer OpenAdmin 8B only when none was chosen; multi-model test.
7. [x] The LM Studio launcher test failed once under load; make it deterministic.

### Muse Wonder Full round 3 (head 259d36d, Node 22, no blocking findings)

Confirms GPT 3, 4 and 5, with additions: run the whole of Start inside the exclusive queue so two windows cannot spawn the same runtime twice (3); an Azure check that fails (invalid saved endpoint, status `error`) is could not check with its detail and Retry, not "Not configured" (5).

M1. [x] Gemini `testProvider` bypasses the pending scan gate and sends the smoke prompt. Refuse `testProvider` while the scan is pending; require a real ready status for every provider before a test prompt; pending startup test with a CLI spawn spy.
M2. [x] Pre-settle exit actions ignore busy: disable Continue and the scan error actions while busy; a finishing flag in `finish`, `preview`, `useHosted` and `switchLocal`.
M3. [x] The closing ledger lists a refused off-device endpoint as something that ran. Exclude it or label it not contacted.
M4. [x] SPEC says "A click, Skip or any key settles at once"; it is Escape, Skip or a click.

### Round 3 responses

- 1: `a1e9987d`. After `completeFirstRunScan` listing keeps serving the scan results for the session; `setActiveProvider`, `testProvider` and saving Azure settings check that one provider in full; Refresh providers in Settings (new `refreshProviders` IPC) checks all again. Test: every exit (Continue, Open chat with a local model, Preview, Office tick, model choice) runs no provider factory call; testing or selecting checks only that provider; refresh checks all.
- M1: `6db17ea1`. `testProvider` returns a designed refusal while the scan is pending, and needs a ready status (connected; Azure available; an installed Gemini, also after a failed request, because a request is how its sign-in is confirmed). The pending startup test has a Gemini CLI spawn spy and an LLM factory spy.
- 2: `151bc56f`. Provider CLIs spawn in their own process group on macOS and Linux; `terminateCli` sends SIGTERM to the group, then SIGKILL after 500 ms; Windows uses `taskkill /T /F`, shared with the Claude and Codex kill path. Tests: Gemini and Copilot wrappers that start a child and wait, and a stopped Gemini request.
- 3 and 7: `9b1d45ae`. All of Start runs in the scan queue, skips the spawn when the runtime already answers, and returns a fresh scan. Test: Start overlapping a slow scan returns a scan with LM Studio ready, and two Starts launch once. The launcher test's stub answers only after `lms` ran, so "started" means launched (no timing on the log write).
- 4: `4cf80ee2`. A check's budget reaches the Ollama tags and capability requests and the LM Studio probe. Test: an Ollama answering after 3 seconds is could not check in the scan and found on Retry.
- 5: `7e05f23c`. `checkFailed` is handled before any provider-specific negative; an Azure endpoint that is not a URL and an unreadable Azure config are failed checks. Tests: every provider, Azure invalid URL, and a failing Apple helper end to end through the scan on macOS.
- 6: `5fb4ea5c`. The outcome resolves the saved model for the provider; OpenAdmin 8B only when no model was chosen and the scan sets it. Tests: saved model, chosen provider without a model, nothing chosen, removed saved model, and the store outcome against Chat's model.
- M2: `2cc605f9`. Continue and the scan error actions are disabled while busy; a finishing guard in `finish`, `preview`, `useHosted`, `switchLocal` and Start.
- M3: `1d0bc8d3`. Probes carry `notContacted`; the closing line lists only what ran and names refused endpoints as not contacted.
- M4: SPEC says Escape, Skip or a click.


## PR #175 review round 4 (GPT-6.1-Sol, head feafb9a, 2026-11-09)

Blocking
1. [x] Manual rescans restart unrestricted discovery: only a completed first run enters the scan-results mode, so Scan again after a restart is followed by full discovery (off-device endpoints, Copilot's network probe). Every scan enters it; completed-profile regression test.

Should fix
2. [x] Gemini's successful Test leaves activation disabled: the cached summary is not refreshed after the request. Refresh it after success and failure; tests for both.
3. [x] "Show all providers" exits during Start, and `finish` allows navigation while Start polls. Disable every exit during active operations; extend the busy-exit test.
4. [x] First-run screenshot capture waits for text the screen never renders ("What this device can answer with"). Wait for the settled scan and its controls, remove the unused constant, run the capture once.

### Muse Wonder Full round 4 (head feafb9a, Node 22, no blocking findings)

Its four should-fix items are GPT's round 4 items 1 to 4. Additions:

A. [x] The busy-exit fix also covers the row Retry button and the set-up buttons; every exit and action is disabled while an action or a Retry runs.
B. [x] Windows tree kill cannot reach a child whose wrapper already exited (`taskkill /T` cannot resolve a dead pid). Narrow the `terminateCli` comment and SPEC to what Windows guarantees, or use a Job Object.

### Round 4 responses

- 1: `192c6558`. Every scan and Retry enters the scan-results mode, not only a completed first run. Tests in a completed profile: after Scan again, app state, listing and the Office tick run no provider factory call until Refresh providers; off-device Ollama and LM Studio endpoints the scan named not contacted are never fetched afterwards.
- 2: `c7837970`. After a Gemini Test, while listing serves cached results, Gemini is checked again. Tests with a Gemini CLI spy: a successful Test shows connected; a failed one shows error, signed out.
- 3: `8f13e630`. Show all providers and the other set-up buttons are disabled while busy, and `finish` refuses while an action runs. The busy-exit test covers Show all providers.
- 4: `40614d82`. The capture waits for the settled phase and the two exits by their labels; `titleDone` removed; the capture script pins the device scale to 1 so a Retina Mac also produces 1280x800; the capture fixture's Ollama is stopped (not "running, no text model" with a "not running" detail). `npm run screenshots:first-run` passed: 18 screenshots. Renderer test pins what the capture waits for.
- A: `23ae4d6e`. One scan action at a time: exits, Start, the switches and the row Retry wait for any action or Retry in progress. Tests: during a Retry, the exits, Use Claude Code and Start are disabled; during a Start, Retry is. The round 2 ordering test now runs Retries one after another and still checks that an older numbered result is ignored.
- B: `309b8bfd`. Comment and SPEC state that on Windows `taskkill /T` ends the tree while the wrapper runs and does not reach a child left by a wrapper that already exited; a Job Object would close that. No behaviour change, so no new test.

- CI on e94b9cc failed once in `run-confirmation.test.ts` (not changed in this PR): the rollback-run test saw the run fail, removed its folder, and the run's last state write then hit ENOENT after the test ended. The fixture now waits for the store's write queue to settle before removing the folder.

## PR #175 review round 5 (GPT-6.1-Sol, head 3b2af39, 2026-11-09)

Blocking
1. [x] Manual scans allow unrestricted discovery while they run: the scan-results mode starts only after the probes finish, so an overlapping app state read during Scan again in a completed profile fetched an off-device endpoint. Enter it when a Scan, Retry or Start is requested; test background reads during a delayed manual scan.

Should fix
2. [x] The renderer scan fixture can drop completion: `finish()` does nothing before the scan effect installs its callback. Await `startModelScan` before finishing; a premature finish fails loudly.

Nit
3. [x] Public docs describe superseded behaviour: first-run says any key skips (Escape does), connect-shared-app says nothing is preselected (Chat's not-connected card preselects the service and part). Fix both, regenerate `web/content/docs`, `docs:check` clean.
4. [x] A Claude cancellation host test failed once in a combined run; make it deterministic if reproducible.

### Muse Wonder Full round 5 (head 3b2af39, no blocking or should-fix findings)

A. [x] With no tenant, `getGraphCacheStatus()` without an id rejects through IPC and logs "Error occurred in handler" on every no-tenant conversation reload. Without an id and without an active tenant, return an empty status; an explicit unknown id still throws.
B. [x] A scan check that times out can be missing from the served listing (its aborted summary lands after the copy), so Settings shows not checked while the scan row said Could not check. On timeout, record a failed-check summary for that provider.

### Round 5 responses

- 1: `6f0162cd`. `scanModels`, `retryModelScanProbe` and `startLocalRuntime` enter the scan-results mode when asked for, before any probe runs. Test: in a completed profile, Scan again is held on a slow LM Studio while app state, listing and the Office tick run; the off-device Ollama endpoint is never fetched (fails without the fix).
- 2: `c0ca5bb3`. The fixture's `finish()` waits for the window to call `startModelScan` and throws when it never does; every call site awaits it. Test: a premature finish rejects.
- 3: `9dba38f4`. First run says Escape, Skip or a click; connect-shared-app says Chat's not-connected card preselects the service and part. `web/content/docs` regenerated, `docs:check` clean.
- 4: `b853d29b`. The wrapper-kill tests wait for the wrapper's child, then stop the check through its signal (the path the timeout uses) instead of racing a 1.5 s timeout against a loaded machine; `gone` waits up to 5 s for the system to reap. The timeout itself is still covered by a separate `runScanCheck` case.
- A: `77e8a25b`. `getGraphCacheStatus()` without an id and without an active tenant returns an empty status; an explicit unknown id still throws. Test in the no-tenant harness.
- B: `c260f99c`. After a scan or Retry, a check that ended could not check without a summary (timed out, refused off-device endpoint) is served as a failed check with its row's reason. Test: a check that never answers is listed with `checkFailed` and the row's fact, not "not checked".


## PR #175 design and enterprise round (maintainer decision, 2026-11-09)

Inputs: design spec and mockup 32 (revision 2) in the maintainer's scratchpad (`design-spec.md`, `32-connections-first-run.html`, `after/sec-*-0[0-4].png`, `-11.png`). The mockup is committed by PR #174, not here. PR #174 merges first; after it lands, merge main and adopt `DeviceTile`, the motion tokens, the organization vocabulary, `providerDataLocation` and the audit events (step 4 below, on the maintainer's signal).

Design plan (fixed by the brief, not reinvented): production tokens only; one memorable element, the orbit; one filled button per view and it is the next step; green means it stays on this device, amber means it leaves; type on the production scale (12, 13, 14, 16, 24, 34); radii from tokens; motion as one orchestrated 2.4 s sequence that reduced motion skips to its end state.

Acceptance criteria
1. [x] A, scan running: header wordmark 16 serif and "Skip scan" ghost sm; grid 7fr/5fr, gap 48 (32 below 1000), max 1180, right column max 440, both centred; title `text-display`; one-sentence intro; progress text plus 8-segment bar; check list 32 px rows (mark, name, status right), no buttons and no monospace targets, `aria-live` source; nodes 44 px with label plates; node states per spec; settled not-found nodes 32 px without status, muted name, no opacity; device tile accent fill; 2 rings, conic sweep, staggered nodes, about 2.4 s; reduced motion renders the end state; Escape, Skip scan or a click settles.
2. [x] B, scan result: one radio group of found options, local first; the first local option that can answer or be started is preselected; hosted never preselected and always shows where prompts go; only hosted found means nothing preselected and a disabled "Choose a model" button; one primary button whose label follows the choice ("Start Ollama and open Chat", "Use Claude Code", "Open Chat", "Get OpenAdmin 8B" when Ollama has no model, with "No model yet" on the row); note under the button; spinner while starting; a failed start writes its reason under its row in danger; titles per outcome; Continue and Preview as quiet links; "What ran" disclosure and "Scan again"; selection mirrored in the orbit; Retry for a check that could not finish; no page scroll at 1280x800.
3. [x] C, empty Chat: destination stated once under the composer (plus the top bar chip); the "Answering with" line removed; starters as two columns of plain rows with headings, the needs column with a dashed service mark; one column below 600 px.
4. [x] D, hosted send confirmation inline above the composer: title, one sentence, definition list (Goes to in amber, What is sent, Stays here), the remember checkbox naming the model, primary "Send to <provider>", ghost Cancel, link "Use a model on this device"; Enter sends, Escape cancels and returns focus; nothing cut off at 960x720.
5. [x] E, not-connected card: service mark (`data-off`) instead of the shield, title 16/500, permissions in a quieter disclosure, actions in weight order (primary Connect, secondary own registration, ghost Ask an admin), body indented to the title.
6. [x] L, Settings, Providers agrees with the scan: an installed runtime that is not running reads "Installed, not running" in both.
7. [x] The in-Chat model choice uses the scan's choice list component.
8. [x] Enterprise: proxy and offline failures name the host that could not be reached, whether a system proxy applies, and the recovery step, on Microsoft sign-in in the setup dialog, the model download (OpenAdmin 8B setup and the local index model), the scan's Start, and the Marketplace install and check paths. Tests for each path.
9. [x] Region wording: "Anthropic API · US", "OpenAI API · US", "region not stated" for Copilot and Gemini, "your resource's region" for Azure OpenAI, in `providerDataLocation`.
10. [x] Visual check: scan and Chat screens recaptured light and dark at 1280 and 960 (`npm run screenshots:first-run` plus new-state captures), each compared with the mockup.
11. [x] After #174 (on the maintainer's signal): merge main; `DeviceTile` and motion tokens in the scan; organization wording for the active scope ("No organization"); the no-scope hosted acknowledgement bound to "no organization"; one set of provider display names; provider and model changes recorded through #174's audit events; rerun everything.

### Design and enterprise round: results

- 9: `a5eb97d3`. `providerDataLocation`: "Anthropic API · US", "OpenAI API · US", "GitHub Copilot · region not stated", "Google Gemini API · region not stated", "Azure OpenAI · your resource's region". Test pins every value.
- 6 (L): `4fec6624`. `ProviderSummary.installed` from the Ollama and LM Studio checks (local files); Settings shows "Installed, not running" and no install guide; the scan reads the same field. Tests on both sides.
- 1, 2 (A, B): `7d8527b6`. Scan rewritten: one 2.4 s sequence, check list, node states and plates, settled not-found nodes, accent device tile (the `DeviceTile` swap waits for #174), `ModelChoiceList` with `optionsFromProbes`, `preselect`, `actionLabel` and `actionNote` in `src/setup/model-choice.ts`; selection mirrored in the orbit; "What ran" disclosure. 28 scan screen tests and 4 option builder tests.
- 7: `62da8beb` and `bc119112`. Chat's `ModelChoice` renders the same list from `optionsFromProviders`; in Chat the start button reads "Start Ollama".
- 3 (C): `3d5116d9`. Destination stated once under the composer; "Answering with" line removed; starters as two columns of plain rows (one service per column, with a dashed `ServiceMark`); references as a divided list of two.
- 4 (D): `08cb86d5`. Inline `HostedChatConsentPanel` above the composer; focus on "Send to <company>", Escape cancels and returns to the composer. Tests for the no-tenant and tenant variants, the reference hosts, and Escape.
- 5 (E): `a8dfdb75`. Service mark, permissions disclosure, actions in weight order, body indented to the title.
- 8: `e46d08b7`. `electron/network-failure.ts` classifies and words the failure; wired into Microsoft sign-in (`signInFailure`, with `resolveProxy` from Electron's session), the scan's Start (loopback host named), the local index model download (no longer silent; Settings, Privacy shows it) and the Marketplace index and manifest fetches. Tests: classification, each message shape, a store-level sign-in failure, the index model download through a stub Ollama, a Marketplace install and an index refresh.
- 10: captures in the scratchpad `design-final/` (scan at 1280 and 960 in light and dark, Chat empty, hosted confirmation, not-connected card and the no-model choice at 1280x800 and 960x720 in light and dark), compared with mockup frames A to E; the confirmation fits at 960x720. The not-connected card was reached in a live check with Anthropic through Claude Code (`claude-sonnet-5`); the question carried no tenant data. `npm run screenshots:first-run` recapture listed with the hand-back.
- Open: 11 waits for the maintainer's signal after #174 merges.

### Hosted location wording, second decision (maintainer, 2026-11-09)

"Anthropic API · US" and "OpenAI API · US" were wrong: Anthropic API inference defaults to global unless the workspace restricts it to the US, Azure OpenAI depends on the deployment type, OpenAI follows workspace data residency, and a CLI decides its own channel (Claude Code can use Bedrock or Vertex, Codex a custom endpoint).
- [x] `providerDataLocation` keeps the short label ("Claude Code · location set by your account", "Codex · location set by your account", "Azure OpenAI · location set by your deployment type", "GitHub Copilot CLI · location not stated", "Gemini CLI · location not stated" (labels name the tool, corrected by the maintainer)); `providerDataLocationDetail` holds the detail. Same values as PR #174.
- [x] `promptsGoTo`: for a CLI "Prompts leave this device through Claude Code; location set by your account", for an API "Prompts go to <label>". Used by the scan rows, Chat's choice list, the composer line and the boundary.
- [x] Detail in the status strip and composer tooltips, the hosted send confirmation (under Goes to) and the scan's What ran. The confirmation names a CLI as the tool ("Send this question through Claude Code?", "Send through Claude Code"). Nova voice says its audio goes to OpenAI and that processing follows the workspace's data residency.
- [x] Tests, SPEC and the first-run docs updated; scan and Chat recaptured.

### Provider logos (maintainer request, 2026-11-09)

- [x] Guidelines checked: LM Studio brand page permits referring to LM Studio with its marks; GitHub permits a GitHub logo to show an integration (its official logo archive includes the Copilot icon in black and white); Ollama publishes none (Simple Icons CC0 path, monochrome as Ollama's own mark). Anthropic and OpenAI require prior permission, Google requires an approved request, Azure icons are for diagrams, training and documentation only, and Apple does not allow its logo: those keep a neutral mark.
- [x] `apps/desktop/src/assets/provider-logos/` with the SVG files and `NOTICE.md` (owner, source URL, retrieval date, terms followed, and why the others are neutral); a line in the README License section.
- [x] `ProviderLogo` (provider id, size, optional label): two variants switched on `data-mode`, `aria-hidden` next to a visible name, `role="img"` with the provider name when shown alone. Used in the scan orbit and choice list (scan and Chat) and Settings, Providers. No new dependency.
- [x] Orbit: a node is a surface circle with the mark inside; ready on this device is a soft green fill with a full ring so a logo stays on a quiet surface; a not-found node fades through ring, surface and name, never by dimming a logo.
- [x] Tests for the mapping, the variants, the accessible label and the Apple neutral case. Scan (running and settled) and Chat's model choice recaptured at 1280x800 light and 960 px dark.
- [x] Step 4: after main is merged, `ProviderLogo` on #174's provider marks (the Connections reach map row and the organization surfaces that show a provider).

### Real logos for every provider and service (maintainer decision, 2026-11-09)

- [x] Official files fetched unmodified: Claude spark (Anthropic press kit), OpenAI Blossom black and white (openai.com/brand), Gemini colour PNG (Google Workspace logo archive; Google publishes no SVG), Azure OpenAI, Intune and Defender for Cloud (Azure Architecture Icons V25), Entra ID colour (Entra architecture icons), Apple Intelligence (developer.apple.com icon; Apple offers no separate download). Microsoft has no Defender XDR icon in its downloads, so Defender shows Defender for Cloud.
- [x] `ProviderLogo` shows a logo for every `ProviderId`, a neutral mark only for an unknown provider; an optical `scale` for files with built-in clear space. `ServiceMark` and `ServiceLogo` show the Microsoft icons on the not-connected card, Chat starters and the Microsoft 365 step.
- [x] Disclaimer in Settings, About, the README License section and both NOTICE files (`provider-logos/`, `service-logos/`), which list owner, source URL and retrieval date and how to request removal.
- [x] Tests: every provider and service resolves to its logo, light and dark variants or one file on both, accessible labels.
- [x] Step 4: the same logos on #174's provider and service marks (reach map, service rows, switcher, Agents chips, run review).


## Remove pilot mode and sample data (maintainer decision, 2026-11-09; step 4, done after #174 merged)

Supersedes the 2026-11-01 pilot decision and the 2026-11-08 block where they keep sample data. Done in this PR now: every entry point is gone (the scan, Chat's model choice, Settings, Tenants and the tenant menu); `startPilot` in `SetupFlowContext` and `PILOT_COPY` have no callers left. The rest waits for #174, which adds sample-organization code.

Plan (after merging main):
1. [x] Inventory on the merged tree: `git grep -il "pilot\|sample-tenant\|SAMPLE_TENANT\|kind === \"sample\""` across `apps/desktop/src`, `apps/desktop/electron`, `packages`, `scripts`, `docs/gitbook`, plus #174's sample-organization code. Today's list: `electron/sample-tenant/` (dataset, Graph backend, answers, pilot answers, pilot LLM), `electron/intune-chat/pilot-chat.ts`, the pilot branches in `state.ts` (`addSampleTenant`, sample checks), `service.ts`, `planner.ts`, `runs.ts`, `run-delivery*.ts`, drift (`rollback.ts`, `tracked-resources.ts`), `main.ts` and `preload.cts` (IPC), `src/components/PilotMode.tsx`, `src/pages/PilotAgentsHome.tsx`, `src/shared/pilot-mode.ts`, the pilot branches in `App.tsx`, `AppShell.tsx`, `Sidebar.tsx`, `TenantSwitcher.tsx`, `ServiceAccess.tsx`, `SchedulesPausedNotice.tsx`, `AgentHubList.tsx`, `IntuneChat.tsx`, `Agents*.tsx`, `AgentDetail.tsx`, `Marketplace.tsx`, `RunResult.tsx`, `Runs.tsx`, `Schedules.tsx`, `Settings.tsx`, `SetupFlowContext.tsx` (`startPilot`), `TenantSetupDialog.tsx` (`pilotRemoved`), copy in `copy/setup.ts` and `copy/trust.ts`, and about 40 test files.
2. [x] Remove the sample tenant and its fake Graph backend, the pilot agents and prepared prompts, the pilot banners and routes, the `kind: "sample"` tenant type and every branch on it, and #174's sample-organization equivalents. Keep the agent SDK types stable or version them.
3. [x] One-time upgrade step in `AppStateStore` on load: when a persisted tenant has `kind: "sample"`, remove it with its runs, conversations, workspaces, drift records and Graph cache rows (SQLite), clear it as the active tenant, write once, and show a one-line notice: "Sample data was removed. OpenAdminOS works with your own Microsoft 365 organization." Idempotent; tested from a state file that has a sample tenant, runs, conversations and cache rows.
4. [x] Capture script: remove the pilot screenshots (`pilot-chat`, `pilot-agents`, `pilot-agent-report`, `pilot-write-confirm`, `pilot-hidden-route`) and their steps from `electron/first-run-capture.ts` and `scripts/capture-first-run-screenshots.mjs`; add the Microsoft 365 step frames.
5. [x] Docs: remove the pilot pages and mentions (`docs/gitbook`, `web/content/docs` via `npm run docs:generate`), SPEC (pilot mode sections marked superseded), README, the marketing site sections that mention sample data, and the CHANGELOG line.
6. [x] Tests: delete pilot tests, keep coverage for the upgrade step, run the full suites under Node 22, and check `npm run screenshots:first-run`.

Done (step 4, 2026-11-09):
- [x] Merged `origin/organizations/connections` (PR #174), then `origin/main` after it merged. Conflicts resolved so both PRs work: one `ServiceMark` on #174's API with Microsoft's icons, #174's data boundary and composer sentence with this branch's no-organization variants and location detail, the inline hosted confirmation with the model, tenant leases and the model choke point for sends with a tenant (`leasedScope`, none for a send with no organization), Settings without tenants, mockup 32 revision 2 plus section B2.
- [x] `DeviceTile` and motion tokens in the scan and Connect Microsoft 365; organization wording across Chat, the not-connected card, trust copy and the hosted confirmation; provider and model changes from the scan and Chat's model choice audited through #174's state-diff audit (test); Connect Microsoft 365 reopens from Connections.
- [x] Real logos on #174's surfaces: reach map and connection rows (`ProviderMark`), service rows, organization switcher, need chips, run review (tests).
- [x] Pilot mode removed: SDK `kind: "sample"`, `RunRecord.pilot`, `addSampleTenant` and "pilot-active"; `electron/sample-tenant/`, `pilot-chat.ts`, `PilotMode.tsx`, `PilotAgentsHome.tsx`, `shared/pilot-mode.ts`; every branch on them in runs, deliveries, audit, state, Chat, Agents, Connections, switcher, sidebar, run pages and reports; pilot copy; pilot docs; capture shots and the paused-schedules shot that only existed for pilot; pilot-only tests (bundled agents on the sample graph included, since the fake Graph is gone; the qa-graph gate still checks agents).
- [x] One-time upgrade `removeLegacySampleData` at launch with the notice "Sample data was removed. OpenAdminOS works with your own Microsoft 365 organization." (tests: removal of runs, conversations and organization, no sign-in removal, notice once, idempotent, id-only detection, no-op without pilot).


## PR #175 onboarding round review (GPT-6.1-Sol at 6865d05)

- [x] 1 (blocking): reopening Connect Microsoft 365 with a tenant keeps its identity. The picked services' missing parts go through the existing Add access dialog (now able to take several services): `addTenantAccess(tenantId, missing parts)` for the shared app, the extend script and Check again for an own registration; no new connect flow, no baseline sign-in scopes, no "Use our own app registration". Ask an admin to approve builds consent for that tenant (`/<tenantId>/v2.0/adminconsent`) and that client ID. Tests assert the parts, scopes, client ID and tenant for Add access, Copy script, Check again and Ask an admin, for the shared app and an own registration.
- [x] 2: partly connected is not connected. The step distinguishes `serviceStatus` connected from partial; a partial service reads "Partly connected", stays selectable, and asks only for its missing parts. Test: reopening after an Intune-only connect completes Entra with exactly the parts not granted through Intune.
- [x] 3: Chat's model choice uses `isProviderReady`. A running Ollama without a model offers Get OpenAdmin 8B; a running LM Studio without a loaded model offers the scan's load-model recovery, whose Scan again checks providers again in place. Unit and Chat tests.
- [x] 4: Get OpenAdmin 8B and all providers keep Connect Microsoft 365 pending (`firstRunMicrosoftStep: "pending"`, IPC `complete-first-run-microsoft-step`). The step shows once the active model is ready and the admin is outside Settings, in that session or on a later launch, and clears when left or when a tenant is connected another way. Store test across a restart; gate tests for the detour, the return, a later launch and no ready model. Quitting during the step stays as the SPEC says; the step remains reachable from Settings, Tenants (Connections after step 4).
- [x] 5: the hosted send confirmation shows the model in both variants and the tenant-bound remember line names it. Tests assert both.

## PR #174 review round 1 (Claude evaluator, GPT-6.1-Sol and Muse Wonder Full, 2026-11-09)

Reviewed head 96eece9. Each fix is its own commit with a regression test.

Blocking:

1. [x] Scheduled batches could run in another organization. Run due now and Run all scheduled start scheduled runs, and the host checks inside the run lock that a scheduled start's schedule belongs to the active organization. Every renderer `start-run` call may only pin the active tenant, including Run for real and Team retries that take the original run's tenant; multi-tenant batches and Agent Team keep pinning their own tenants inside the host. (219e3bf)
2. [x] Editing an unassigned schedule activated it. Ownership is decided only when a schedule is created; edits keep it, including unassigned; only Assign assigns. (8817ddc)
3. [x] An explicit tenant bypassed the scheduled-start check. The check now compares the schedule's organization and any pinned tenant with the active organization and tenant. (219e3bf, same lock and check as 1)
4. [x] No-organization runs were labeled with another organization. Delivery resolves the report context only from the run's own tenant and labels its absence No organization; tests cover Slack, WhatsApp under the sample organization, and the Teams and Outlook skip. (793739a)

Should fix:

5. [x] Run again bypassed the preflight. Ordinary reruns and Re-run against the current tenant open the agent's preflight with the original provider and model; Run for real and Team retries keep their flows. Tests for a tenant-bound and a tenant-less run. (1f6286d)
6. [x] The service-free preflight said the run cannot reach any service. It now says no service data is read and lists the report destinations that apply to a manual run, naming Teams and Outlook as skipped without an organization. (639eb1c)
7. [x] The hosted warning used tenant wording with no organization. It now says prompts and agent context go to the provider and no tenant data is included. (999bbb5)
8. [x] Menu bar Run due reported other organizations' and unassigned schedules as errors. They are skipped and counted as waiting. (3b54f93)
9. [x] `Schedules.tsx` was unrouted. Deleted; its tests that describe live behavior run against the Agents schedules list. (28a962a)

Test gaps:

10. [x] Tests prove Changes, the Data and Chat settings cache refresh, and scheduled batches refuse without an organization; Changes and the cache say No organization is active. (dc42286)
11. [x] The status strip parity test covers the provider, model and services as well as reference hosts. (ee5d860)

Muse Wonder Full:

- A. [x] Regression from the first fix: a pilot scheduled start said unassigned. The pilot refusal comes first again; `pilot-mode-state.test.ts` covers it. (9cbdc84)
- B. [x] Reach map destinations disagreed with Results. One list joins enabled delivery rules and declared connector steps with the connector list Results loads; the map names what is set up, Results says the same and names rules to connectors that are not set up; reference hosts are deduplicated for the map and the strip. Tests on both sides. (d337ef1) The status strip itself names Chat egress (provider and reference hosts) and does not list run report connectors; that is unchanged.
- C. [x] The menu bar listed other organizations' schedules. Only the active organization's schedules are listed and counted as due (3b54f93), with the list moved into a tested module (1c46ad2).
- D. [x] Hosted wording said local CLI for API providers. The review and the map name the channel per provider: the vendor CLI for Claude Code, Codex, Copilot and Gemini, the Azure OpenAI API for Azure. (e849512)
- E. [x] Accessibility: need chips are visually hidden text in the row's accessible name (05c9f7a); the organization switcher focuses the active organization on open, supports arrow keys, Home and End, returns focus to the chip on Escape, Tab and choice, and its row actions are visible menu items (fdefc02).
- F. [x] Region wording is now "Region not reported to OpenAdminOS"; the `TODO(ugur)` stays. (b1587d7)
- G. [x] Unknown connection keys and organizations with only such connections survive reconcile; this version does not switch to them or assign schedules to them. (b58fe1c)
- H. [x] Names are cut by code points; a new name over 80 characters is refused instead of cut; IPC and field limits match. (95ad600)
- I. [x] Settings search finds tenant and connector topics and opens Connections. (39cbf64)
- J. [x] No organization uses an empty dashed tile instead of a question mark. (6386e35)

Verification after round 1 (Node 22): typecheck clean; electron 1026 pass, 0 fail; runtime 256 pass; scripts 18 pass; renderer 539 pass in 61 files; `npm run qa` 197 pass, 4 warn, 0 fail; `npm run docs:check` clean. Live on Anthropic through the Claude Code CLI, `claude-sonnet-5`: the real `start-run` IPC refused a start pinned to the inactive organization's tenant and a scheduled start in another organization; the reach map names "Anthropic, through the Claude Code CLI" with "Region not reported to OpenAdminOS". Screenshots refreshed in `docs/screenshots/organizations/`.

## PR #174 review round 2 (GPT-6.1-Sol and Claude evaluator, 2026-11-09)

Reviewed head 8519540; round 1 fixes confirmed. Each fix is its own commit with a regression test.

1. [x] Blocking: Agent Team persona schedules failed and disabled their personas. Persona recurrence starts with trigger schedule and the installed-agent schedule checks treated it as unassigned, or refused the persona's tenant while another organization was active. The organization and pinned-tenant checks now apply only to installed-agent schedules; persona runs are host-owned (the renderer cannot pass `office`) and keep their validated tenant binding. Integration tests drive `OfficeService.tick()` through the real `RunService` with the persona's tenant active and with another organization active; both failed before the fix. Whether personas move to organizations stays open for the maintainer. (662310b)
2. [x] Assign stayed disabled after the first organization was connected with the card open. The selection keeps a choice that is still offered and otherwise takes the first; the test connects an organization while the card stays mounted. (9f8aba2)
3. [x] The strip parity test compared with hard-coded values. The strip's boundary is now the pure `deriveDataBoundary`, used by the strip and by the reach model, and the test feeds the same states to both. (7e35952)
4. [x] The menu bar waiting count had no test. Run due is now built in `companion-schedules.ts`, with tests for waiting schedules of another organization, unassigned ones, and no organization. (a5fd0f4)
5. [x] Run again for a run whose organization is not active hit the host refusal as a raw error. A dialog names the run's organization and offers Switch to it, and for ordinary reruns Run in the active organization through the run review; a removed organization is named as removed. Agent Team reviews keep their own route. (4c12788)

### Muse Wonder Full round 2 (reviewed 8519540)

Already fixed by the round 2 commits above, confirmed: the Agent Team persona schedule blocker (662310b, integration tests through `OfficeService.tick()` and the real `RunService`), the shared strip derivation (7e35952, `deriveDataBoundary`), and the Assign selection (9f8aba2).

1. [x] An organization switch during a scheduler tick consumed the due slot. Organization refusals throw `OrganizationBoundaryError`; the scheduler counts them as waiting, records no failure and keeps `lastScheduledRunAt`. The test switches organization mid-tick through the real start. (586612ef)
2. [x] Hosted reach copy said tenant data leaves with no organization. The heading becomes "Prompts and agent context" and the text alternative says no tenant data is included. (4c269144)
3. [x] The no-organization preflight could promise delivery to a connector that is not set up. `manualRunReportDestinations` takes the connector list; the review lists only set-up connectors and names the rest as not sending. (fe580288)
4. [x] The second tenant check after a Run for real rewrite now also covers installed-agent scheduled starts, and a pilot Run for real is refused unless its dry run was on the pilot tenant. (6da32312)
5. [x] A losing duplicate record's vendor connections move to the winning organization and survive the next write. (ecf1f4be)
6. [x] The preflight names the organization of the run's tenant; when that organization is not active it says so and keeps Start disabled. (5af05ee8)
7. [x] The reach map shows report destinations as being checked until the connector list resolves, and as not checkable when it fails, instead of saying nowhere. (7fea7d26)
8. [x] Arrow keys from outside the switcher list go to the first or last item, and a running check's Cancel is a menu item. (b0ed8019)
9. [x] Menu bar Run due counts only due schedules of other organizations as waiting. (28f3850d)
10. [x] Workspace run pickers list only the workspace tenant's runs, and the host refuses to link a run with no organization. (25acd403)
11. [x] Pilot need chips use the pilot tenant, so pilot agents' services show as connected. (47b97f09)
12. [x] Reports of a run with no organization say "Organization: none", and the direct Teams and Outlook paths use the designed skip instead of a failed step. (0f0e7cbf)

CI on this branch failed the generated docs check on every push since 96eece9: git's automatic short-hash length grew to eight characters in fresh clones. Part A's fix `docs: pin generated short hashes to eight characters` is cherry-picked here so the check passes; it merges cleanly once part A lands. Earlier hand-backs reported CI as pending, not failing.

The CI job then failed in the Intune Chat smoke: it, and the Agent Team presentation checks, still looked for the old Switch tenant button and top bar label. Fixed in the commit after the cherry-pick; the Intune Chat, Office and Support issue smokes pass locally.

## PR #174 review round 3 (GPT-6.1-Sol, 2026-11-09)

Reviewed head 9c244c6; round 2 fixes verified. The earlier CI smoke timeout was traced to the existing send-completion race; the smoke passed on rerun.

1. [x] Blocking: Apply bypassed the active organization. `confirmRun` takes the same boundary as starts, and the `confirm-run` IPC handler always sets it, so every renderer approval is checked inside the confirmation lock: the plan's tenant must be the active tenant. That one path covers agent write plans, baseline rollbacks, external gateway proposals and Agent Team approvals; dry run then Run for real was already held to the active organization in round 1. A refused plan is kept unchanged and never retargeted. The confirmation page names the plan's organization, keeps Apply disabled and offers Switch back; a refusal from a race shows the host's designed message. Host tests cover all four approval kinds with No organization and with another organization active; renderer tests cover both states and the race. (44fc909e)
2. [x] Start errors were hidden behind the run review. The review checks the provider on its own, whatever the organization state, and disables Start with Open provider settings when it is not ready; a refused start appears inside the review with Try again and Open provider settings, tested with `within(dialog)` for an agent start and for Run again. (02b2ae78)

### Muse Wonder Full round 3 (reviewed 9c244c6, Node 22)

No blocking findings; round 2 fixes verified. Muse confirms the earlier smoke timeout came from the old "Switch tenant" wording, fixed in 622d3a4d. The CI run on 46b8436 failed only in the Intune Chat smoke at "edit prompt loaded into composer", the known send-completion race; the smoke passes locally.

1. [x] Switch then Run for real from No organization opened setup: the rerun ran from the closure taken before the switch. It now waits for the render where that organization is active. Test starts from No organization with a planned dry run. (f3ecc51c)
2. [x] The run review treated a failed connector load as "nothing set up". A failed load now says the destinations could not be checked. (cc2fa872)
3. [x] Nova runs and sends kept the tenant captured at preview. Execution checks that organization is still active and otherwise refuses with nothing run or sent; Nova starts also carry the active-organization boundary. (664d2749)
4. [x] Copied and exported reports of a run with no organization say "Organization: none". (e599af56)
5. [x] A run without a tenant whose agent now needs a service fails closed with the no-organization message, and write and system applies without a tenant refuse, instead of falling back to the active tenant. (cf01b179)
6. [x] Menu bar Run due counts a mid-batch `OrganizationBoundaryError` as waiting. (03c67c73)
7. [x] Reconcile keeps records with a long or duplicate id under a fresh deterministic id with their vendor connections, keeps unknown connection values that are not records, and the migration notice counts only schedules it moved. (73cb2c7e)
- [x] `registration-script.test.ts` timed out under full-suite load (seen here in round 2 too): its tests start PowerShell several times, so the file allows 60 seconds per test. (commit after 73cb2c7e)
- [x] The Settings search test read its first result before the page finished loading under full-suite load. It now waits for the result. (test commit after the registration fix)

## PR #174 review round 4 (GPT-6.1-Sol and Muse Wonder Full, reviewed 8f7e47c, 2026-11-09)

### GPT-6.1-Sol

1. [x] Blocking: trust copy could promise no delivery while reports still left. The destination list excluded connectors by health status, so a saved Slack token with no global configuration and a channel on the agent rule was listed nowhere while the host posted. `deliveryBlock` in `src/shared/delivery-destinations.ts` is now the one decision: the host calls it before sending (organization skip, missing channel or recipient), and Connections, Results go to and the run review list a connector whenever it returns no block. Only the rule being off, Teams or Outlook without an organization, or no destination at all count as nothing sent; the copy says reports can go there. Tests: token-only Slack with an agent channel (renderer and host), stale error and needs-setup statuses, and a host parity test that runs six fixtures through `processPendingRunDeliveries` and the destination list and asserts a send exactly where the list says one may happen. (4a7eb47d)

### CI smoke regression (maintainer)

2. [x] Blocking: the Electron Intune Chat smoke failed at "edit prompt loaded into composer" on 46b8436 (both attempts) and 8f7e47c. Reproduced on Linux (node:22-bookworm, xvfb-run): 1 of 3 runs failed at that step on 8f7e47c. Cause: a Chat send stays in progress after the answer is shown, until the conversation list reloads, and Edit and resend ignored clicks in that window without any sign. The smoke clicked Edit as soon as the answer appeared. Edit is now disabled until the send settles, like Regenerate, so the click waits; the smoke needed no change. The PR's Chat-adjacent changes (data boundary refactor, Connections wording in Chat) do not change rendering in that flow; the longer Linux reload window makes the race likely. Test holds the reload and asserts Edit is disabled, then loads the prompt once the send settles; it fails without the fix. (5bb40eb9)

### Muse Wonder Full round 4

No blocking findings; round 3 fixes verified.

3. [x] A tenantless pending plan was not refused inside the confirmation lock under No organization: it moved to running and failed in apply. `confirmRun` now refuses a plan without a tenant from every caller before any transition, with `PLAN_NO_ORGANIZATION_COPY`, and the stored run stays unchanged. The confirmation page shows "This plan has no organization" and keeps Apply disabled instead of "Apply will be simulated". Host test for all four plan kinds, with and without the renderer boundary; renderer test. (fbe2c1cc)
4. [x] `NovaActionHost.activeTenantId` is required, so `assertStillActive` always runs. (6f96f58f)
5. [x] The rerun continuation is set in an effect: the run page renders one component per run. A Switch records the pending rerun at once, a failed switch clears it, and closing the page before the switch lands says Run again did not continue. Test closes the page while the switch is pending. (dd5e86b9)
6. [x] Reconcile moves a schedule that named a replaced over-long id to the kept record; duplicate ids are not remapped. (83e4d553)
7. [x] Testing a connector or running an agent from No organization says no organization with Microsoft 365 is active and how to choose or connect one; the run failure recovery matches it. (b6be39be)

## PR #174 review round 5 (GPT-6.1-Sol, 2026-11-09)

Reviewed head a068806; round 4 fixes verified.

1. [x] Blocking: the empty public reference line said nothing leaves the device with a local model until a reference is added, while a saved delivery rule still sends run reports. The line now speaks only about question words sent to reference hosts; a renderer test with a token-only Slack rule checks it. (acb3d6f6)
2. [x] The Connections map ignored hosted Nova voice: the strip showed Voice · OpenAI while the map said prompts go nowhere. The map and its text alternative now list the voice destination from the same boundary state as the strip, with a parity test. (8c9fa904)

### Muse Wonder Full round 5 (reviewed a068806)

Confirms both round 5 findings above. GPT-6.1-Sol round 6 found nothing on 8ee4839.

1. [x] `deliveryBlock` had no destination check for Teams or Outlook's default recipients, so the UI listed Microsoft Teams while the connector refused to post without a team and channel. Teams now needs a team and a channel, on the rule or saved as the default; Outlook on default recipients needs at least one saved recipient (split on commas, semicolons and new lines, like the connector). The Teams and Outlook senders refuse both cases with designed step messages before the tenant session, without retrying. Three Teams and Outlook fixtures join the parity test and check the step message and that nothing is requeued. Discord and declared connector steps stay may send; the SPEC note says why. (b61b2f73)
2. [x] A plan or run stored with `tenantId: ""` is treated as no organization: the confirmation lock refuses it with the no-organization copy, the run and apply paths fail closed, and the confirmation page shows the no-organization notice with Apply disabled. Host and renderer tests. (b7592474)
3. [x] Invoking a connector (Teams team and channel lists) with no organization active uses `NO_MICROSOFT_365_ORGANIZATION("invoking connectors")`. Test. (294bf23a)
4. [x] An over-long id shared by several records is not remapped: both records are kept under fresh ids and a schedule naming it is left unassigned, as the comment says. Test. (68980fd8)

## PR #174 review round 7 (GPT-6.1-Sol, 2026-11-09)

Reviewed head 06949c7; the Muse round 5 fixes were verified.

1. [x] Blocking: saving the first Teams default team and channel did not refresh the connector list the map and Results read, so both still said nothing is sent to Teams while the host could post there. The picker now reloads the connector list after a successful save; a renderer test saves a default and checks both disclosures (fails without the fix).

## PR #174 design and enterprise round (2026-11-09)

Maintainer decisions: design spec and mockup 32 revision 2 (`docs/mockups/32-connections-first-run.html`, `docs/mockups/32-connections-first-run-spec.md`, frames F to K), enterprise items from the Muse review, region wording, Muse round 6 nits. This PR merges before #175 and carries the shared pieces.

### Shared pieces
- [x] `DeviceTile` (104, 72, 40 px) and motion tokens naming existing values. (257f0f0e)
- [x] Not connected is a dashed neutral `ServiceMark`; missing access is never amber. (f1af8193)
- [x] Mockup revision 2 and its spec committed. (cf4a658c)

### Region wording and vocabulary
- [x] `providerDataLocation` in `copy/trust.ts`, with the same signature as PR #175: Anthropic API · US, OpenAI API · US, region not stated (Copilot, Gemini), your resource's region (Azure OpenAI). "Region not reported to OpenAdminOS" and its TODO(ugur) are gone. PR #175 still has "region set by GitHub" and "region set by Google" and should adopt these values. (0f4f07b4)
- [x] Provider names as the scan shows them (Claude Code, Codex, Apple Intelligence, GitHub Copilot CLI, Gemini CLI); the strip, Chat composer, Chat confirmation and Settings name the location instead of "Hosted via CLI". (2643d7f2)
- [x] Glossary in SPEC: organization, connection, service, part, tenant, No organization, public reference, result connector, provider, data location. (ff233ec6)

### Design must items, frames F to K
- [x] F: reach map around `DeviceTile lg` with computed lines (incoming solid, outgoing dashed, amber only for hosted prompts), stacked below 760 px, service rows on one grid with "4 of 6 parts", Manage menu (Permissions, Rename, Disconnect), planned connectors removed, Organizations tab for all organizations and saved registrations. (cd9a6094, 02fcdd0d, bddc2780, 4744b2a2, c0ca8dfc, e1760195)
- [x] G: empty state with Connect Microsoft 365 above the fold, then what leaves the device now. (ca3c8320)
- [x] H: switcher with filter from six organizations, recent first, capped scrolling list, neutral avatars, services in words, no Disconnect in rows, flask icon. (8bf5b5ee)
- [x] I and K: plain agent rows with dashed chips for what is missing and the fix as the action; Schedules lead with the background runs warning and Turn on, then the move note as plain text, rows with next run and where results can go. (82a07c61, d4bda8e4)
- [x] J: run review with one blocker block whose fix is the only filled button, facts as a hairline definition list, Start run a disabled secondary while blocked. (221ed212)
- [x] Top bar chip: one short line up to a 1100 px window ("Hosted · Anthropic API · US +2 references"). (421e9903)

### Enterprise items
- [x] Audit events kept apart from run retention and included in both export formats: Microsoft 365 connected and disconnected, access added and removed, organization created, renamed, switched and removed, provider and model changed, public reference installed, enabled, disabled and removed, schedule assigned and unassigned. (0416ed50, 447e911b, ff233ec6)
- [x] Disconnect confirmation names what is deleted and that the Entra enterprise application and admin consent remain, links the revoke steps, and needs an explicit check to delete the local data. Disconnecting always deletes the local data today, so the check confirms it rather than making it optional; TODO(ugur) in the dialog asks whether admins should be able to keep it. (e06970f6)

### Muse round 6 nits
- [x] `!run.tenantId` for the plan size history. (89884553)
- [x] A shared over-long id counts only records that are kept. (c1297d8f)
- [x] The hosted voice provider is structured data on the boundary. (12368ec6)

### Flaky tests
- [x] Settings search tests failed intermittently: opening a section moved focus to its heading a frame later, so typing in the search lost characters. The heading now takes focus only when focus is not already in a field outside the section; a test focuses the search in the first frame and fails without the fix. (4a850d15)

### Verification
- Screenshots in `docs/screenshots/organizations/` at 1280 and 960 px in light and dark (28 files), compared with frames F to K. Remaining differences: reference marks read LM and KC (existing ReferenceMark initials), and the large buttons use the app's existing lg size.
- Live checks on the dev Electron build with Claude Code (`claude-sonnet-5`) as the active provider.

## PR #174 design round review (reviewed 8ab06d8, 2026-11-09)

### GPT-6.1-Sol

1. [x] Blocking: processing locations the app cannot establish. Decided: the label says who sets the location and the detail gives the vendor's documented default. Final wording follows PR #175 at a8ec8b3 (Muse's refinement: the CLI decides the channel): "Claude Code · location set by your account", "Codex · location set by your account", "Azure OpenAI · location set by your deployment type", "GitHub Copilot CLI · location not stated", "Gemini CLI · location not stated", unknown "<name> · location not stated". `providerDataLocation`, `promptsGoTo`, `sendsThroughTool` and `providerDataLocationDetail` and their test block are byte-identical to #175. All four CLIs read "Prompts leave this device through <CLI>; <who sets it>"; only Azure OpenAI reads "Prompts go to <label>". The hosted confirmation asks "Send this question through Claude Code?" with "Send through Claude Code" (Azure OpenAI: "Send this question to Azure OpenAI?"). Tooltips, the reach map, the run review and the confirmation show the detail. Note: #175's source at 1e94f91 still had "GitHub Copilot" and "Google Gemini API" while its tests expected the CLI labels; a8ec8b3 fixes that. (94a49319, f75a87ed, 2ae4a1e2)
2. [x] Audit differences use the runtime's effective grants: a connection without recorded grants has the default read scopes, so replacing them records access removed with the parts it took away. Legacy-connection test. (7089d5ec)
3. [x] The disconnect dialog names an own app registration by label and client ID, with its own revoke steps. (87d602be)
4. [x] Schedules load connector configuration and use the same decision as Connections; loading, failure and a rule with no destination are said as such. (81c542d4)
5. [x] Reference marks lead with the host's brand: learn.microsoft.com is ML, www.kqlsearch.com is KQ, never LM. (93c7bf0b)

Maintainer decisions: disconnect keeps deleting local data with the explicit tick (TODO removed, SPEC records it); the first tab stays labeled with the organization name; the filter threshold stays at six; Add organization stays in both places.

### Muse Wonder Full

- [x] A (blocking): disconnect cancels the tenant's queued and running runs and waits for their work, stops and waits for its cache preload, stops and deletes Agent Team data first (a failure leaves the connection in place, L), clears a write gateway bound to it (N), refuses an unknown tenant (nit); late snapshots and report deliveries of the tenant's runs are dropped. (b3b2541d)
- [x] B (blocking): revoke docs branch by registration kind, warn that the shared OpenAdminOS enterprise application serves every OpenAdminOS user in the tenant, and cover revoking sessions; mirrored to the web docs. (87d602be)
- [x] C: Azure OpenAI settings changes are audited, with the key set or removed, never its value. (ff18e5d9)
- [x] D (blocking): hosted voice with a local chat model names voice's own destination ("Voice audio and prompts go to OpenAI", workspace data residency, as #175), says the chat model stays local and drops tenant data without an organization; the composer says the same for a hosted model without an organization. (b4ef9007, f75a87ed)
- [x] E (blocking): switcher items are aria-disabled while busy, focus returns to the picked item on failure, Retry license check hands focus to its Cancel. (8b377d44, 5ee2f0b6)
- [x] F (blocking): the filter sits outside the menu with its own keys (Home and End stay in the input, Up from the first item returns to it, Enter picks the first match), a polite match count and a focus ring; the chip has aria-controls (nit). (8b377d44)
- [x] G: writes run through one chain, including the bootstrap write of a fresh state file (cloned); concurrent changes keep both events. (ff18e5d9)
- [x] H: the move to organizations is recorded once, on the first write after it. (ff18e5d9)
- [x] I: CSV export has an id column and the retention note. (ff18e5d9)
- [x] J: the state file is flushed before the rename and its folder after, when audit events are written. (ff18e5d9)
- [x] K: stored detail fields are allowlisted per event type. (ff18e5d9)
- [x] L: covered in A (Agent Team purge before commit).
- [x] M: Permissions in the Manage menu shows this organization's granted parts and permissions instead of the connect flow. (eee06b5f)
- [x] N: the dialog lists Agent Team data and multi-tenant jobs, counts the runs it deletes, and says configuration audit entries are kept; the gateway binding is cleared (A). (87d602be)
- [x] O: Disconnect on each Organizations tab row; the dialog says when No organization will be active afterwards. (87d602be)
- [x] P: an over-long id carried by raw records for different tenants, or for none, is ambiguous and never remapped. (4a56fb2a)
- [x] Q: the No organization page says report destinations could not be checked. (26555674)
- [x] R: voice copy mentions web searches and uses the shared wording. (b4ef9007, f75a87ed)
- [x] S: the run review's blocker is the dialog's description, not an alert, and its fix takes focus; one filled button with several services missing; a refused start is still announced. (33828805)
- [x] T: a deliberate section choice focuses the heading; typing in the search keeps focus. (97d443ad)
- [x] U: missing parts say "not granted" in words on a 24 px target. (07e140f6)
- [x] V: paused schedules are neutral and reference counts muted; the boundary chip is one short line at every width now that labels are longer. (11ab8402, 94ab9dfd)
- [x] Nits: unknown tenant fails like rename, recovery text kept in the dialog error, tenant domain in the dialog (87d602be, b3b2541d); reach description includes the voice model (b4ef9007); motion tokens used, `--ease-spring` kept for #175's scan (49fbad71); glossary says result connectors live on Connections (91943652); screenshots recaptured without the tooltip (90328897).

## PR #174 design round review 2 (reviewed eadd95e, 2026-11-09)

### GPT-6.1-Sol

1. [x] Windows durability: the state file is written and synced through the handle that wrote it (`durable-file.ts`), and the folder sync is skipped on Windows, where a directory handle cannot be synced; EINVAL, ENOTSUP and EOPNOTSUPP are ignored and any other folder sync error is raised. Tests use a mocked fs that refuses sync on a read-only handle as Windows does. (6d11a560)
2. [x] to 4. [x] One disconnect lifecycle. Disconnect first marks the tenant closed under the state lock. Every entry point then refuses it: run admission and confirmation, schedule firing, rollback and external proposals, cache refresh starts and every cache write (a generation compare drops a write that started before the close), delivery claim and the check just before each send, Nova actions and gateway proposals. Disconnect then drains in-flight runs, cache refreshes and deliveries, and only then deletes. A tenant that comes back after the close is reopened. Regression tests reproduce GPT's three cases: an overlapping refresh leaves no cached rows, a run started while Disconnect waits is refused, and a claimed Slack delivery never posts. (ed6f60f9)
5. [x] Multi-tenant chats and jobs that include the organization are deleted whole, with the other organizations' results in them; the dialog, docs and SPEC say so and a two-tenant job test covers it. (cae1bbdd)
6. [x] The Azure OpenAI key change is recorded with its own settings write inside the write chain, so concurrent set and remove each record their own event and a failed write records nothing. Tests cover both. (d7c50816)
7. [x] The Microsoft sign-in is removed first. If that fails nothing is deleted and the organization stays connected. A failed Agent Team purge after the local delete is reported as partial, with what stays on the device. Failure-injection tests cover both. (ed6f60f9)
8. [x] Every replacement of a state file that holds configuration audit history is flushed, not only the write that added an event (chosen over a separate store as the smaller change). A folder sync failure is raised instead of being swallowed. (6d11a560)
9. [x] The reach map's description is built from the shared `promptsGoTo` sentence; tests assert parity with it for local, hosted and no-organization cases. (af2d734c)

Also: a read racing a write could queue the move to organizations twice; the migration event is only queued when the read saw the latest write (fcc3c45a). The trailing `CLAUDE.md` wording change was withdrawn by the maintainer; `CLAUDE.md` is untouched.

### Muse Wonder Full

- [x] A: hosted voice with a hosted chat model names both (`Voice · OpenAI and <provider>`) and keeps the reference count; the tooltip and the composer give voice's sentence plus the chat model's. Strip and composer tests. (e944bd4c)
- [x] B: SPEC uses "GitHub Copilot CLI" and "Gemini CLI" in the location labels. (0042f7ef)
- [x] C: a reach map location with a detail line wraps instead of truncating; screenshots recaptured at 1280 and 960 in both themes. (4ef8d60e, 7c07ea1f)
- [x] D: the hosted confirmation lead for Azure OpenAI says "the Azure OpenAI API". (b7dd2bcd)
- [x] E: `pick` returns at once while a switch runs, so Enter in the filter waits too. (40ebea11)
- [x] F: a legacy reconnect counts its granted scopes through `grantedScopeNames`. (eca07fbc)

### Maintainer decision: no sample data

- [x] The product has no sample data; PR #175 removes pilot mode entirely after this PR merges. This PR removes its own entry points: "Preview with sample data" in the organization switcher, the Connections No organization empty state button, and "You can open it again" in the leave dialogs. A sample organization from an earlier pilot still shows labeled with Leave pilot mode. The sample organization handling code stays for #175. Tests assert there is no way into sample data from the menu or the empty state. SPEC, docs and CHANGELOG updated; switcher and No organization screenshots recaptured. (1f88fa94, 72c684ea)
- Not changed here: the first-launch welcome's pilot choice comes from main, not this PR, and goes with the rest of pilot mode in #175.

### CI

- [x] CI at ab0f196 failed `buildGraph interactive fallback > uses the token when the connected account signs in`: the test waited five event loop turns for a grant write that is not awaited, and the durable write path from item 1 (open, write, sync, close, with an access added audit event) takes longer on the runner. The test now waits for the recorded grant with a deadline; six parallel runs pass locally.

## PR #174 Disconnect redesign (reviewed 52a41d3, 2026-11-09)

GPT-6.1-Sol reproduced four more Disconnect holes and one should-fix; Muse Wonder Full independently found the Chat and Nova gaps. The per-call-site guards are replaced by a structural design: the guarantee is enforced at choke points, not by callers.

### Design (acceptance criteria)

- [x] A. Tenant lease: `electron/tenant-lifecycle.ts` owns `open`, `closing`, `removed` with a generation. `withTenantLease` refuses a tenant that is not open, registers the work for draining, hands it a signal that fires when closing begins, and keeps the lease in async context. Routed through it: runs (schedules, rollbacks, gateway proposals and Nova run actions via `track`), cache refreshes and preloads (`collectGraphCache`), single and multi-tenant Chat sends and streams, multi-tenant agent batches, report deliveries, Nova actions and sends, gateway reads, Agent Team save, start, tick and ask. The old `closedTenants`, `tenantGenerations`, `removedTenants`, `stopRunsForTenant`, `drainTenantRefreshes`, `drainRuns`, `assertTenantOpen` per send and `guardedSecrets` are gone.
- [x] B. Egress choke points: guarded fetch into the Graph adapter and the license probe; the tenant's MSAL client is wrapped so every acquisition is refused once closing and a token that arrives after closing began is withheld; tenant sessions for connectors go through the same check; connectors receive `ConnectorBuildContext.fetch` (every request and retry) and `assertEgress` (WhatsApp socket and Signal CLI right before a send), passed by deliveries, Nova sends, connector tests and reads, and agent runs (runtime `connectorTransport`).
- [x] C. Persistence choke points: every tenant-scoped write in the SQLite store (conversations, messages, tool calls, values, graph cache, stale marks, drift baselines, multi-tenant jobs and batches, workspaces, learning, consent, self-training, refresh schedule) and in `office.db` checks the tenant and the lease generation; the state file filter (`tenant-removal.ts`) lets a write remove anything but drops added or changed tenants, runs, deliveries, Nova connector audit entries, active tenant and gateway binding of a tenant that is not writable. Dropped writes are logged.
- [x] D. Two phases, persisted: phase 1 under the state lock closes the tenant and in one write removes it (runs, deliveries, active, gateway binding) and stores a removal record; phase 2 drains (bounded, 15 s), removes the sign-in, purges Agent Team and Chat data, drops the record. A failure or a quit keeps the record and the tenant closed; `resumeTenantCleanups` runs at launch before recovery, deliveries, gateway, schedulers and the Agent Team tick; Retry cleanup on Connections and in the connect flow. Reconnecting the same tenant is refused with the designed message until cleanup finished, then opens a new generation. The dialog reports done, or removed with cleanup pending and why.
- [x] E. Tests: every reproduction, a test that enumerates the egress and persistence choke points with a closed lease, restart with a removal record, reconnect during pending cleanup.

### GPT-6.1-Sol reproductions (each a regression test in `tenant-disconnect.test.ts`)

1. [x] Multi-tenant Chat job waiting for its model answer: refused with the organization being disconnected, no job, conversation or messages left.
2. [x] Teams report whose token is released after Disconnect began: no Graph request.
3. [x] Nova multi-part Slack send interrupted by Disconnect (Muse): stops after the accepted part ("1 of 2 messages confirmed"), Disconnect waits for it, one Slack post, no audit entry added for the removed tenant.
4. [x] Gateway read whose token is released after closure: no `/users` request, and a new gateway read is refused. Agent Team save, start, tick and ask are refused for a closing organization and an answer that arrives after closing is not stored (`office.test.ts`).
5. [x] Should fix: a failure after the sign-in was removed (SQLite purge) leaves the organization removed with cleanup pending and why; reconnect shows the designed message; Retry cleanup finishes it; reconnect then opens a new generation.

Also: choke point enumeration with a closed lease (Graph, MSAL, session, connector transport, Nova send, runs, Chat send, gateway read, cache refresh, Agent Team save, 13 SQLite writes, state file run write); a multi-tenant agent batch with a closing organization is refused and writes nothing (Muse); restart with a removal record resumes cleanup and keeps the tenant closed until then; lifecycle and write filter unit tests (`tenant-lifecycle.test.ts`).

### Muse Wonder Full items

1. [x] The renderer reloads state after a failed disconnect, and a partial outcome is a warning ("<name> was removed and its work stopped. Cleanup on this device is pending: <why> It resumes at the next launch, or choose Retry cleanup on Connections."), not "Disconnecting failed". Connections and the connect flow show Disconnect cleanup pending with Retry cleanup. Tests in `Connections.test.tsx` and `SetupFlowContext.test.tsx`.
2. [x] Gateway read tools are leased; covered by reproduction 4 and the enumeration test.
3. [x] Nits: `stopRunsForTenant` is removed (the bounded lease drain replaces it and logs work still stopping); `refreshDueGraphCaches` skips a closing tenant and does not mark its schedule, also when it starts closing mid-refresh (test); the comment at `setAzureOpenAIConfig` says a folder sync failure after the rename reports failure for a saved change; the sign-in failure now leaves the organization removed with cleanup pending, and the warning says its work stopped.

### Evaluator (separate feature-dev:code-reviewer, 85c88174)

- [x] Important: non-streaming Chat and the multi-tenant summary could still send tenant data to the model after closing began (the lease signal was dropped). Chat now gets its model through `tenantLlm`, the model egress choke point: each `complete` and `stream` is refused once a tenant in its prompt is closing, and a request in flight is aborted with the lease signal. Test: model egress choke point.
- [x] Below threshold, fixed anyway: when the phase 1 write fails, `abortClose` reopens in the same generation, so work stopped by the close still saves its final state.
- Found sound: lifecycle, write filter, two phases, launch resume order, read hook, serialize and write chain context, MSAL proxy, every connector build site, the six connectors, SQLite and Agent Team guards; no deadlock between the write chain and the drain, no async context leak that refuses an open tenant.

### Verification

- Node 22: typecheck, electron, runtime, scripts, renderer, qa and docs:check (results in the hand-back).

# Splashtop: support assistant and Open API connection (2026-11-09)

Branch `splashtop/connection`, based on `main` after PR #174. Includes the two prepared commits from `splashtop/marketplace` (Splashtop API Reference MCP, Coming soon card, which this branch replaces).

## Decisions (maintainer, 2026-11-09)

1. Support assistant without sign-in: the Splashtop API Reference MCP (`docs.splashtop.com/mcp`, four reference tools) and a built-in knowledge base search over Splashtop's Zendesk Help Center (`support-splashtopbusiness.splashtop.com/api/v2/help_center/...`, public, no auth), offered to Chat as a built-in public reference with `search_articles` and `get_article`, installable in the Marketplace, off by default, with the public reference trust disclosure, third-party fencing and designed errors.
2. Splashtop Open API as a built-in service per organization: a Team Owner or Super Admin API token, stored with safeStorage and bound to the organization, sent only to the regional host (Global/US `webapi.splashtop.com`, EU `webapi.splashtop.eu`, Oceania `webapi.splashtop.nr`, paths `/api/open/v1/...`, Bearer). Enterprise only. Connect, test, rotate and disconnect on Connections, audited. Designed errors for 401, 403, 429 and a wrong region.
3. Reads as a service with parts (computers, inventory, users and groups, sessions and logs, policies and vulnerabilities), each a paginated read tool. Results are organization data.
4. Writes as write plans with diff confirmation: reboot computers, delete a computer, disable a user, end a session (destructive, typed phrase), rename a computer (non-destructive). Existing write-plan and confirmation path, so organization isolation applies.
5. Marketplace: a real Splashtop listing that opens the Connections connect step.
6. Splashtop's real logo from its official assets, unmodified, recorded in the logos NOTICE.

## Implementation decisions (implementation agent, flagged for review)

- The Microsoft service registry (`services.ts`, `ServiceId`) stays Graph only. Splashtop is a vendor service defined in `packages/agent-sdk/src/splashtop.ts` with its own parts; its connection lives in `OrganizationRecord.connections.splashtop` (no secret), the token in safeStorage keyed by organization id.
- An organization is still created by its Microsoft 365 connection on this branch, so Splashtop connects into an existing organization. A Splashtop-only organization needs the organization model to stop deriving the active organization from `activeTenantId`; flagged as `TODO(ugur)`.
- Splashtop changes are host-built write plans queued as system runs (`origin: "splashtop-change"`), the same gate as baseline rollbacks and gateway proposals: awaiting confirmation, typed phrase, active organization only, fail-stop apply. They are prepared from Plan a change on the Connections Splashtop section (the host lists the targets from Splashtop, the admin picks them). Chat stays read-only: its write-intent block runs before the model, so Chat does not prepare changes.
- Agent manifests cannot declare Splashtop yet: `services` is typed as Microsoft `ServiceId` across gating, QA and the schema. Agents reading or changing Splashtop is a follow-up, flagged as `TODO(ugur)`.

## Acceptance criteria

1. Splashtop Docs is a Marketplace listing (Built in, off by default, host `support-splashtopbusiness.splashtop.com` named in the install review). Installed and enabled, Chat offers `search_articles` and `get_article`; params pass the public reference egress checks; results are fenced as third-party content with article links as sources. 404, 429 (with the wait time), 5xx, timeouts, network failures and malformed answers each give a designed message. Tests with mocked HTTP.
2. Splashtop API Reference MCP and the knowledge base search are verified live once (no auth), recorded below.
3. Connections shows Splashtop under Other services for the active organization: Connect (region, token, what it needs, where it goes), Test, Rotate token, Disconnect. The token is never returned to the renderer, is stored with safeStorage under the organization id, and is sent only to the chosen region's host over HTTPS with no redirects. Connect calls `users/basic_info` and saves nothing on failure. 401, 403 (plan or role), 429, a wrong region and network failures each give a designed message. Tests cover storage, host binding, region and each error.
4. Connect, rotate and disconnect record configuration audit events with no secret. Disconnecting the organization (Microsoft 365) also deletes its Splashtop token and connection.
5. Chat read tools for the active organization only: computers, inventory, users, groups, session logs (active and finished), team history (audit), endpoint policies and vulnerabilities, each with pagination and a row cap. Results are fenced as organization data and their values never reach a public reference query. A test proves another organization's token is never used.
6. Plan a change (Connections) lists targets from Splashtop; each write builds a plan with one action per target showing the current value and the change; destructive kinds require `REBOOT n COMPUTERS`, `DELETE n COMPUTERS`, `DISABLE n USERS`, `END n SESSIONS`; rename requires `RENAME n COMPUTERS` and is not destructive. Confirm with a wrong phrase or from another organization is refused; apply runs in order and stops at the first error. Tests for each kind.
7. The Marketplace Splashtop listing replaces the Coming soon card and opens the Connections connect step.
8. Splashtop logo from official assets, recorded in the NOTICE with the disclaimer.
9. SPEC, a Splashtop service page in the user docs, CHANGELOG and this file updated. Typecheck, electron, renderer (Node 22), runtime, qa and docs:check pass. PR opened against `main`.

## Live verification

- 2026-11-09, Splashtop API Reference MCP (`https://docs.splashtop.com/mcp`, no auth): `initialize` (server "Splashtop API" 1.0, protocol 2025-06-18), `tools/list` (five tools; the four offered are present), `list-endpoints` (the full Open API path list used to build the client), `get-endpoint` for every endpoint OpenAdminOS calls, and `get-server-variables` (the three regional hosts). Also through OpenAdminOS's MCP host: handshake, allowlist and `search-endpoints` for reboot (`electron/splashtop/live.test.ts`).
- 2026-11-09, Splashtop Help Center (no auth): `GET /api/v2/help_center/articles/search.json?query=reboot computer` (200, 492 results, `x-rate-limit: 700`), `GET /api/v2/help_center/en-us/articles/115000983226.json` (200, article with body HTML), a missing article (404), an empty query (refused by Zendesk with a message, OpenAdminOS refuses it before sending). Also through the built-in reference: search and article read (`electron/splashtop/live.test.ts`).
- Not verified live: the Splashtop Open API itself. It needs an Enterprise API token, which this environment does not have. Request and answer shapes follow the endpoint specs above; tests use mocked answers in those shapes.

## Review

- Built as planned with these changes: writes are prepared from Plan a change on Connections, not from Chat (Chat's write-intent block runs before the model); Disconnect of Microsoft 365 removes the organization's Splashtop connection in the same write, because `reconcileOrganizations` keeps records with unknown connections when their tenant is gone; the built-in reference call is raced against its deadline so a request that ignores the abort signal cannot hang an answer.
- Open, flagged with `TODO(ugur)`: agents and Splashtop; organizations without Microsoft 365; Splashtop on the reach map (after PR #175's service logos land).
