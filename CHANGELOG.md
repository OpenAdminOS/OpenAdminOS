# Changelog

All notable changes to Open Agents are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
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
