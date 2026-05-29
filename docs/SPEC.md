# OpenAdminOS — Product Specification

> Source of truth for product decisions, architecture, design system, and roadmap. Read this before writing code. If reality diverges from this doc, update the doc as part of the same change.

---

## 1. What we're building

**OpenAdminOS** is an open-source desktop platform for Microsoft 365 administrators (initially Intune & Entra) to run AI agents against their tenants. Agents are TypeScript modules contributed by the community, run locally on the admin's machine, and operate against the tenant via Microsoft Graph.

The product is local-first: by default, tenant data and LLM prompts never leave the user's device. The user can opt into hosted LLM providers (Anthropic, OpenAI, Azure OpenAI), and when they do, the UI honestly reflects that data leaves the device.

### Distribution surface

- **Desktop app** (Electron, Windows + macOS + Linux, signed installers) — the only end-user surface

There is no separate CLI. Power users get the same GUI; contributor tooling (agent scaffold, dev/test commands) lives in repo scripts, not in a published `npx` binary.

### Audience

- Primary: Microsoft 365 / Intune / Entra administrators in mid-to-large organizations and MSPs
- Secondary: IT consultants, MVP community members, scripting-fluent admins
- Explicitly NOT: end users, developers building general-purpose AI apps, hybrid AD admins

### Why this exists

Most AI tools for IT admins today are wrappers around ChatGPT — single-purpose, cloud-only, no extensibility. OpenAdminOS is a **platform**: the runtime, the registry, the trust model. Community-contributed agents accumulate over time. The closest mental model is **Home Assistant for Microsoft 365 admins** — local-first runtime, GitHub-hosted integrations, opinionated UX.

---

## 2. Architecture

### Monorepo layout

```
openadminos/
├── apps/
│   ├── desktop/              # Electron main + preload + renderer (Vite + React)
│   └── marketing/            # Public marketing site (openadminos.com) — Next.js
├── packages/
│   ├── runtime/              # Agent execution engine
│   ├── llm/                  # Provider abstraction + concrete providers
│   ├── graph/                # MSAL + Graph API client
│   ├── registry/             # Agent registry loader (GitHub-backed)
│   ├── storage/              # SQLite wrapper for run history, configs
│   ├── ui/                   # Shared React components (used by desktop renderer)
│   └── agent-sdk/            # The SDK community uses to write agents
├── agents/
│   └── (built-in agents live here as reference implementations)
├── docs/
│   ├── SPEC.md               # This file
│   ├── ARCHITECTURE.md       # Deeper dive (write as needed)
│   └── mockups/              # HTML design reference
├── tasks/
│   ├── todo.md               # Active work plan with acceptance criteria
│   └── lessons.md            # Patterns learned from corrections
├── CLAUDE.md                 # Operating instructions for Claude Code
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── LICENSE                   # MIT
```

### Why Electron, not Tauri

We previously planned for Tauri (smaller binaries, native webview). After analyzing the real constraints, we flipped to Electron. Reasoning:

- **Developer velocity is the primary constraint.** Pure TS/Node end-to-end. No Rust toolchain, no two-language IPC bridge. MSAL Node, `better-sqlite3`, `keytar`, `electron-updater` all work natively in the main process.
- **Open-source contributor pool.** Community contributions (agents and UI) come from JS/TS devs. Tauri's Rust shell raises the bar for any contributor who wants to fix more than an agent.
- **UI fidelity.** Chromium everywhere = identical rendering on Win/Mac/Linux. The design language (dense, dark, custom scrollbars, GPU-accelerated transitions) is more reliable on Chromium than on platform-native webviews.
- **Proven path for this category.** Claude Desktop, VS Code, Linear, Slack, Figma, 1Password — all Electron. The "Electron is bloated" critique mattered more on 8GB-RAM machines than on modern admin workstations.
- **t3code is Electron.** Our reference architecture uses Electron with `node-pty` and long-lived subprocess work — patterns port directly.

The cost we accept: ~80–150MB installer size (vs ~5–10MB Tauri), ~150–250MB idle memory per window. For an IT-admin tool on managed devices this can pinch corporate deployment limits, but it's not a blocker. Trust posture is *architectural* (no tenant-content telemetry, local-first, write confirmation), not framework-derived.

### Reference architecture: t3code

Study https://github.com/pingdotgg/t3code before structuring the monorepo. The shape we want is the same: **one TypeScript monorepo that ships a polished Electron desktop app**, with a clean provider-adapter pattern and shared schema package. Don't copy `apps/desktop` wholesale (Effect adoption is a deeper commitment than we need yet), but the directory shape, contracts package, and adapter abstraction all transfer.

### LLM provider abstraction

A `LLMProvider` interface in `packages/llm/` with these methods at minimum:

```ts
interface LLMProvider {
  id: string;                          // 'ollama', 'anthropic', etc.
  isLocal: boolean;                    // affects UI trust messaging
  listModels(): Promise<Model[]>;      // for the picker
  testConnection(): Promise<TestResult>;
  complete(opts: CompletionOpts): AsyncIterable<CompletionChunk>;
}
```

Concrete providers, all required for v1:
- `OllamaProvider` (local, default)
- `LMStudioProvider` (local)
- `AnthropicProvider` (hosted)
- `OpenAIProvider` (hosted)
- `AzureOpenAIProvider` (hosted)

Current implementation note: OpenAI support is delivered through the user's
locally installed Codex CLI (`codex`) rather than a stored OpenAI API key.
OpenAdminOS probes the CLI and `~/.codex/auth.json`, then invokes
`codex exec --ephemeral --skip-git-repo-check -s read-only` for agent LLM
steps. It does not force a model by default; Codex uses the user's configured
account-supported default unless a run later pins an explicit model. This
preserves the "no vendor API keys in OpenAdminOS" trust boundary, but tenant
prompts still leave the device because the selected model is hosted.
The model picker is populated from Codex's local `models_cache.json`, with
`config.toml` supplying the default model when present.
Provider settings include an explicit smoke test action for connected providers;
the test runs a tiny completion and reports the model and response time. This is
intentionally visible because hosted/local provider trust is a core product
decision, not hidden plumbing.

Per-agent model overrides are required: an agent's manifest can specify a preferred model and the user can override it.

### Agent contract

**Every agent invokes the LLM at least once.** The model is load-bearing, not optional polish. Agent Template manifests MUST declare at least one step with `format: llm`; the runtime hard-fails any LLM step that is reached without a connected provider (no silent skipping), and `startRun` preflights the active provider before queueing. This is what makes an agent an *agent* and not just a Graph query — the deterministic transforms shape the data, but the model is the part that reasons and produces the headline the admin reads.

Concretely:
- The agent's `result.summary` should reference the LLM step's output (e.g. `{{ summarize.output.text | default("...") }}`), not a deterministic count template. The deterministic counts belong in `result.data` for structured rendering.
- Write agents use the LLM to *explain* the plan in plain language before the typed-confirmation prompt — they don't get a pass.
- If a write agent produces zero actions after applying its filters, the run completes as a no-op result. Typed confirmation is required for every non-empty write plan, but an empty plan must not be reported as a failure.
- If you genuinely don't need an LLM (e.g. a pure data export), this product is the wrong tool; reach for `Get-MgDeviceManagementManagedDevice | Export-Csv` or a similar deterministic script instead.

An agent is a TypeScript module with a default-exported manifest and a `run` function:

```ts
export default {
  id: 'intune-compliance-check',
  name: 'Intune Compliance Check',
  description: 'Lists devices that fall out of compliance and suggests remediation.',
  author: { name: 'openadminos', verified: true },
  version: '1.2.0',
  mode: 'read',                        // 'read' | 'write'
  scopes: [                            // Graph permissions required
    'DeviceManagementManagedDevices.Read.All',
  ],
  connectors: [                        // optional; declared egress dependencies
    { id: 'teams', required: false, capabilities: ['post-channel-message'] },
  ],
  modelRequirements: {
    minContextTokens: 8000,
    preferredModel: 'claude-sonnet-4-7',
  },
  async run(ctx: AgentContext) {
    // ctx.graph — the Graph API client (auto-scoped to tenant)
    // ctx.llm — the LLM provider (auto-configured)
    // ctx.connectors — egress adapters declared in the manifest (see Connector abstraction)
    // ctx.log — structured logging that streams to the UI
    // ctx.confirm(diff) — required for write agents; throws if user rejects
  },
};
```

Agents may declare optional or required `connectors:` — see Connector abstraction below.

### Connector abstraction

Agents bring data *in* from Graph. Connectors push results *out* — Teams channel, ServiceNow ticket, email, webhook. Without connectors an agent's findings stay on the admin's laptop; with them the right people see the right output where they already work. Connectors are the egress half of the agent contract.

**Status:** the type contract (interfaces, error classes, registry-augmentation pattern, `defineConnector()`) ships in `@openadminos/agent-sdk` in the [Unreleased] section. MSAL interactive sign-in is already wired up (see `packages/runtime/src/msal.ts`), so `graph-delegated` connectors have everything they need from the auth layer. The runtime injection and the first connector — **Microsoft Teams** — land in the next release alongside the Connectors sidebar entry, the channel-picker setup UI, and the preview-and-send confirmation modal.

The design goal is to ship the contract once and never break it. Capability versioning, typed errors with explicit recovery semantics, runtime-supplied idempotency keys, and per-package plugin distribution are the four pillars that make that possible. Each one is non-negotiable before the first connector ships — retrofitting them after agents start consuming the API is what makes ecosystems brittle.

#### Auth source classes

Three classes, each with a distinct trust posture:

- `graph-delegated` — piggybacks on the active tenant's MSAL token; adds Graph scopes (Teams, Outlook, SharePoint, Planner). No new credentials, no second consent dance. Data stays inside the customer's M365 tenant boundary.
- `graph-application` — app-only consent via Resource-Specific Consent or per-resource installation. Deferred past v1.0; the interface accommodates it so we don't have to break agents to add it later.
- `external` — owns credentials in the OS keychain (ServiceNow, Jira, Slack). Data leaves the tenant boundary; trust messaging must say so explicitly. External connectors implement a uniform OAuth/credential flow surface so the setup UI is connector-agnostic.

#### Capability kinds → confirmation tiers

Every capability declares a `kind` that maps to a confirmation tier. Mixing connectors with destructive Graph operations under one `mode: 'write'` flag would be sloppy — most connector use is *additive notification*, not destruction, and conflating the two erodes the typed-diff gate's signal value.

| Kind          | Side effect                       | Confirmation                                     | Examples                                  |
|---------------|-----------------------------------|--------------------------------------------------|-------------------------------------------|
| `read`        | None                              | None                                             | `listTeams`, `listChannels`               |
| `notify`      | Additive (creates a new artifact) | **Preview & send** modal — rendered output + target, one-click confirm | `post-channel-message`, `create-incident` |
| `mutating`    | Modifies an existing artifact     | Diff modal — before/after, one-click confirm     | `edit-message`, `update-incident-status`  |
| `destructive` | Removes an artifact               | Typed-phrase confirmation, same gate as destructive Graph ops | `delete-message`, `close-incident`        |

The agent's `mode: 'read' | 'write'` continues to describe Graph behavior unchanged. The agent's **effective trust tier** at install and run time is `max(agent.mode, max(declared capability kinds))`. UI presents both axes — "Reads Intune devices · Posts to Microsoft Teams" — never collapses them into one tag.

#### Versioning

Capabilities are SemVer-major-versioned and addressed as `id@major`. Agents pin a major: `capabilities: ['post-channel-message@1']`. Connectors may ship `@2` (e.g. switches from markdown to Adaptive Cards) without breaking agents on `@1`. The connector itself is also SemVer'd; agents declare `minVersion`.

Manifests declare a top-level `schemaVersion: 1`. The runtime rejects unsupported schema versions with a designed error and a "this agent was authored for a newer OpenAdminOS" remediation. This is how we evolve the manifest shape without orphaning agents in the wild.

#### The interface

Lives in `packages/agent-sdk`. The runtime imports it; per-connector packages augment it; agent authors consume it via `defineAgent()` and `ctx.connectors`.

```ts
type ConnectorAuthSource = 'graph-delegated' | 'graph-application' | 'external';
type CapabilityKind = 'read' | 'notify' | 'mutating' | 'destructive';

interface ConnectorTrust {
  label: string;          // 'Microsoft Teams · {tenant}'
  detail: string;         // one sentence on where data actually goes
  staysInTenant: boolean; // true for graph-*, false for external
}

interface CapabilityDescriptor {
  id: string;             // 'post-channel-message'
  version: number;        // SemVer major; minor/patch are non-breaking
  kind: CapabilityKind;
  /** Subset of the connector's scopes required to invoke this capability. */
  scopes: string[];
  /** Override the connector-level trust for capability-specific messaging. */
  trust?: Partial<ConnectorTrust>;
}

interface ConnectorDescriptor {
  id: string;             // 'teams', 'servicenow', 'slack'
  name: string;
  version: string;        // SemVer of the connector implementation
  authSource: ConnectorAuthSource;
  /** Union of every capability's scope set; used for MSAL consent. */
  scopes: string[];
  capabilities: CapabilityDescriptor[];
  /** JSON Schema describing per-install configuration (channel picker, instance URL, etc.). */
  configSchema?: object;
  trust: ConnectorTrust;
}

interface ConnectorInstance<TCapabilities> {
  descriptor: ConnectorDescriptor;
  status: 'connected' | 'needs-setup' | 'needs-scope' | 'error';
  capabilities: TCapabilities; // typed, per-connector
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  dispose(): Promise<void>;
}

interface ConnectorFactory<TCapabilities> {
  descriptor: ConnectorDescriptor;
  /** Called once per run after preflight. Receives the resolved tenant session + per-install config. */
  build(ctx: ConnectorBuildContext): Promise<ConnectorInstance<TCapabilities>>;
}

interface ConnectorBuildContext {
  tenant: TenantSession;          // MSAL token accessor for graph-* connectors
  config: Record<string, unknown>;// validated against descriptor.configSchema
  secrets: SecretAccessor;        // keychain-backed; only used by external connectors
  log: RunLogger;
  /** Runtime-supplied idempotency key generator for capability invocations. */
  idempotencyKeyFor(stepId: string, iteration: number): string;
}

/** Module-augmentable registry — see "Type-safe registry" below. */
interface ConnectorRegistry {} // intentionally empty; populated by connector packages
```

Agent declarations reference connectors via a typed requirement block:

```ts
interface AgentConnectorRequirement {
  id: keyof ConnectorRegistry;          // string-narrowed by augmentation
  minVersion: string;                   // SemVer of the connector
  capabilities: { id: string; version: number }[];
  required: boolean;                    // false → graceful degradation
}
```

#### Error contract

Connectors throw typed errors; the runtime maps each to a designed UI state with the correct recovery action. No generic `Error` throws — every failure has a designed remediation.

```ts
type ConnectorRecovery = 'retry' | 'reauth' | 'reconfigure' | 'fatal';

abstract class ConnectorError extends Error {
  abstract readonly recovery: ConnectorRecovery;
  abstract readonly connectorId: string;
  readonly capabilityId?: string;
  readonly cause?: unknown;
}

class ConnectorAuthError extends ConnectorError {           // recovery: 'reauth'
}
class ConnectorScopeError extends ConnectorError {          // recovery: 'reauth'
  readonly missingScopes: string[] = [];
}
class ConnectorRateLimitError extends ConnectorError {      // recovery: 'retry'
  readonly retryAfterMs: number = 0;
}
class ConnectorNotConfiguredError extends ConnectorError {  // recovery: 'reconfigure'
}
class ConnectorRemoteError extends ConnectorError {         // recovery: 'retry' | 'fatal'
  readonly statusCode?: number;
}
class ConnectorValidationError extends ConnectorError {     // recovery: 'fatal'
}
```

The runtime applies bounded exponential-backoff retries for `recovery: 'retry'` errors. `reauth` triggers the MSAL re-consent flow (or external OAuth refresh) inline in the run. `reconfigure` parks the run on the Connectors page deep-linked to setup. `fatal` fails the run with the error class name and message surfaced verbatim.

#### Idempotency and audit

Every `notify`/`mutating`/`destructive` capability call receives a runtime-supplied `idempotencyKey` derived from `${runId}:${stepId}:${iteration}`. Connectors that support remote idempotency (Graph `Idempotency-Key` header, ServiceNow correlation IDs) honor it; those that don't, ignore it. Re-running a failed step never duplicates posts when the connector is idempotent-aware.

Every invocation emits a structured audit entry. The shape is connector-agnostic; the audit log export (§5 Important) consumes this directly:

```ts
interface ConnectorAuditEntry {
  runId: string;
  stepId: string;
  connector: string;       // 'teams'
  capability: string;      // 'post-channel-message@1'
  kind: CapabilityKind;
  idempotencyKey: string;
  egressTarget: string;    // 'contoso.onmicrosoft.com · Team A · #it-ops'
  argsDigest: string;      // sha256 of redacted args; for dedup detection
  status: 'success' | 'failure';
  durationMs: number;
  externalId?: string;     // remote messageId / ticketId
  externalUrl?: string;    // webUrl
  errorClass?: string;
  errorMessage?: string;
}
```

#### Runtime contract

Lifecycle, in order, per run:

1. **Manifest load** — connector requirements validated against the host's known registry. Unknown ids or unsatisfiable `minVersion` constraints reject the run before queue.
2. **Preflight** — for each required connector: factory `build()` is called, then `healthCheck()`. Failures surface as designed error states (see §5 Critical) before any LLM/Graph call runs.
3. **Capability invocation** — `ctx.connectors[id].capabilities.foo(args)` calls go through a runtime wrapper that: emits audit entry start, applies confirmation tier (preview/diff/typed), supplies `idempotencyKey`, catches `ConnectorError`, applies retry/reauth policy, emits audit entry finish.
4. **Disposal** — `dispose()` called for every built instance at run end, success or failure.

Required vs optional: a `required: true` connector that's not connected fails preflight. A `required: false` connector that's not connected makes `ctx.connectors[id]` `undefined`; agents check before use. The typed signature reflects this — `ctx.connectors.teams?` not `ctx.connectors.teams!`.

#### Type-safe registry via module augmentation

The empty `ConnectorRegistry` interface in `@openadminos/agent-sdk` is populated by each connector package via declaration merging. This is the standard TypeScript pattern for extensible registries (React Router, Vite, Wrangler all do this) and gives agent authors full IntelliSense without coupling the SDK to the known connector list.

```ts
// packages/connector-teams/src/index.d.ts
declare module '@openadminos/agent-sdk' {
  interface ConnectorRegistry {
    teams: TeamsConnectorCapabilities;
  }
}
```

Inside `defineAgent({ run(ctx) { ctx.connectors.teams.postChannelMessage(...) } })`, the `.teams` property exists if and only if `@openadminos/connector-teams` is installed in the workspace. Misspelled connector ids are type errors at edit time.

#### Plugin architecture

Each connector ships as its own package under `packages/connector-<id>/` (in-tree initially) and later via the agent registry (community-contributed). Per-package boundaries make versioning, testing, and supply-chain review tractable.

```ts
// packages/connector-teams/src/index.ts
import { defineConnector } from '@openadminos/agent-sdk';
import type { TeamsConnectorCapabilities } from './capabilities';

export default defineConnector<TeamsConnectorCapabilities>({
  descriptor: { /* ... */ },
  build: async (ctx) => {
    const client = createGraphClient(ctx.tenant);
    return {
      descriptor,
      status: 'connected',
      capabilities: makeTeamsCapabilities(client, ctx.idempotencyKeyFor),
      healthCheck: async () => ({ healthy: true }),
      dispose: async () => { /* no-op for stateless Graph client */ },
    };
  },
});
```

The host (in `packages/runtime`) discovers connectors via a static import map for now; v1.0+ may move to dynamic registration as third-party connectors land. The contract above is stable regardless of discovery mechanism.

#### UI surface

- New sidebar entry **Connectors** between Agent Hub and Activity.
- Connectors page: card per registered connector with status pill (`connected` / `needs setup` / `needs scope` / `error`), capability list (one row per `id@version` with kind tag), trust label. Per-connector detail page handles setup (Teams channel picker, ServiceNow instance URL + credentials) generated from `configSchema`.
- Per-agent install: when the manifest declares connectors, install adds a connector-setup step before the agent appears installed. The step itemizes egress targets and capability kinds so the user knows what they're authorizing.
- Run status: when a run uses connectors, the status-strip trust cell expands to list each egress target. Capability invocations stream into the run timeline with the kind-appropriate confirmation modal.
- Error states: every `ConnectorError` subclass has a designed remediation tile in §06 — `auth expired → reauth`, `missing scope → re-consent`, `rate limited → retry in Xs`, `not configured → open Connectors page`.

#### Teams connector (first to ship)

The Teams connector lands first because it is the cheapest credible connector — `graph-delegated`, so it reuses the existing MSAL flow; data stays in the tenant; each capability is one Graph call. It validates the abstraction without paying for a new trust surface.

```yaml
descriptor:
  id: teams
  name: Microsoft Teams
  version: 1.0.0
  authSource: graph-delegated
  scopes:
    - ChannelMessage.Send
    - Chat.ReadWrite
    - Team.ReadBasic.All
    - Channel.ReadBasic.All
  capabilities:
    - id: list-teams
      version: 1
      kind: read
      scopes: [Team.ReadBasic.All]
    - id: list-channels
      version: 1
      kind: read
      scopes: [Channel.ReadBasic.All]
    - id: post-channel-message
      version: 1
      kind: notify
      scopes: [ChannelMessage.Send]
    - id: post-chat-message
      version: 1
      kind: notify
      scopes: [Chat.ReadWrite]
  trust:
    label: "Microsoft Teams · {tenant}"
    detail: "Posts via Microsoft Graph as the signed-in admin. Data stays inside the tenant."
    staysInTenant: true
```

Capability surface:

```ts
interface TeamsConnectorCapabilities {
  listTeams(): Promise<{ id: string; displayName: string }[]>;
  listChannels(teamId: string): Promise<{ id: string; displayName: string }[]>;
  postChannelMessage(args: {
    teamId: string;
    channelId: string;
    markdown: string;
  }): Promise<{ messageId: string; webUrl: string }>;
  postChatMessage(args: {
    chatId: string;
    markdown: string;
  }): Promise<{ messageId: string; webUrl: string }>;
}
```

Decisions locked for the first release:
- **Delegated permissions only.** Posts attributed to the signed-in admin ("{admin} · via OpenAdminOS"). No Resource-Specific Consent, no per-team app installation. Application permissions are a v1.1+ concern; the descriptor's `authSource` field is the seam where that decision can change without breaking agents.
- **Teams scopes folded into the MSAL consent screen.** Granted once at tenant connect. Admins who declined initial consent see `status: 'needs-scope'` and a single re-consent button — no separate auth flow.
- **`post-*-message` is `kind: notify`.** Users see a "Send to Teams?" preview modal with the rendered markdown and the target channel — one-click confirm, not typed phrase. Typed-phrase confirmation is reserved for destructive Graph operations; debasing it for routine notifications dulls its trust signal.
- **`configSchema` covers default channel/chat selection.** Per-install setting; agents can override at invocation time.

#### Why Teams first, ServiceNow second

Teams proves the contract generalizes across capabilities while keeping the trust surface unchanged from today. ServiceNow is the canonical second connector — `external` auth, instance URL configuration, keychain-stored credentials, "data leaves your tenant" trust messaging. Designing both into the abstraction from the start, shipping Teams first, validates the contract before paying for a new trust surface.

### Registry model

The OpenAdminOS repository **is** the registry. Agents live in `/agents/<slug>/` in this repo (`OpenAdminOS/OpenAdminOS`), each directory containing `manifest.yaml`, `README.md`, and optional fixtures. There is no separate `openadminos-registry` repo and no two-tier "bundled vs. community" trust split — everything is community-by-default, contributed via PR to this repo.

The app binary ships with **zero agents**. At runtime the desktop app fetches the agent index (`/agents/index.json`, generated by CI from the manifests on every push to `main`) from the configured registry source, caches it to userData, and lets the user browse and install agents on demand. Installed agents are version-pinned; updates are surfaced as explicit "update available" badges and never auto-applied.

Distribution semantics:

- **Source of truth:** `https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents/`
- **Index:** `agents/index.json` is generated by CI from `agents/*/manifest.yaml` after the agent QA gate (schema, scopes, endpoints, fixture coverage) passes. Broken agents never reach users.
- **Per-agent install:** fetch manifest → write to userData → version-pin. The same Agent Hub install flow as today, just fetching from HTTP instead of reading the binary.
- **Forkable:** Settings exposes a "Registry source" field. Enterprises can fork this repo, curate `/agents/`, and point the app at their fork. Cheap to implement, big trust win.
- **App↔manifest version coupling:** each `index.json` entry carries `minAppVersion`. The app hides agents it can't run with a "Update OpenAdminOS to use this agent" note. This is how the DSL can evolve without orphaning users on older app versions.

Cache lifecycle:

- Onboarding already requires network (MSAL, provider probe), so the first index fetch piggybacks on that flow — no offline-first complexity for first-run.
- On every subsequent launch (online): refresh `index.json` in the background. Compare to cached per-agent versions, surface per-agent update badges.
- Failed refresh is silent — keep using the cache, show a small "last refreshed N ago" indicator in Agent Hub. No blocking errors for a transient network blip.
- App works fully offline against the cached set after the first successful fetch.

Agent Hub UX should feel like an app store for admin agents, but without fake editorial weight. Until there is real curation data, do not render a giant "Featured" hero based on list order or split the same catalog into separate top-level surfaces. Use one consistent browse grid, dynamic category/mode/install filters, clear install/open actions, install counts where available, and trust/permission badges that help admins decide what to install. Registry freshness is diagnostic detail; do not make remote/cache state a primary card. Agent detail/manifest views should be decision-first: show what the agent does, install state, required scopes, mode, and tenant impact before exposing raw YAML. Installing from Agent Hub requires an explicit permission review step; a card click opens details, while the actual install action confirms the declared Graph scopes.

This is modeled on **Home Assistant integrations** (https://developers.home-assistant.io/docs/creating_integration_file_structure/) — one repo, PR-driven contribution, explicit version pinning per install.

### Local storage

SQLite via `better-sqlite3` for:
- Tenant configurations (encrypted via OS keychain for tokens)
- Installed agent registry
- Run history (full structured logs)
- LLM provider configurations (with hosted-provider API keys in OS keychain)

No cloud sync. No tenant-content, prompt, run-result, analytics-event, or
error-reporting telemetry. Packaged production builds may send a minimal public
registry install count event when a public agent is installed: agent slug, app
version, OS platform, and a yearly per-agent SHA-256 hash derived from a random
local install ID. Users can disable registry install counts in Settings. The
stats endpoint may use IP addresses for short-lived rate limiting. These events
must never include tenant identifiers, user identifiers, prompts, run results,
or Microsoft Graph data.

### Code signing

Required before public v1 release:
- **Windows:** EV certificate (~$400-600/yr), hardware token + cloud HSM for CI signing, or a Microsoft Store signing path. Until one is ready, CI may build AppX packages for validation, but AppX files are not published as workflow artifacts or release assets.
- **macOS:** Apple Developer Program ($99/yr) + notarization. Without notarization, Gatekeeper blocks the app.
- Total: ~$500-700/yr, owned by the OpenAdminOS UG entity.

The build pipeline must accept signing as a step from day one — even if signing certs aren't acquired yet, the GitHub Actions workflow should have placeholder signing steps that no-op until certs are configured.

---

## 3. Design system

### Tokens (from `docs/mockups/_design.css`)

```
--bg-0: #0a0c10        Background base (darkest)
--bg-1: #0e1117        Sidebar, titlebar
--bg-2: #151a22        Cards, panels
--bg-3: #1c222c        Hover, raised
--bg-4: #232a36        Highest elevation

--text-0: #e6e9ef      Primary text
--text-1: #a8b0bd      Secondary text
--text-2: #6c7484      Tertiary / labels
--text-3: #4a5160      Disabled / hints

--border: #232a36
--border-strong: #2e3744

--accent: #00d4ff      Electric cyan — interactive, focus, active states
--accent-dim: #0891a8
--accent-bg: rgba(0, 212, 255, 0.08)

--success: #4ade80     Green — success, "local" indicators
--warning: #fbbf24     Amber — write operations, attention
--danger: #f87171      Red — errors, destructive
--purple: #a78bfa      LLM reasoning, "thinking" blocks
```

### Typography

- **UI:** Geist (with system fallbacks)
- **Code, IDs, telemetry, run IDs, JSON:** JetBrains Mono
- Base size: 13px (denser than typical web — admins want information density)
- Line-height: 1.5
- Letter-spacing: -0.005em on UI text

### Density principle

Closer to portal/IDE density than to consumer-app density. Compare to:
- ✓ Linear, Vercel dashboard, GitHub
- ✗ Notion, Stripe (too airy for this audience)

### Components used across screens

These are visible in the mockups and need to be built as proper React components:

- **Sidebar nav** with collapsible sections
- **Status strip** (4 cells: tenant, LLM, active runs, data residency) — appears at top of every main screen
- **Agent card** with read/write tag, verified/community badge, recent run indicator
- **Run timeline** (stepped pipeline visualization)
- **Telemetry strip** (used in live run modal)
- **Activity feed** with two modes: plain language / raw logs
- **Reasoning block** (purple-accented, for streaming LLM thoughts)
- **Tabs** (Activity / Logs / Reasoning pattern)
- **Pills** (status indicators)
- **Tags** (`tag-read`, `tag-write`, `tag-verified`, `tag-community`)
- **Toggle switches**
- **Modal overlay** (used for live run, diff confirmation, settings)
- **Mac-style traffic light titlebar** (Windows controls equivalent on Win)

### Trust messaging consistency

The phrase "Local-only · No data leaves this device" appears in multiple places. It is a **single source of truth** — when the user selects a hosted LLM, every instance of this messaging must flip simultaneously to honestly state where data goes (e.g., "Anthropic API · US"). Implement this as a single derived state, not as duplicated copy.

The cost cell follows the same pattern: green `$0.00 local` for local providers, real cost numbers for hosted.

---

## 4. UX decisions (locked)

These were debated and decided. Don't relitigate without explicit reason.

| Decision | Choice | Rationale |
|---|---|---|
| Live run view | Modal overlay over dimmed app | Focus on the active run; doesn't compete with other UI |
| Write-mode agent confirmation | Always pause for diff, every time | Trust requires no exceptions |
| Activity stream default | Plain language with raw-log toggle | Admins want comprehension first, debug detail on demand |
| Default LLM provider | Ollama (local) | Trust positioning starts with the default |
| Tenant/prompt/run/error telemetry default | Off | Local-first means local-first; registry install counts are a separate aggregate counter with a Settings opt-out |
| Update model for agents | Pin by default, explicit upgrade | Avoids surprise behavior changes mid-shift |
| Tenant scope expiry behavior | Block all agent runs until re-auth | No partial-trust states |
| Multi-tenant switcher | Color-coded, search-first, scope-guarded | MSPs may manage 100+ tenants |
| Failed write agent recovery | Show diff of partial state, suggest manual review | Never auto-rollback |
| Scheduled background runs | Per-user OS scheduler after tenant sign-in | Agents never run without a tenant; macOS uses LaunchAgent, Windows uses Task Scheduler |
| Run notifications | Manual runs notify only when app is not focused; scheduled runs follow per-agent notification preferences | Admins get background completion/failure visibility without duplicating visible manual-run state |

macOS notification caveat: Electron 42 uses Apple's `UNNotification` framework. Native notifications require a code-signed app bundle on macOS; unsigned `electron .` dev runs can fail to deliver notifications even when `launchd` successfully runs the scheduler. The app must listen for native notification `failed` events so this is visible during development. Production verification must be done from the signed/notarized DMG.

---

## 5a. v0.1 — Private preview showcase

The first shippable milestone. Goal: a polished Electron app that visually represents the full product vision, runs one agent end-to-end against synthetic data, and is paired with a public landing page with download, GitHub, trust-model, registry, and write-confirmation proof points. Built to generate screenshots, demo videos, downloads, and GitHub interest — not to be production-deployable against real tenants.

### What v0.1 includes

- Electron app shell (Win + Mac, Linux best-effort) with the full design system
- All 8 mockup screens implemented as real React routes (visual fidelity matching `docs/mockups/`)
- 2 new screens designed and built: registry browse (`09-registry.html`) and empty states (`10-empty-states.html`)
- LLM provider abstraction with Ollama and OpenAI Codex providers. Ollama streams locally; OpenAI Codex uses the local Codex CLI and returns the final assistant message.
- One sample read-only agent runnable end-to-end against synthetic Graph data
- Public marketing site at openadminos.com with download, GitHub, product screenshot, trust-model, registry, and write-confirmation sections
- Hero screenshots (in README + landing page) and a demo video

### What v0.1 deliberately defers

- Other LLM providers (LM Studio, Anthropic-via-Claude-Code, Azure OpenAI)
- Write agents and diff confirmation behavior (UI built for screenshots, no real writes)
- GitHub-backed registry (registry browse uses static JSON in v0.1)
- Persistent SQLite (in-memory + localStorage acceptable for v0.1)
- Code signing (build pipeline ready; certs deferred)
- Auto-update
- Audit log export and advanced notification routing — v1.0 territory

### v0.1 acceptance criteria

1. Fresh clone → `pnpm install && pnpm dev` opens the Electron app in under 30 seconds.
2. All 10 screens reachable from sidebar/keyboard, visually matching mockups within 95% fidelity.
3. With Ollama running locally and a model installed: clicking "Run" on the sample agent streams real LLM output into the live run modal, completes successfully, displays structured results.
4. With Ollama not running: a designed error state appears with the correct recovery instruction (`ollama serve`).
5. Trust messaging flips correctly when toggling the LLM provider between local and (mocked) hosted in §07.
6. openadminos.com is publicly resolvable and presents a working download/GitHub CTA with the local-first trust model visible on the page.
7. README includes a hero screenshot taken from the running app.
8. A 60–90s demo video is publicly viewable.

The detailed phased plan to reach these acceptance criteria lives in `tasks/todo.md`. SPEC.md owns *what*, `tasks/todo.md` owns *how* and *when*.

---

## 5b. Bundled agent philosophy

The agents that ship in this repo are the platform's first impression. If they read like "PowerShell with an LLM blurb tacked on" — *count rows, summarise the count* — the platform looks redundant. So the bundled set is organised around a tiering decision that's load-bearing for the trust story.

### Three tiers

1. **Investigators** (`tier: agent`, `mode: read`, multi-source). The killer category. Correlate two or more Graph sources and let the LLM reason about the combination. Examples: `sign-in-failure-explainer` clusters failures by root cause; `risky-sign-in-triage` classifies Entra risky-user records with per-item reasoning and must not imply raw sign-in evidence unless a future correlation step supplies it; `tenant-change-audit` separates routine audit entries from noteworthy ones. No script can produce these outputs.

2. **Advisors** (`tier: agent`, `mode: read`, posture/policy reasoning). Take a complex policy set or scoring catalogue and produce judgment. Examples: `conditional-access-explainer` reviews Conditional Access coverage, disabled/report-only controls, broad exclusions, stale policies, grant/session controls, legacy auth, device compliance, guest access, and risky-user/sign-in coverage; `secure-score-prioritizer` ranks recommendations by tenant shape and effort; `dormant-app-registrations` reviews app registrations using exposure, credential, permission, redirect URI, app-role, publisher-domain, and age signals, then separates cleanup candidates from apps that need owner verification before deletion.

3. **Cleanup with judgment** (`tier: agent`, `mode: write`). Multi-criteria reasoning *before* the diff confirmation. The LLM produces per-item rationale that lands in the diff modal so the typed confirmation is something the admin can actually approve in good conscience. Example: `stale-guest-cleanup` filters guests by inactivity, generates a one-line per-guest rationale, and disables on confirmation. Pairs an investigator's selection logic with a write action's deliberate gating.

### Reports still appear as agents

Single-source LLM-narrated report entries (`compliance-overview`, `os-update-posture`, `tenant-health-report`, `user-license-overview`) are less powerful than investigator-style agents, but the product does not split them into a separate top-level Agent Hub surface. Users should not have to understand internal taxonomy before installing something useful. Agent Hub renders one catalog and relies on badges, descriptions, and mode/category filters to explain what each entry does. Posture agents must not invent lifecycle or support status from version strings alone; they can identify concentrations, outliers, stale inventory, and review targets, but claims like "unsupported" need explicit supplied evidence.

### Why the bar matters

Anyone evaluating the platform looks at the bundled catalog first. If the first impression is simple row counts with an LLM blurb, the verdict is "fancier Get-MgUser." If the first impression is investigators that correlate sign-in logs with CA policies and tell you which user's failure is the CA misconfiguration, the verdict is "this could replace a chunk of my morning." The catalog should make those stronger agents easy to find without splitting the page into separate product concepts.

### The DSL needed to support investigators

Three step kinds carry the bundled investigators today:

- **`graph`** — load one or more Graph endpoints into named outputs.
- **`transform`** — reshape (count-by-field, filter-by-age, group-by-field, sort-by, correlate-stale-devices). Single source per transform; multiple transforms stacked is how multi-source correlation gets expressed today (each transform reads from a prior step by id). Destructive stale-device plans are conservative by default: the offboarding correlation transform skips in-flight Intune devices and can exclude personal/BYOD devices before any retire action is built.
- **`llm`** — read any subset of prior step outputs via the templating engine. Multi-input reasoning is achieved through the template, not a separate `inputs:` block.
- **`map`** *(new in v0.2)* — iterate a source array and run an inner sub-pipeline per item. This is the step that enables per-item LLM reasoning (risky-sign-in triage classifies each entry individually with shared context). The map step's output is the array of last-sub-step outputs from each iteration.

Any future agent that needs *per-row* LLM judgment uses `map`. Any future agent that needs *correlation across sources* stacks graph + transform + llm with template references.

---

## 5. Pre-release roadmap

### Critical (blocks v1.0)

These must exist and work well before any public release.

1. **First-run onboarding** — 3 steps: tenant connection → LLM provider → first agent. <90 seconds from installer to first successful run.
2. **MSAL consent flow** — Lawyer-grade transparency about Graph scopes requested. Read scopes only by default; write scopes requested per-agent at install time.
3. **LLM provider configuration** — All 5 providers, test connection, model dropdowns populated by querying the provider, per-agent overrides.
4. **Diff confirmation for write agents** — Side-by-side before/after, scope summary, typed confirmation for destructive actions.
5. **Error and failure states** — Designed states for: auth expired, Graph throttling, Ollama unreachable, model JSON validation fail, missing scope, hosted quota exceeded, tenant drift, network offline. (Reference: `docs/mockups/06-error-states.html`.)
6. **Empty states** — Zero agents installed, zero runs, zero tenants. These teach new users what the product is for.
7. **Registry browse** — Search, filter (author, mode, model requirements), install, signing/verification status, screenshots, changelog.
8. **Multi-tenant switcher done properly** — Search, color-coding, "currently scoped to" badges, scope guard against running an agent on the wrong tenant.
9. **Teams connector (graph-delegated)** — first connector to validate the abstraction. Channel + chat picker, post-message capabilities, Teams scopes folded into the MSAL consent flow, trust messaging integrated with the status strip. See §2 Connector abstraction.

### Important (in v1.0, doesn't have to be perfect)

- Scheduled runs are available for installed agents. The UI creates the per-agent recurrence; once at least one Microsoft tenant is connected, OpenAdminOS can register a per-user OS scheduler so due runs continue while the UI is closed. macOS uses `~/Library/LaunchAgents/com.openadminos.scheduler.plist`; Windows uses Task Scheduler. Jobs still run as the signed OpenAdminOS app for the logged-in user, use the persisted MSAL token cache, write results to local history, and do not run when the machine is off or no user session exists. The Schedules view prioritizes active schedules, next run, last run, and recent scheduled activity. OS registration and scheduler errors are shown as compact remediation notices only when the user needs to act.
- Notification routing (per-agent: OS notification / email / connector). Built on the Connector abstraction; the Teams connector is the first egress target wired through this surface. Agents can save a Teams delivery rule that posts terminal run reports to either the connector default channel or a per-agent channel, with manual/scheduled, success/failure, and changed-only controls. Saved delivery rules are explicit approval to post without another prompt. Basic OS run-completion/failure notifications already exist. Each schedule can opt into success notifications, failure notifications, and "only when findings change." Scheduled run records are stamped with `changeState: new | changed | unchanged` by comparing the latest scheduled output to the prior successful scheduled output for the same agent.
- Agents should not hard-code routine Teams posting when per-agent delivery rules can handle it. Connector steps remain appropriate when the connector call is the agent's core behavior; recurring report delivery belongs to the installed-agent delivery settings so admins can route the same result locally, to Teams, or both.
- Manual agent runs open a preflight review before queueing. It shows the active tenant, provider residency, model, mode, and Graph scopes. It blocks when no tenant is active, warns when hosted providers are selected, and flags scopes that may trigger Microsoft incremental consent.
- Settings → About includes a local release-readiness panel for support and demo prep: app version/build mode, notification availability, OS scheduler registration, active tenant, active LLM, Codex/Ollama detection, and registry state. These diagnostics are local UI state, not telemetry.
- Agent report streaming is part of the run experience. LLM providers should expose `RunLlmApi.stream()` where possible; the runtime publishes best-effort `RunRecord.liveSummary` while the current LLM step is generating, and clears it when the terminal `summary` is written. Ollama streams through its native chat API. OpenAI Codex runs through `codex exec --json` and consumes message deltas when the installed CLI emits them, falling back to the final assistant message when the CLI only emits completion events.
- Run history with filters (agent, tenant, date, status)
- Audit log export (JSON/CSV with cryptographic timestamps for compliance buyers)
- Keyboard shortcuts (⌘K palette, ⌘R rerun, ⌘/ search, ⌘? help)
- Agent permissions inspector (browser-extension-style permission screen pre-install)
- Update / version management (pin by default, explicit upgrade, changelog visible)
- Logs export and retention policy (where stored, how big, when rotated)

### Designed before launch (not strict blockers)

- **Second connector: ServiceNow (`external` auth)** — proves the Connector abstraction generalizes across trust boundaries. Instance URL, keychain credentials, "data leaves your tenant" trust messaging. Designed alongside Teams; ships post-v1.0.
- Agent signing / verification (registry supply-chain integrity)
- Sandbox / dry-run mode for read agents (preview Graph calls before executing)
- Cost budgets & rate limits (per-agent or per-day spend caps for hosted LLMs)
- Localization framework (DE/NL/FR are the priority markets after EN)
- Accessibility audit (WCAG AA contrast, keyboard nav, screen reader labels)
- Opt-in product analytics (Posthog self-hosted or similar; aggregated, never per-tenant)
- Opt-in crash reporting (Sentry-equivalent for app crashes only)
- Auto-update channel (`electron-updater` against signed releases; needed for security patching)
- Offline / partial connectivity behavior (retry, cached state, resume on reconnect)

### Polish (v1.1+)

- Tooltips and empty-state coaching
- Light theme + high-contrast theme
- Visual diff for complex objects (CA policies, conditional access)
- Run comparison ("what changed between last week and this week?")
- Sharing / collaboration (deep link to run, PDF export — TenantPDF integration)
- Agent authoring DX (`openadminos agent init` scaffold, local dev/test mode, publish flow)
- Marketplace metadata (screenshots, video demos, changelog, support links per agent)
- Health dashboard (aggregated trust score across all agents on a tenant)

### v0.2.1 candidate focus

The next patch-level candidate is ecosystem quality: make **Build your own Agent** reliable enough for admins who do not want to hand-edit YAML, and add a safe **Share with the community** path for user-authored agents.

Build your own Agent starts as a guided natural-language authoring flow, not a blank YAML editor. The production-grade pass collects target area, intent, expected output, and schedule intent before drafting; validates the generated manifest with the same schema and Graph catalogue checks used by save/install; attempts one LLM repair pass using the exact validation errors; and keeps an editable YAML review pane with an explicit Validate action. Save & install stays disabled after manual edits until the edited manifest validates again.

The drafter must understand the current Agent Template surface, not just the original linear `graph -> transform -> llm` shape. It should know about settings, scheduled triggers, `map` for per-item reasoning, multi-input LLM steps, generic `graph-write`, optional Teams connector steps, Entra tier hints, OData string query values, and reserved slug avoidance. User-authored drafts start at `0.1.0`; validation should detect slug collisions and suggest an available alternative before save. Existing user-authored agents can be reopened in the builder, edited in place, and saved while preserving install settings, schedule, delivery rules, and run history.

Before saving, the builder exposes a local preflight. It verifies active tenant, connected provider, schema/Graph catalogue validity, connector declarations, scopes, settings, and write-confirmation shape without running tenant queries or applying writes. Exporting creates a local folder with `manifest.yaml`, `README.md`, and `metadata.json`; tenant data, prompts, run history, provider settings, tokens, and secrets are excluded.

Community sharing must use the existing repo-as-registry trust boundary. A local agent is not uploaded directly into Agent Hub. The first submission path creates a public `[New Agent]` GitHub issue through the OpenAdminOS web API using server-side GitHub credentials; the desktop app never receives or stores GitHub tokens. The web API does not trust the desktop-provided issue body as proof of QA: it independently parses `manifest.yaml`, validates slug/mode/category/version/LLM/write-confirmation basics, parses `metadata.json`, scans the submitted files for secret-like values, and rebuilds the public issue body server-side. The issue contains metadata, intake checks, generated README, manifest YAML, and exclusion statements for maintainer review. Duplicate open submissions for the same title are updated with the latest server-rebuilt body and a new manifest digest comment rather than silently returning stale package content. A later automation may turn reviewed issues into upstream-ready `agents/<slug>/` pull requests, but the public Hub only sees the agent after CI validates it and maintainers merge the PR. Submissions must never include tenant data, prompts, run results, local settings, provider credentials, or secrets.

For v0.2.1, community sharing targets only the public OpenAdminOS repo intake. Private registry forks, internal company submissions, and private agent sharing/import flows are intentionally out of scope for this candidate.

Until sandboxing/signing is designed, the default community-sharing format is YAML Agent Templates plus README/fixtures/metadata, not arbitrary TypeScript execution. The pre-submit checks should mirror registry CI: schema validation, Graph endpoint/scope validation, LLM-step requirement, write-confirmation requirement, connector declaration checks, README presence, and explicit flags for high-risk scopes, destructive writes, or external egress.

The community-submission UI is a guided modal, not a raw GitHub form. It collects public metadata, runs a local QA gate with pass/fail/warn rows, gives admins exact fixes for blocking failures, and enables submission only after blocking checks pass. Warnings such as high-risk scopes, write actions, and connector egress remain visible in the issue for maintainer review. The web API rate-limits submissions, reuses duplicate open `[New Agent]` issues, and the desktop stores the submitted issue URL locally so the agent detail page can show "Submitted for review" without implying Agent Hub publication.

Registry trust hardening for v0.2.1 keeps the same repo-as-registry boundary. Installed public agents carry provenance (`manifestUrl`, registry ref, manifest SHA-256 when available, installed version, installed time). Registry updates are no longer one-click applies when trust boundaries move: added Graph scopes, write-action changes, new connector egress, or a raised `minAppVersion` produce an explicit review modal before the desktop writes the new manifest override. Registry QA also lints public README/manifest content for secret-like values, tenant identifiers, personal data, unsupported guarantee language, duplicate slugs, invalid semver, missing README files, and index coverage before `agents/index.json` is accepted.

Every public registry agent declares `descriptor.minAppVersion`. The desktop keeps agents requiring newer OpenAdminOS versions visible in Agent Hub, but marks them as incompatible and blocks install, run, and update application with "Update OpenAdminOS" copy. Registry fetch must not hide newer agents, because hiding them makes compatibility look like a missing-catalog problem instead of an app-upgrade problem.

Registry-sensitive paths are protected by `.github/CODEOWNERS`: agents, stats, schemas, QA gates, registry generation, SDK/runtime trust surfaces, desktop registry/update IPC, and public community-submission intake all request maintainer review. GitHub branch protection must enable "Require review from Code Owners" on `main` for this to become an enforced merge requirement.

Registry QA is expected to run cleanly for bundled agents. When the upstream Microsoft Graph search/sample indexes miss valid collection endpoints or exact resource docs, the QA package may carry narrow local metadata overrides for bundled endpoint permissions, select-property checks, and curated sample backing. Those overrides must stay scoped to endpoints used by shipped agents and must not weaken schema, scope, write-confirmation, or connector validation.

### Systemic concerns to track

- **Trust messaging consistency** — single source of truth across all surfaces (see §3)
- **Hosted-provider flip UX** — the moment an admin switches from local to hosted is the most important UX moment in the app
- **Documentation surface** — in-app help, web docs, GitHub issues, Discord — needs a coherent answer before launch

---

## 6. Mockups

`docs/mockups/index.html` is the click-through prototype index. Open each screen in a browser to see the design language in motion.

| File | Screen | Status |
|---|---|---|
| `01-onboarding.html` | First-run setup (tenant → LLM → first agent) | ✅ Done |
| `02-msal-consent.html` | Graph permissions screen | ✅ Done |
| `03-agents-grid.html` | Home / agents list | ✅ Done |
| `04-live-run.html` | Live run modal overlay | ✅ Done |
| `05-diff-confirm.html` | Write-agent diff confirmation | ✅ Done |
| `06-error-states.html` | 8 error patterns reference | ✅ Done |
| `07-llm-provider.html` | LLM provider configuration | ✅ Done |
| `08-tenant-switcher.html` | Multi-tenant management | ✅ Done |
| `09-registry.html` | Community agent registry browse | ⏳ TODO |
| `10-empty-states.html` | First-time user empty states | ⏳ TODO |

When implementing screens in production code, port the design tokens from `_design.css` to the production app's theme system (Tailwind config or CSS variables in the global stylesheet). Build the components listed in §3 as proper React components, not as one-off implementations per screen.

---

## 7. Open questions

These are explicitly unresolved. Don't pick a default without asking.

- **Sub-branding inside the product**: OpenAdminOS is the project name; should the desktop app's window title also say "OpenAdminOS," or is there a layer of brand inside the product (e.g., "OpenAdminOS by OpenAdminOS")?
- **Agent signing**: who signs? Author signs and we verify? We counter-sign trusted agents? Implications for the "verified author" badge.
- **Hosted-LLM API key storage**: OS keychain is obvious for personal use, but what about MSP scenarios where multiple admins share a workstation? Per-user or per-workstation?
- **Telemetry, if ever added**: what's the minimum viable opt-in design that doesn't betray the local-first promise?
- **Registry moderation**: when an agent is malicious or broken, what's the takedown / flagging process? Who decides?

---

## 8. Out of scope (for now, possibly forever)

- Hybrid AD agents (the audience and patterns are different enough to be a separate product)
- General Intune/Entra admin consulting features (this is an agent runner, not an admin tool)
- A web-hosted SaaS version (would betray the local-first positioning)
- Agents for non-Microsoft platforms (AWS, GCP) — possibly later, but the v1 thesis is depth-in-Microsoft, not breadth
- Agent-authoring inside the desktop app (authors use their own editor + the SDK; the app is a runtime, not an IDE)

---

## 9. Adjacent products in the OpenAdminOS portfolio

For context — these exist or are in flight, and may interact with OpenAdminOS over time:

- **TenantPDF** (tenantpdf.com) — hosted SaaS for branded tenant documentation PDFs. Future integration: OpenAdminOS run reports could export via TenantPDF.
- **IntuneDocumentation** (legacy) — frontend PDF generation tool.
- **IntuneGet-FrontBackend** (legacy) — multi-tenant auth experiment.
- **IntuneTUI** (deprecated) — terminal-based Intune tool. The lesson from this project drove OpenAdminOS' decision to use a desktop GUI instead of a terminal — admins are not developer-y enough for TUIs as a primary surface.

OpenAdminOS is the flagship community project. The others are either narrow paid products (TenantPDF) or instructive prior art.
