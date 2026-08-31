# OpenAdminOS — Product Specification

> Source of truth for product decisions, architecture, design system, and roadmap. Read this before writing code. If reality diverges from this doc, update the doc as part of the same change.

---

## 1. What we're building

**OpenAdminOS** is an open-source desktop platform for Microsoft 365 administrators (initially Intune & Entra) to run AI agents against their tenants. Agents are TypeScript modules contributed by the community, run locally on the admin's machine, and operate against the tenant via Microsoft Graph.

The product is local-first: by default, tenant data and LLM prompts never leave the user's device. The user can opt into hosted LLM providers (Anthropic, OpenAI, Azure OpenAI), and when they do, the UI honestly reflects that data leaves the device.

### Distribution surface

- **Desktop app** (Electron; Windows x64 signed NSIS installer, macOS signed/notarized, Linux x64 packages), the only end-user surface

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
│   └── desktop/              # Electron main + preload + renderer (Vite + React)
├── web/                      # Public marketing site (openadminos.com) — Next.js
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
│   ├── gitbook/              # Public GitBook docs source
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

- **Developer velocity is the primary constraint.** Pure TS/Node end-to-end. No Rust toolchain, no two-language IPC bridge. MSAL Node, Electron's built-in `node:sqlite`, OS keychain storage, and `electron-updater` all work in the main process. `better-sqlite3` was avoided for the v0.2.2 chat/cache layer because it did not rebuild cleanly against Electron 42's Node/V8 ABI in local verification.
- **MSAL is a desktop dependency as well as a runtime dependency.** Electron main imports `@azure/msal-node` types directly for tenant state, so `apps/desktop` declares the package explicitly. This keeps npm and pnpm workspaces from resolving separate MSAL type identities between Electron main and `@openadminos/runtime`.
- **Open-source contributor pool.** Community contributions (agents and UI) come from JS/TS devs. Tauri's Rust shell raises the bar for any contributor who wants to fix more than an agent.
- **UI fidelity.** Chromium everywhere = identical rendering on Win/Mac/Linux. The design language (dense, dark, custom scrollbars, GPU-accelerated transitions) is more reliable on Chromium than on platform-native webviews.
- **Proven path for this category.** Claude Desktop, VS Code, Linear, Slack, Figma, 1Password — all Electron. The "Electron is bloated" critique mattered more on 8GB-RAM machines than on modern admin workstations.
- **Electron fits the runtime model.** The architecture supports `node-pty`, long-lived subprocess work, and Node-based provider adapters directly.

The cost we accept: ~80–150MB installer size (vs ~5–10MB Tauri), ~150–250MB idle memory per window. For an IT-admin tool on managed devices this can pinch corporate deployment limits, but it's not a blocker. Trust posture is *architectural* (no tenant-content telemetry, local-first, write confirmation), not framework-derived.

### Desktop architecture

OpenAdminOS is **one TypeScript monorepo that ships a polished Electron desktop app**, with a clean provider-adapter pattern and shared schema package. Preserve the directory boundaries, contracts package, and adapter abstraction when extending the runtime or renderer.

### Public documentation model

Public documentation is GitBook-synced from `docs/gitbook`, with the repository root `.gitbook.yaml` setting `root: ./docs/gitbook`. Internal product artifacts such as this spec and HTML mockups stay under `docs/` but outside the GitBook root.

Agent documentation is deterministic. `npm run docs:generate` refreshes `agents/index.json` and regenerates GitBook pages under `docs/gitbook/generated` from `agents/*/manifest.yaml` plus the registry index. Generated pages include the agent catalog, per-agent pages, the Microsoft Graph scope matrix, the write safety matrix, and the LLM provider matrix. Generated pages should not be edited manually; update the manifest or generator instead. CI jobs that verify generated docs must check out full Git history because the generated `Last changed` fields use path-specific commit metadata.

The docs GitHub Action checks generated docs on pull requests and, after commits to `main`, opens a documentation update PR if generated output changed. It does not silently publish LLM-authored documentation to `main`.

### Marketing website canonical host

The product domain remains `openadminos.com`. The deployed marketing site
currently canonicalizes to `https://www.openadminos.com` because the Vercel
domain configuration redirects the apex host to `www`. Website metadata,
canonical tags, Open Graph URLs, robots.txt, sitemaps, structured data, and
`llms.txt` must use the deployed canonical host. User-facing brand copy may still
refer to `openadminos.com` as the project domain.

Search appearance assets must be crawlable from the production host. The
marketing site should expose a stable PNG favicon of at least 48x48 pixels, a
180x180 Apple touch icon, and `WebSite` structured data with `name:
OpenAdminOS` plus `alternateName: Open Admin OS` so Google has consistent site
name inputs. `Organization.url` and `WebSite.url` should use the canonical
homepage URL with a trailing slash, and the apex host should permanently
redirect to `https://www.openadminos.com/`. The evergreen homepage should avoid
`dateModified` structured data unless a user-visible "last updated" date is
intentionally shown, so Google is less likely to frame the homepage as a recent
article-style result. The marketing robots.txt should explicitly allow major AI
search crawlers while keeping API routes blocked.
`SoftwareApplication` structured data must match the current downloadable
platforms. Signed Windows builds are now produced by release CI, so Windows may
be advertised; the accompanying copy must stay honest about SmartScreen (see
"Code signing" below). Marketing download surfaces present Windows as a signed
x64 NSIS `.exe` installer, macOS as a
signed/notarized DMG for normal installs plus a signed/notarized PKG for managed
deployment, and Linux as x64 packages with AppImage for broad desktop use,
`.deb` for Ubuntu and other Debian-family systems, `.rpm` for Fedora/RHEL-compatible
systems, and a visible inline SHA-256 hash for each package plus a
`SHA256SUMS.txt` verification link. Ubuntu and other Debian-family installs also
have a GitHub Pages-backed apt repository at
`https://repo.openadminos.com/debian`, published from release CI and signed with
the OpenAdminOS Linux archive key.
The marketing site exposes provider identification at `/legal-notice`, linked
from the footer alongside privacy and terms. `/impressum` remains a redirect
alias. The page title uses the international label "Legal notice" while the page
copy explicitly identifies it as the Impressum / provider identification under
§ 5 DDG. The legal operator is OpenAdminOS, Winterhuder
Weg 29, 22085 Hamburg, Germany, reachable at `support@openadminos.com`. The
listed managing director is Ugur Koc. The register court/register number and VAT
ID if issued still need confirmation before the provider identification is
legally complete.
Marketing headers use a compact mobile stack menu below the desktop breakpoint.
The trigger sits in the same row as the OpenAdminOS logo and the menu closes on
outside click, Escape, or link activation.
Definition-style GEO copy should live in normal visible page content such as
the "What is OpenAdminOS?" FAQ, not in standalone SEO cards or hidden text.
FAQ content may use native `<details>/<summary>` accordions when the answer
text is server-rendered in the initial HTML and remains directly accessible to
users. Keep the primary product definition expanded by default.
The marketing navbar keeps a compact primary set: Blog, Documentation, GitHub,
and Download. The Intune use-case page, registry page, and trust-model page
remain published and indexable even though they are no longer primary navbar
items, because they target durable admin search and product-evaluation topics.
The examples gallery at `/examples` is also a secondary marketing page, with
copyable Build your own Agent prompts grouped by read investigations, confirmed
write plans, and connector-backed delivery examples.
The marketing homepage uses a seven-section structure: hero ("AI agents for
your Microsoft 365 tenant. Run locally, approved by you."), a pre-rendered
product demo video, a traction strip, a three-step "How it works" section, the
write-gate diff demo, the top most-installed registry agents, and open
source + FAQ + final CTA. The traction strip and CTA star count only render
real numbers — GitHub stars from the unauthenticated repo API (revalidated
hourly) and agent/install counts from the synced `public/stats/agents.json`;
when either source is unavailable the cell is omitted, never faked. Registry
agent display metadata (names, descriptions, mode, scopes) is curated in
`web/src/lib/stats/summary.ts` because repo-root `agents/index.json` is not
available inside the `web/` Vercel build. The demo video is rendered offline
from the top-level `remotion/` project (not part of the npm workspace, never
installed on Vercel) into committed `web/public/videos/` assets; the embed is
a muted autoplay loop that falls back to a static poster when
`prefers-reduced-motion` is set. The composition is a faithful recreation of
the real desktop app UI — it uses the design tokens from
`apps/desktop/src/styles/globals.css` (warm stone palette, amber accent) and
mirrors the actual chrome (sidebar, tenant card, status strip) against
`web/public/openadminos-app.png`; it must not drift into an invented visual
style.
Blog articles live as Markdown in `web/content/blog/`, are server-rendered into
the Next.js blog routes at build time, are listed in the sitemap and `llms.txt`,
use `BlogPosting` structured data, and answer real Microsoft 365 admin
questions without generic AI-hype language. Markdown sections titled "Related
reading" and "LinkedIn draft" are editorial notes and are not rendered on the
public article page. Blog frontmatter may include `seo_title` when the on-page
H1 should stay descriptive but the browser title should be shorter for search
display. Public article pages show an "OpenAdminOS editorial" byline and author
summary until a named author profile is intentionally added. Each public blog
post has an article-specific 1200x630 preview image under `web/public/blog/og/`
that is used in Open Graph metadata, Twitter metadata, JSON-LD, article headers,
and blog index cards. Because Vercel mirrors `web/.next` to the repository root
for finalization, the blog loader must tolerate both `web/` and repo-root
working directories, and the Vercel postbuild mirror must expose traced
`web/content` Markdown files and missing website `node_modules` packages at
repository-root paths.

The Vercel project is configured with `web/` as its Root Directory. As of the
June 2026 Vercel Git Integration behavior, successful Next.js builds for
subdirectory projects can fail during finalization while looking for
repository-root `.next` files such as
`.next/routes-manifest-deterministic.json` and
`.next/server/prefetch-hints.json`, plus traced runtime dependencies under
repository-root `node_modules`. The marketing site `postbuild` script mirrors the
generated `web/.next` build output to the repository-root `.next` path and links
repository-root `node_modules` to `web/node_modules` only when `VERCEL` is set.

The public marketing website uses Plausible Analytics from `plausible.io` for
aggregate website usage measurement. This is limited to the `web/` marketing
pages. The desktop app must not load Plausible or send tenant data, prompts,
run results, analytics events, support diagnostics, tokens, provider credentials,
or Microsoft Graph payloads through website analytics. Privacy copy must keep
the website analytics boundary separate from the desktop app's no tenant telemetry
guarantee.

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

Concrete providers, required for v1 unless marked optional:
- `OllamaProvider` (local, default)
- `AppleFoundationProvider` (local, macOS-only optional provider)
- `LMStudioProvider` (local)
- `AnthropicProvider` (hosted)
- `OpenAIProvider` (hosted)
- `AzureOpenAIProvider` (hosted)

Current implementation note: OpenAI support is delivered through the user's
locally installed Codex CLI (`codex`) rather than a stored OpenAI API key.
OpenAdminOS probes the CLI and `~/.codex/auth.json`, then invokes
`codex exec --ephemeral --skip-git-repo-check -s read-only` for agent LLM
steps from a temporary directory with a minimal allowlisted environment: path,
home, proxy, certificate, temp, locale, and `CODEX_HOME`. It does not pass the
desktop process environment wholesale. Codex does not force a model by default;
it uses the user's configured account-supported default unless a run later pins
an explicit model. This preserves the "no vendor API keys in OpenAdminOS" trust
boundary, but tenant prompts still leave the device because the selected model
is hosted.
The model picker is populated from Codex's local `models_cache.json`, with
`config.toml` supplying the default model when present.
Selecting a model under an inactive provider also makes that provider active
for future runs; model pinning must not leave the visible active provider on a
different provider. Overview surfaces such as Agents, StatusStrip, Settings,
and Intune Chat show the active provider plus the selected default model for
that provider. Queued run surfaces show the provider and model pinned on that
run, even if global defaults later change.
Provider settings include an explicit smoke test action for connected providers;
the test runs a tiny completion and reports the model and response time. This is
intentionally visible because hosted/local provider trust is a core product
decision, not hidden plumbing.

Anthropic support is delivered through the user's locally installed Claude Code
CLI (`claude`) rather than a stored Anthropic API key. OpenAdminOS probes the CLI
version and Claude Code auth status, requires Claude Code 2.1.200 or newer, then
invokes non-interactive print mode with session persistence off, Claude Code
customizations disabled, MCP config locked down, and all Claude Code tools
disabled. System prompts are passed with Claude Code's system-prompt flag rather
than stored in OpenAdminOS. This preserves the "no vendor API keys in
OpenAdminOS" boundary, but tenant prompts still leave the device because the
selected Claude model is hosted by Anthropic.

Azure OpenAI support is a direct API-key provider, not a local CLI bridge.
Settings -> LLM Providers collects the Azure OpenAI endpoint URL, deployment
name, API version, and a write-only API key. The renderer can read only
non-secret configuration plus a `hasKey` boolean; stored keys are never
displayed back to the renderer. The host stores the key encrypted with the
desktop OS secure-storage backend and sends it only to the configured Azure
OpenAI endpoint when Azure OpenAI is the active hosted provider. The provider
status becomes available after endpoint, deployment, API version, and key are
present; the Settings test action runs a minimal chat completion before admins
send tenant context.

Local-provider trust is endpoint-sensitive. Ollama is local only when the
configured endpoint is loopback (`localhost`, `127.0.0.0/8`, IPv6 loopback, or
IPv4-mapped loopback) or a Unix socket. If `OPENAGENTS_OLLAMA_URL` points at a
LAN, internet, wildcard, invalid, or otherwise non-loopback endpoint, the
provider summary flips to external/hosted-style trust messaging and Intune Chat
requires hosted-provider confirmation before tenant context is sent.

LM Studio support uses its local OpenAI-compatible server at
`http://localhost:1234/v1` by default, with `OPENADMINOS_LM_STUDIO_URL` as the
development override. Like Ollama, LM Studio is local only when the configured
HTTP endpoint resolves to loopback. A LAN, internet, wildcard, or invalid
endpoint flips the provider to external trust messaging before tenant prompts
are sent.

Apple Foundation support uses Apple's on-device Foundation Models framework
through a small signed macOS helper binary bundled with the Electron app. The
provider is local-only when the helper talks directly to
`SystemLanguageModel.default`; it must not route prompts through Siri,
Shortcuts cloud actions, ChatGPT, Private Cloud Compute, or any hosted Apple
service. The provider is available only on compatible Macs with Apple
Intelligence enabled and the on-device model downloaded. The helper is the
only native exception to the TypeScript-only provider stack because the
Foundation Models framework is not directly callable from Electron main.
OpenAdminOS reports this provider as unavailable on Windows/Linux; Windows AI
API support is a separate future provider. The helper is packaged under
`Contents/Resources/native/apple-foundation-helper/` and listed in
`electron-builder`'s `mac.binaries` so signed/notarized macOS builds sign the
extra executable along with the app bundle. Release packaging requires a
macOS 26/Xcode 26 runner so `FoundationModels.framework` is available at helper
build time.

Apple Foundation is a small-context provider. The runtime probes and displays
the model's context size and supported locales, rejects non-system model
overrides, clamps response token requests to fit the available session budget,
and surfaces token usage when macOS exposes exact token counting. Intune Chat
uses an Apple-specific compact answer-pack profile: fewer cached rows per
resource, fewer raw sample rows, and smaller response budgets while preserving
deterministic counts/findings. If the prompt still exceeds the on-device
context window, the provider fails with explicit recovery copy instead of a
generic model error.

Per-agent model overrides are required: an agent's manifest can specify a preferred model and the user can override it.

### Agent contract

**Every agent invokes the LLM at least once.** The model is load-bearing, not optional polish. Agent Template manifests MUST declare at least one step with `format: llm`; the runtime hard-fails any LLM step that is reached without a connected provider (no silent skipping), and `startRun` preflights the active provider before queueing. This is what makes an agent an *agent* and not just a Graph query — the deterministic transforms shape the data, but the model is the part that reasons and produces the headline the admin reads.

Concretely:
- The agent's `result.summary` should reference the LLM step's output (e.g. `{{ summarize.output.text | default("...") }}`), not a deterministic count template. The deterministic counts belong in `result.data` for structured rendering.
- Write agents use the LLM to *explain* the plan in plain language before the typed-confirmation prompt — they don't get a pass.
- If a write agent produces zero actions after applying its filters, the run completes as a no-op result. Typed confirmation is required for every non-empty write plan, but an empty plan must not be reported as a failure.
- If you genuinely don't need an LLM (e.g. a pure data export), this product is the wrong tool; reach for `Get-MgDeviceManagementManagedDevice | Export-Csv` or a similar deterministic script instead.

Microsoft Graph execution is beta-only for this project. The runtime and all
Graph-backed connectors call `https://graph.microsoft.com/beta`; continuation
URLs must remain on that exact HTTPS origin and beta path. Collection agent
steps treat an explicit manifest `$top` as a Graph page-size request and still
follow `@odata.nextLink` until completion or a hard safety ceiling is exceeded. Exceeding a safety
ceiling fails the run instead of presenting partial rows as tenant-wide
evidence. Idempotent reads can retry throttling and transient service errors;
non-idempotent POST operations never retry a generic 5xx response because the
server may already have applied the side effect. Server-directed retry delays
are capped at 60 seconds per attempt so a malformed header cannot park a run
indefinitely.

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

Agents bring data *in* from Graph. Connectors push results *out* — Teams channel, WhatsApp number, ServiceNow ticket, email, webhook. Without connectors an agent's findings stay on the admin's laptop; with them the right people see the right output where they already work. Connectors are the egress half of the agent contract.

**Status:** the type contract (interfaces, error classes, registry-augmentation pattern, `defineConnector()`) ships in `@openadminos/agent-sdk`. MSAL interactive sign-in is already wired up (see `packages/runtime/src/msal.ts`), so `graph-delegated` connectors have everything they need from the auth layer. Runtime injection, the Connectors sidebar entry, Microsoft Teams, WhatsApp Web, Outlook, Slack, Discord, and Signal are implemented. The v0.2.4 connector expansion is intentionally notification-only: these connectors send terminal run reports and do not read inboxes, chats, channels, messages, reactions, or files.

The design goal is to ship the contract once and never break it. Capability versioning, typed errors with explicit recovery semantics, runtime-supplied idempotency keys, and per-package plugin distribution are the four pillars that make that possible. Each one is non-negotiable before the first connector ships — retrofitting them after agents start consuming the API is what makes ecosystems brittle.

#### Auth source classes

Three classes, each with a distinct trust posture:

- `graph-delegated` — piggybacks on the active tenant's MSAL token; adds Graph scopes (Teams, Outlook, SharePoint, Planner). No new credentials, no second consent dance. Data stays inside the customer's M365 tenant boundary.
- `graph-application` — app-only consent via Resource-Specific Consent or per-resource installation. Deferred past v1.0; the interface accommodates it so we don't have to break agents to add it later.
- `external` — owns credentials in the OS keychain or a local auth session (WhatsApp Web, ServiceNow, Jira, Slack). Data leaves the tenant boundary; trust messaging must say so explicitly. External connectors implement a uniform setup surface where practical, but device-paired flows such as WhatsApp Web can expose a connector-specific QR step.

#### Capability kinds → confirmation tiers

Every capability declares a `kind` that maps to a confirmation tier. Mixing connectors with destructive Graph operations under one `mode: 'write'` flag would be sloppy — most connector use is *additive notification*, not destruction, and conflating the two erodes the typed-diff gate's signal value.

| Kind          | Side effect                       | Confirmation                                     | Examples                                  |
|---------------|-----------------------------------|--------------------------------------------------|-------------------------------------------|
| `read`        | None                              | None                                             | `listTeams`, `listChannels`               |
| `notify`      | Additive (creates a new artifact) | **Preview & send** modal — rendered output + target, one-click confirm | `post-channel-message`, `send-message`, `create-incident` |
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
- Connectors page: operational summary first, then live connector configuration panels with status pill (`connected` / `needs setup` / `needs scope` / `error`) and task-first setup controls. Teams shows the default channel picker; WhatsApp Web shows QR linking only when setup is needed, hides phone steps after a session is linked, and keeps default target selection/test sending visible. Default connector targets autosave as soon as a valid target is selected; there is no separate save button. Capabilities, required scopes, trust-boundary text, routing-rule details, and future connector backlog entries live in compact disclosures so connected connectors stay visually lightweight. The public GitBook carries the full connector setup reference; the in-app page links to it and keeps routine setup fields compact.
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
    - ChatMessage.Send
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
      scopes: [ChatMessage.Send]
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
- **Run activity includes delivery.** When per-agent Teams delivery is enabled, terminal runs append a post-run activity step showing whether the delivery rule matched the run, whether the report was sent, failed, or skipped, and the user-facing channel label.

#### WhatsApp Web connector (second to ship)

The WhatsApp Web connector is deliberately narrow. OpenAdminOS uses it for outbound run notifications only: the user links a local WhatsApp Web session by scanning a QR code, selects a default notification target, and agents can send terminal run reports to that target. The connector does not read incoming messages, auto-reply, monitor chats, download media, or expose WhatsApp as an agent control channel.

```yaml
descriptor:
  id: whatsapp-web
  name: WhatsApp Web
  version: 1.0.0
  authSource: external
  scopes: []
  capabilities:
    - id: send-message
      version: 1
      kind: notify
      scopes: []
  trust:
    label: "WhatsApp Web · local session"
    detail: "Sends through a WhatsApp Web session linked on this device. Message content leaves Microsoft 365 and is delivered by WhatsApp."
    staysInTenant: false
```

Capability surface:

```ts
interface WhatsAppWebConnectorCapabilities {
  sendMessage(args: {
    to?: string;  // "self", international phone number, or WhatsApp JID; omitted means connector default
    text: string; // plain text only
  }): Promise<{ messageId: string; to: string; targetType: "self" | "group" | "manual" }>;
}
```

Implementation decisions:
- **Baileys local Web session.** No WhatsApp Business API, no hosted relay, no server-side token storage. Auth files live under the Electron `userData` connector directory and can be removed from the Connectors page.
- **Saved sessions restore automatically.** When Baileys auth state exists on disk, the desktop app opens a WhatsApp Web socket in the background on status checks and app reopen. A linked session can stay connected across restarts unless the user removes the linked device from WhatsApp, WhatsApp expires the session, or the local auth directory is deleted; in those cases the connector returns to the QR setup flow.
- **Conservative Baileys socket behavior.** The runtime uses Baileys' cacheable signal key store, conservative socket timings (`keepAliveIntervalMs: 25s`, `connectTimeoutMs: 60s`, `defaultQueryTimeoutMs: 60s`), `markOnlineOnConnect: false`, `syncFullHistory: false`, and a desktop browser identity.
- **QR image handoff is versioned.** Relayed or stale QR images can fail with "Check your connection and try again." The desktop stores a QR version and only publishes the data URL that matches the latest QR string.
- **QR refresh is automatic.** While the QR is visible, the runtime rotates the pairing socket before the displayed code becomes stale and exposes a countdown so the renderer can explain when the next code will appear. Manual refresh remains available for immediate recovery.
- **Raw pairing tokens stay in the main process.** The renderer receives a QR image data URL, issue time, and refresh countdown, but not the raw WhatsApp pairing string.
- **Phone-side setup is explicit.** The connector card lists the WhatsApp mobile steps directly beside the QR: open WhatsApp, go to Settings, tap the QR symbol, choose Scan, then approve the new-computer prompt. Linked Devices -> Link a Device is shown as the alternate path for clients that expose that flow instead.
- **Recipient selection is target-first, not number-first.** A linked session defaults to `My WhatsApp`; the user's own phone/JID is resolved inside the main process at send time and is never displayed. Admins can switch the default target to a WhatsApp group fetched from the linked local session, or use a manual paste/drop fallback for international numbers, `wa.me` links, contact text, and raw JIDs.
- **Group metadata is local and narrow.** The group picker reads participating group id, subject, participant count, and announce flag from Baileys only after the session is linked. The app stores only the selected target id/type/label needed for delivery settings. Group JIDs (`@g.us`) are treated as internal target ids and should not be carried into manual Number/JID inputs when switching target modes.
- **Disconnect clears stale targets.** Removing the linked WhatsApp session resets the connector default target to `My WhatsApp`, moves per-agent WhatsApp delivery rules back to the connector default target, and drops pending WhatsApp delivery queue items that can no longer be sent safely.
- **Post-pairing restart is normal.** Baileys can close with status `515` ("restart required") or `408` after the phone accepts a pairing. The connector treats those as reconnect states, opens a fresh socket, and shows the user a reconnecting state instead of a terminal error.
- **Success requires a remote message id.** Run delivery is logged as sent only after Baileys returns a message id from `sendMessage`.
- **Run activity includes delivery.** When per-agent WhatsApp delivery is enabled, terminal runs append a post-run activity step showing whether the delivery rule matched the run, whether the report was sent, failed, or skipped, and the user-facing target label. Raw recipient values are not shown.
- **Recipient values stay out of logs and audit labels.** The raw WhatsApp number/JID or selected group JID is used only for local configuration and the main-process send call. Connector status, renderer confirmation payloads, run logs, connector test status, and audit egress targets use generic or user-facing WhatsApp target labels. Per-run connector audit metadata stores a redacted egress target plus a digest of the send arguments, not the raw target.
- **Libsignal console noise is suppressed narrowly.** Baileys/libsignal emits session lifecycle messages through `console.info`, outside pino. The runtime suppresses only the known session prefixes so key material does not appear in desktop logs.

#### Outbound notification connector expansion

Outlook, Slack, Discord, and Signal are implemented as outbound run-notification connectors. They reuse the same local retry queue, per-agent delivery rules, connector audit entries, and Connectors-page setup model as Teams and WhatsApp Web. This is deliberately smaller than OpenClaw-style full chat app integrations: OpenAdminOS does not listen for inbound messages, maintain bot gateways, process slash commands, or expose these services as agent control channels. Connector delivery also does not depend on Microsoft Power Automate/Flow; the desktop app invokes each connector directly through its Graph, API, webhook, local session, or local tooling path.

- **Outlook (`graph-delegated`).** Sends email through Microsoft Graph `/me/sendMail` with delegated `Mail.Send`. The connector does not request `Mail.Read`, does not watch mailboxes, and does not ingest email content. Default recipients and subject prefix are local connector config; recipients are redacted from run logs and audit egress labels.
- **Slack (`external`).** Sends messages through Slack Web API `chat.postMessage` with a bot token stored in Electron `safeStorage`. The first implementation requires `chat:write` and a default channel/conversation id. It does not use Socket Mode, Events API, slash commands, app mentions, or channel history reads.
- **Discord (`external`).** Sends messages through a Discord channel webhook URL stored in Electron `safeStorage`. The connector posts with `wait=true` and disables mention parsing by default. It does not register a bot, connect to the Gateway, read guild/channel history, or process interactions.
- **Signal (`external`).** Sends messages through either a local `signal-cli-rest-api` bridge or a local `signal-cli` subprocess. OpenAdminOS does not bundle `signal-cli` in this pass. It never shells through user-controlled text; the subprocess path uses argument arrays. Signal account, recipient, local bridge URL, CLI path, and config directory are local connector config.

For Slack and Discord, secrets are write-only from the renderer's perspective. The renderer can set or clear a named connector secret, but `listConnectors()` never returns token or webhook values. The main process passes a per-connector `SecretAccessor` into connector builds and runtime executions. Changing a secret resets that connector's persisted health status to `unknown`.

#### Connector shipping order

Teams proves the contract generalizes across capabilities while keeping the trust surface unchanged from today. WhatsApp Web proves the `external` class with a local, device-paired session and no enterprise API access. ServiceNow remains the canonical enterprise external connector — instance URL configuration, keychain-stored credentials, and "data leaves your tenant" trust messaging — but it no longer has to be the second connector.

### Registry model

The OpenAdminOS repository **is** the registry. Agents live in `/agents/<slug>/` in this repo (`OpenAdminOS/OpenAdminOS`), each directory containing `manifest.yaml`, `README.md`, and optional fixtures. There is no separate `openadminos-registry` repo and no two-tier "bundled vs. community" trust split — everything is community-by-default, contributed via PR to this repo.

The app binary ships with **zero agents**. At runtime the desktop app fetches the agent index (`/agents/index.json`, generated by CI from the manifests on every push to `main`) from the configured registry source, caches it to userData, and lets the user browse and install agents on demand. Installed agents are version-pinned; updates are surfaced as explicit "update available" badges and never auto-applied.

Distribution semantics:

- **Source of truth:** `https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents/`
- **Index:** `agents/index.json` is generated from `agents/*/manifest.yaml` after the agent QA gate and carries a SHA-256 digest for every exact manifest. The official index has a detached Ed25519 signature (`agents/index.sig`) verified against the public key pinned in the app. It also carries an explicit monotonic revision; the generator requires a revision bump when entries change, and the client rejects a revision older than its highest verified cache. An unsigned, modified, or replayed older official index is never cached or used.
- **Per-agent install:** verify index signature → fetch manifest → verify SHA-256 and trust metadata → validate schema → atomically write to userData → version-pin. Updates use the same chain, roll the manifest back if state persistence fails, and remove downloaded manifest files on uninstall.
- **Forkable:** Settings exposes a "Registry source" field under Privacy. Enterprises can fork this repo, curate `/agents/`, and point the app at their fork. Custom sources open a trust-review modal and require explicit acknowledgement before persistence.
- **App↔manifest version coupling:** each `index.json` entry carries `minAppVersion`. The app hides agents it can't run with a "Update OpenAdminOS to use this agent" note. This is how the DSL can evolve without orphaning users on older app versions.

Cache lifecycle:

- The first registry refresh starts in the background when the desktop host initializes. Browsing Chat does not wait for network, MSAL, or provider detection.
- On every subsequent launch (online): refresh `index.json` in the background. Compare to cached per-agent versions, surface per-agent update badges.
- Registry source URLs must use HTTPS, must not include credentials, query strings, fragments, or an `index.json` suffix, and are normalized before persistence. Localhost/private registry sources are blocked unless an explicit dev-only override is enabled (`OPENADMINOS_ALLOW_DEV_REGISTRY_SOURCE=1` in an unpackaged app).
- Registry cache is source-bound. A cached index is reused only when its recorded `sourceUrl` matches the currently configured normalized source. Official cached indexes must also record a successful signature verification, so legacy unsigned cache content is not trusted.
- Failed refresh is silent — keep using the cache, show a small "last refreshed N ago" indicator in Agent Hub. No blocking errors for a transient network blip.
- App works fully offline against the cached set after the first successful fetch.

Agent Hub UX should feel like an app store for admin agents, but without fake editorial weight. Until there is real curation data, do not render a giant "Featured" hero based on list order or split the same catalog into separate top-level surfaces. Use one consistent browse grid, dynamic category/mode/install filters, clear install/open actions, install counts where available, and trust/permission badges that help admins decide what to install. Registry freshness is diagnostic detail; do not make remote/cache state a primary card. Agent detail/manifest views should be decision-first: show what the agent does, install state, required scopes, mode, and tenant impact before exposing raw YAML. Installing from Agent Hub requires an explicit permission review step; a card click opens details, while the actual install action confirms the declared Graph scopes.

This is modeled on **Home Assistant integrations** (https://developers.home-assistant.io/docs/creating_integration_file_structure/) — one repo, PR-driven contribution, explicit version pinning per install.

### Local storage

SQLite via Electron's built-in `node:sqlite` for:
- Tenant configurations (encrypted via OS keychain for tokens)
- Installed agent registry
- Run history (full structured logs; the current desktop host persists `RunRecord[]` in profile `state.json` until the storage package migration moves it behind SQLite)
- LLM provider configurations (with hosted-provider API keys in OS keychain)
- Intune Chat conversations, tool calls, Graph cache snapshots, and per-tenant cache refresh schedules
- Tenant drift snapshot/version history for config-tier Graph cache resources; high-churn inventory resources stay out of drift tracking
- Optional local self-training events and approved suggestions

Run history retention is configurable in Settings -> General. The default policy
is deliberately generous: keep the newest 500 runs and any run queued in the
last 180 days. A run is pruned only when it falls outside every enabled keep
rule; admins can disable the count rule, disable the age rule, or choose
never-prune. Pruning runs at desktop startup and on the existing scheduler tick,
and Settings also exposes a manual "Prune now" action. The pruner must never
delete a run that is linked to or pinned in a Workspace, currently queued or
running, or awaiting write confirmation. Settings surfaces the last prune result
so local deletion is not silent.

Audit log export lives in Settings -> General next to run-history retention.
It is an explicit local save only, never an upload. JSON and CSV exports include
retained run-history events, write-confirmation request/accepted/rejected
events without exporting the typed phrase content, connector delivery audit
entries from `ConnectorAuditEntry`, and hosted-provider consent events recorded
in the SQLite `audit_events` table from this version onward. The export header
records the active run-history retention policy and the last prune result when
present so missing old runs are explainable. Each exported event carries a
SHA-256 hash chained as
`previousHash + canonical JSON event without sha256`, starting from 64 zeroes;
JSON records the start and final hash in `hashChain`, and CSV includes the hash
and chain metadata columns. Signed or third-party cryptographic timestamps are
deferred.

Linux tenant sign-in requires a real OS secret-store backend. OpenAdminOS uses
Electron `safeStorage` for the MSAL token cache, hosted-provider credentials,
and connector credentials, and refuses Electron's
unprotected Linux `basic_text` backend. Debian/Ubuntu packages recommend
`gnome-keyring`; KDE users can satisfy the same requirement with KWallet. If no
Secret Service/KWallet session is installed and unlocked, tenant connection
fails before storing tokens and shows recovery copy instead of silently writing
refresh tokens to weak local storage.

The local profile directory is created with owner-only permissions where the
platform supports POSIX modes. `state.json`, SQLite, its WAL/SHM sidecars,
downloaded agent manifests, registry cache, and encrypted credential blobs use
owner-only file modes. SQLite enables foreign-key enforcement, WAL, and secure
deletion. Tenant data in SQLite is not application-level encrypted; the product
relies on operating-system account isolation and full-disk encryption for those
local records and does not describe them as keychain-encrypted.

No cloud sync. No tenant-content, prompt, run-result, analytics-event, or
error-reporting telemetry. Packaged production builds may send a minimal public
registry install count event when a public agent is installed: agent slug, app
version, OS platform, and a yearly per-agent SHA-256 hash derived from a random
local install ID. Users can disable registry install counts in Settings. The
stats endpoint may use IP addresses for short-lived rate limiting. These events
must never include tenant identifiers, user identifiers, prompts, run results,
or Microsoft Graph data.

User-initiated support bundles are a separate explicit action, not telemetry.
The Settings → About action and contextual failure-state actions open an in-app
support form; issue reporting is not permanent sidebar navigation. OpenAdminOS may export a local diagnostics
JSON file only after the admin chooses that option. After the admin checks an
explicit public-issue confirmation and clicks submit, the desktop app posts a
bounded support report to the OpenAdminOS web API; the server creates the public
GitHub issue with a repo-scoped GitHub token that is never shipped to the
desktop app. The endpoint owns the repo mapping, applies server-side
redaction, enforces request-size limits, rate-limits by IP, and deduplicates
matching recent reports. The optional diagnostics JSON is bounded to
app/build/OS, provider status categories, registry/scheduler/cache health,
aggregate run counts, and hashed error categories. It must not include tenant
identifiers, account usernames, tenant domains, prompts, LLM output, Graph
response bodies, run reports, raw run logs, SQLite databases, screenshots, MSAL
tokens, provider credentials, or keychain values. No support report is
submitted automatically after a crash or failure, and no screenshot/session
replay capture is part of this flow. The desktop and support endpoint both run
a deterministic redaction pass over support issue free text before upload and
public issue creation. The pass catches common secret shapes such as provider
API keys, GitHub tokens, AWS/Google/Stripe/npm/Vercel tokens, JWTs, private-key
blocks, long high-entropy strings, authorization headers, and key/value fields
such as `client_secret` or `access_token`; it also redacts common public
identity and local-path markers. This is a backstop for accidental paste, not a
reason for admins to include tenant data in the report.

### Intune Chat and local intelligence

Intune Chat is the operating surface for exploratory tenant work. Agents remain
repeatable, reviewed workflows; chat is where an admin asks broad natural-language
questions, inspects tenant state, and routes repeatable work into installed agents
as skills.

The chat surface is read-only by default. It can query cached or live Microsoft
Graph data and ask the active LLM provider to explain the result, but it must not
perform Graph writes or connector side effects directly. If the user asks for work
that maps to an installed write agent, chat offers to run that agent and the normal
preflight, scope review, write-plan, and confirmation flow applies. No chat path
can bypass the write-agent confirmation contract.

Chat responses stream from the Electron main process to the renderer over a
dedicated IPC event channel. The renderer shows the assistant draft as model
deltas arrive, while the host persists only the final completed, failed, or
cancelled assistant message. The preload stream listener must remain registered
until the terminal `completed`, `failed`, or `cancelled` stream event; cleaning
it up when the IPC invoke promise resolves can drop tail events from very fast
local model streams. This keeps the UI responsive without storing partial tenant
answers as durable history. The composer exposes Stop while a chat answer is
running. Stop aborts provider work through the host-owned stream controller
where the provider supports cancellation, discards generated tail output, and
persists a clear cancelled assistant entry instead of a partial answer.

The composer follows normal chat ergonomics: Enter sends the message, while
Shift+Enter inserts a newline. The focused composer shows one visible accent
border only. Long-running chat work is not hidden behind a static text pill:
cache checks, live Graph refreshes, answer-pack preparation, and model generation
emit visible progress steps with loading, success, and failure states. Progress
renders in the assistant response slot for the active prompt, not pinned near the
composer, so it transitions naturally into the streamed answer. New conversation
sends must optimistically mount the user's prompt and the progress card before
the host returns a persisted conversation id; the chat history rail shows an
active "New conversation" draft row until the conversation is persisted. The
renderer keeps a transient in-flight draft so background history/cache reloads
cannot leave a send in "Thinking" without a visible prompt and progress card.
Live Graph refreshes triggered by chat write successful rows back into the same
local SQLite cache used by manual and scheduled refresh.

Single-tenant Intune Chat can run a bounded read-only investigative loop before
answering. The loop keeps the keyword planner as a cache-warming prefetch hint
and deterministic fallback, then asks the selected provider to use a prompt
protocol with one fenced JSON tool call per iteration:
`{"tool":"query_cache","params":{...}}` or a final
`{"final":true,"answer":"..."}` object. The host parses the response, executes
only host-owned read tools, appends observations, and stops after at most six
iterations. Malformed tool JSON gets one repair prompt; a second malformed
response or the iteration cap produces a visible fallback notice and answers
   through the deterministic planner path. The toolset is strictly read-only:
   `list_cached_resources`, `query_cache`, `graph_get`, `refresh_resource`, and
   `query_drift`.
`graph_get` accepts only GET, validates paths against the chat Graph cache
declarations and bundled Graph catalog read scopes, caps `$top` and returned rows
at 50, and truncates large live payloads before they return to the model. Every
tool call streams as a visible progress step and is persisted in `chat_tool_calls`
with the completed assistant message; the renderer shows a collapsible "What
ran" trace with tool name, parameters summary, result summary, duration, and
errors. Settings -> Intune Chat exposes **Chat investigation mode** with `auto`
(default), `always agentic`, and `always deterministic`. In auto mode, hosted
providers and known-capable local models use investigative mode; local models
whose names indicate a tiny/small/mini/<7B class fall back to deterministic
retrieval with honest copy.

Chat does not run without an active tenant. The status strip shows the active
tenant, provider, model, and data freshness. When the selected provider is local,
Graph data, prompts, chat history, answer packs, and optional self-training data
stay on the device. When a hosted provider is selected, the chat UI must state
that retrieved tenant context will be sent to that provider before the answer is
generated. The first hosted-provider chat send for a tenant/provider pair must
pause for explicit confirmation before the host builds and sends the answer
prompt. The confirmation names the tenant, provider, model, what leaves the
device, what stays local, and includes a per-device "remember this decision"
option. The renderer must send a fresh acknowledgement for each hosted-provider
chat request, either from the just-confirmed modal or from a remembered local
decision. Electron main validates that acknowledgement against the active tenant
and provider before creating chat messages, refreshing Graph cache resources, or
building the hosted LLM prompt.

Intune Chat supports multi-tenant read questions as a separate explicit mode
from normal active-tenant chat. The default scope remains the active tenant. If
the prompt asks for "all tenants", "every connected tenant", or similar MSP
language, the composer surfaces a scope review before any Graph refresh or model
prompt is built. The review names the selected tenants, required Graph resource
kinds, cache freshness, missing scopes, expired sessions, provider trust, and
whether any tenant will be skipped. The admin can choose the active tenant,
selected tenants, or all connected tenants; "all connected tenants" is never
implied silently by merely having multiple tenants connected.

Tenant groups are local shortcuts for common MSP slices such as "All customers",
"Pilot tenants", or "EU tenants". A group is not a new tenant boundary and it
does not grant broader access; it resolves to explicit tenant ids in the scope
review before any Graph refresh or model prompt is built. Saved multi-tenant
queries are local prompt templates with declared resource hints and optional
scope hints. They can prefill the composer for common investigations, but the
admin can edit the prompt and must still approve the resolved tenant scope.

Multi-tenant chat is read-only aggregation. It can answer questions like
"List all compliant and non-compliant Windows devices from every connected
tenant" by refreshing or reading each tenant's local Graph cache, computing the
counts and device rows deterministically, and then asking the selected model to
summarize the bounded result. The table/export is the source of truth; the LLM
explains the findings and caveats. Multi-tenant chat must not perform Graph
writes, connector delivery, or agent side effects directly. When a prompt maps
to an agent workflow across tenants, OpenAdminOS creates a multi-tenant job that
queues one normal tenant-pinned `RunRecord` per tenant rather than one run that
spans tenants. Write agents require per-tenant review and typed confirmation;
there is no "confirm all tenants" destructive shortcut.

Before a multi-tenant run starts, Electron main performs a readiness preflight
for every resolved tenant. The preflight reports whether each tenant is ready,
expired, missing delegated scopes, stale, recently throttled, blocked by hosted
provider consent, skipped, or failed. The UI shows recovery actions beside the
affected tenant, such as reconnecting the tenant, granting missing scopes,
refreshing cache, or removing the tenant from the run. A skipped or failed tenant
must be visible in the final answer and export; it cannot disappear from the
scope silently.

The multi-tenant visual flow is:

1. **Scope review** in the assistant response slot before work starts: tenant
   checklist, resolved group membership, selected resources, readiness,
   freshness, scopes, provider/model, and a "Run read-only query" action.
2. **Per-tenant progress** while the job runs: each tenant row shows queued,
   refreshing cache, reading local cache, building result, skipped, failed, or
   ready. Refreshes run with bounded concurrency so one throttled tenant does not
   block the whole UI.
3. **Aggregate answer** with compact summary tiles for tenants scanned, failed
   tenants, Windows devices, compliant, non-compliant, unknown, and stale-data
   caveats.
4. **Tenant comparison table** with columns such as tenant, Windows devices,
   compliant, non-compliant, unknown, last refresh, and status.
5. **Expandable tenant detail** for device rows, filtered by tenant, compliance
   state, OS version, and last sync. Export actions are local and explicit
   (`CSV`, `Markdown`, or `JSON`).

Multi-tenant result tables include filters for tenant, readiness, compliance
state, operating system, stale data, failed tenants, and skipped tenants. The
admin can export a compact local dossier that includes the original query,
resolved tenant scope, saved-query id if used, provider/model, cache freshness,
skipped/failed tenants, summary counts, comparison table, and detail rows.
Dossiers are local files, not connector sends, background uploads, or telemetry.
They may be reopened from multi-tenant job history while clearly showing whether
the underlying cache has become stale.

Multi-tenant chat uses an "answer artifact" layout for table-heavy results. The
normal prose answer keeps the readable chat measure, but the result artifact can
span the available conversation column so comparison tables, filters, and export
actions do not feel cramped. The table keeps the tenant column visible, supports
keyboard sorting/filtering, uses text plus icons rather than color alone for
readiness/compliance state, and allows horizontal overflow inside the artifact
instead of widening the whole page. Long tenant names, device names, and policy
names truncate with accessible full-value disclosure. The saved-query picker and
tenant scope selector live near the composer/header as compact controls; they do
not replace the assistant-slot scope review, which remains the final checkpoint
before work starts. Result filters, expanded tenant rows, and selected saved
query are persisted in the local multi-tenant job state so reopening the result
restores the investigation context.

Hosted-provider confirmation for multi-tenant chat names every selected tenant
or shows a counted tenant list with expandable details, names the provider and
model, and states that retrieved context from those tenants will be sent to the
hosted provider. Remembered hosted-provider consent remains scoped by
tenant/provider; a multi-tenant send may proceed only for tenants with remembered
consent or a fresh batch acknowledgement. Local-provider sends keep Graph data,
prompts, answer packs, and exports on the device.

The chat page should behave like a focused chat product, not an operations
dashboard: history on the left, the active conversation and composer in the
center, and only compact tenant/provider/freshness cues in the chat header.
The chat header should not expose a global cache Refresh action; prompt-scoped
refresh already happens during send, and broad cache maintenance belongs in
Settings. Graph cache details, manual/periodic refresh controls, and
self-training approval/reset workflows live in Settings -> Intune Chat so normal
chat use stays uncluttered.
The history rail can collapse to a narrow icon/index strip when the admin wants
more reading width, and each message exposes a compact copy action for prompts
and responses. User prompts can also be loaded back into the composer for
revision/resend, assistant responses can be regenerated from the preceding
prompt through the normal chat send pipeline, and running generations can be
stopped without leaving the interface stuck in an in-progress state. Stop is a
host-visible cancellation: Electron main aborts the active chat stream, providers
that support aborts terminate their network/process work, and the host persists a
`cancelled` assistant record without generated answer text.
Conversation management is local-first as well: admins can search conversation
titles and message text, pin important investigations, rename conversations,
export a local Markdown transcript with source metadata, and delete
conversations from the local SQLite store. Deleting a conversation removes local
messages and chat tool-call records only; it does not disconnect the tenant,
clear Graph cache, or alter agent run history. Pinned conversations are grouped
at the top of the chat history rail under a collapsible Pinned section, separate
from Recent conversations. Conversation rows expose a right-click context menu
for local deletion while still using the same product confirmation modal as the
header Delete action.
Settings -> Intune Chat also exposes a local data summary for local storage:
SQLite database size, chat conversation/message/tool-call counts, active-tenant
Graph cache rows, self-training event/suggestion counts, run-history record
count, and the last run-history prune result. Clearing all chat history uses an
explicit product modal and removes only local conversations, messages, and chat
tool-call records.

Claude-style Projects are a useful reference, but the OpenAdminOS version is
called **Workspaces**. Workspaces are tenant-scoped investigation containers, not
generic project folders. A workspace holds pinned Graph evidence, linked chat
conversations, relevant agent runs, local notes, approved local instructions,
and source freshness for a specific tenant problem. Workspaces stay local-first:
with a local provider, workspace notes, pinned evidence, chat context, and prompt
overlays stay on the device; with a hosted provider, any workspace context sent
to the model follows the same explicit hosted-provider confirmation rules as
Intune Chat. Workspaces is a top-level primary navigation item at `/workspaces`,
placed directly after Intune Chat. Intune Chat, Activity, and Run Detail expose
contextual add/link/pin actions into Workspaces. Workspaces remain
single-tenant; multi-tenant Intune Chat results can export locally or create/link
separate tenant-specific workspace evidence, but a single workspace must not mix
tenant evidence in v0.2.5. The split-to-workspaces action shows a review screen
with one row per tenant, the target workspace or new workspace name, the evidence
row count, and freshness. Confirming writes separate local evidence bundles only
to matching tenant workspaces; cancelling leaves the multi-tenant result
unchanged.

The Workspaces layout is a dense two-pane investigation surface: a workspace
list/search pane on the left and the selected workspace detail on the right. The
detail view groups notes, pinned evidence, linked conversations, linked runs, and
workspace-local instructions into clear sections without nesting cards inside
cards or becoming a project board. On narrower desktop widths, the list can
collapse to preserve evidence reading width, but the global sidebar and status
strip remain visible. Workspace filters, selected section, and expanded evidence
groups restore when the admin returns to a workspace.

v0.2.5 ships the read-only multi-tenant Intune Chat path, single-tenant
Workspace storage/linking, separate multi-tenant progress streaming IPC,
tenant-pinned agent batch records, chat-answer pinning into Workspaces, and
explicit workspace context attachment in the chat composer. Cross-tenant agent
batches never create a mixed-tenant execution context: Electron main queues one
normal `RunRecord` per ready tenant. Write agents still move through the normal
per-run plan review and typed confirmation flow, with no "confirm all tenants"
shortcut. Workspace context attachment is opt-in per prompt and can include
selected evidence, notes, and workspace instructions only after the UI shows the
included items. When a hosted provider is active, the confirmation also names
the attached workspace, tenant, provider, model, evidence count, note count, and
whether instructions are included before any workspace context enters the model
prompt.

#### Graph cache

The cache is a local SQLite-backed mirror of selected read-only Graph resources.
It exists to make chat fast, auditable, and context-window-safe; it is not cloud
sync and it is not telemetry. Each cached row records tenant id, resource kind,
Graph object id when available, snapshot id, raw JSON, normalized searchable
columns, scope set, and refresh time.

The first question-driven planner covers the resource areas behind the researched
top 150 Intune admin questions in `docs/research/intune-chat-question-bank.md`.
The bank is built from Microsoft Graph resource coverage and current admin
community demand around app assignment, Autopilot ESP, compliance "Not
Evaluated", remediations, Windows Update, policy conflicts, audit, and stale
device investigations. Tests assert that every banked question plans all declared
cache resources, so the prompt examples and planner cannot drift silently.

Initial cache targets:

- `/deviceManagement/managedDevices`
- `/devices`
- `/users`
- `/groups`
- `/deviceManagement/deviceCompliancePolicies`
- `/deviceManagement/deviceConfigurations`
- `/deviceManagement/configurationPolicies`
- `/deviceAppManagement/mobileApps`
- `/deviceManagement/detectedApps`
- `/deviceAppManagement/managedAppPolicies`
- `/deviceAppManagement/iosManagedAppProtections`
- `/deviceAppManagement/androidManagedAppProtections`
- `/deviceAppManagement/mobileAppConfigurations`
- `/deviceManagement/deviceHealthScripts`
- `/deviceManagement/deviceManagementScripts`
- `/deviceManagement/windowsAutopilotDeviceIdentities`
- `/deviceManagement/autopilotEvents`
- `/deviceManagement/windowsAutopilotDeploymentProfiles`
- `/deviceManagement/deviceEnrollmentConfigurations`
- `/deviceManagement/windowsQualityUpdateProfiles`
- `/deviceManagement/windowsFeatureUpdateProfiles`
- `/deviceManagement/intents`
- `/deviceManagement/groupPolicyConfigurations`
- `/deviceManagement/assignmentFilters`
- `/deviceManagement/roleScopeTags`
- `/deviceManagement/managedDeviceOverview`
- `/deviceManagement/managedDeviceEncryptionStates`
- `/deviceManagement/troubleshootingEvents`
- `/auditLogs/signIns`
- `/auditLogs/directoryAudits`
- `/deviceManagement/auditEvents`
- `/identity/conditionalAccess/policies`

Initial tenant connection requests the Graph PM-audited read scopes needed for
these cache targets, including Intune configuration, apps, service config,
scripts, RBAC scope tags, Entra devices, and group membership reads. Existing
tenants connected before this consent expansion may still need to reconnect or
approve incremental Microsoft consent. Refresh failures are stored per resource
and surfaced in chat sources/settings instead of blocking unrelated cached
resources. Completed assistant messages include a source-details disclosure for
each used Graph resource with cache/live status, row count, page count, cap
status, refresh time, Graph path, selected fields, query parameters, and safe
error text where available.
Autopilot event data is included as a separate source because live tenant checks
can return Intune service-side 500s for `/deviceManagement/windowsAutopilotDeviceIdentities`
even when the correct service-config read scope is present. Chat should surface
the identity source error while still using Autopilot events, troubleshooting
events, and enrollment configuration data when available.

Refresh modes are explicit: chat refreshes prompt-relevant resources as part of
answering, while Settings -> Intune Chat lets admins manually refresh the active
tenant cache or enable a per-tenant periodic refresh interval. Scheduled refresh
uses the same local app/OS scheduler surface as agent schedules while the user is
signed in; it writes success/failure state to SQLite and never uploads cache
contents.
Collection refresh follows Microsoft Graph `@odata.nextLink` pagination up to a
bounded page/row cap. Cache status records row count, page count, and whether the
cap was reached, so chat can disclose partial source coverage instead of treating
the first Graph page as tenant-wide evidence.
The Changes timeline searches the bounded local history in the host rather than
only filtering the currently rendered page. It scans at most the newest 5,000
snapshots and labels that boundary when reached. A capped Graph cache refresh
never infers that unseen objects were removed; removal detection resumes only
after a complete refresh, and the UI discloses partial source coverage.
Settings -> Intune Chat can clear the active tenant's cached Graph rows and cache
status through an explicit local-deletion modal. Clearing cache does not
disconnect the tenant, change provider settings, remove chat history, or alter
agent run history; the next chat refreshes required resources again.
Every chat answer that uses cached data must disclose the resource freshness.
Stale data is acceptable when the user chooses to use it; silently treating
stale cache as current data is not.

Audit-log cache pulls must be field-selected rather than raw unbounded rows.
The v0.2.2 cache uses compact `$select` lists for sign-ins and directory audits,
validated against Microsoft Graph beta through the Microsoft Graph MCP, so local
SQLite growth stays bounded before the answer-pack compaction step.

#### Tenant drift timeline

Tenant drift tracks configuration-tier Graph resources where change history is
useful to an Intune/Entra admin: compliance policies, configuration profiles,
settings catalog policies, Conditional Access policies, apps and app-management
policies, scripts/remediations, Autopilot/enrollment profiles, Windows update
policies, endpoint security intents, group policy configurations, assignment
filters, and scope tags. Since v0.5 the tracked set also covers Entra
configuration surfaces: named locations, authentication methods policy,
authorization policy, cross-tenant access policy, directory roles,
administrative units, app registrations, service principals, and domains.
High-churn inventory and event resources such as managed devices, detected
apps, sign-ins, troubleshooting events, overview aggregates, encryption state,
and Defender alerts/incidents/Secure Score stay out of drift tracking so the
timeline does not become noise or a storage sink.

**Named baselines (v0.5).** A baseline pins the exact live object versions
(per resource, Graph id, version, and content hash) at creation time, not
snapshot ids, so baseline drift survives snapshot retention. At most one
baseline per tenant is active; retiring keeps the baseline and its pins but
releases its pruning protection. Retention pruning never deletes an object
version pinned by an active baseline. Baseline drift (added, removed, and
modified objects with deterministic field-level diffs) is computed on demand
from the pinned set against the latest live versions; nothing calls Graph.

**Baseline rollback (v0.5).** Rollback plans are built deterministically by
the host, never by an LLM: modified objects become PATCH actions carrying the
pinned baseline values (read-only fields stripped), drifted additions become
destructive-severity DELETE actions, and objects deleted since the baseline
become POST recreations where Graph supports it. Every generated action is
validated against the bundled Graph endpoint catalog; anything undocumented,
plus deliberately report-only surfaces (directory roles, app registration and
service principal credentials, domains), is listed for manual review instead
of guessed. The plan flows through the existing run machinery as a
host-generated system run (`origin: "baseline-rollback"`): same stored plan,
same exact-match typed confirmation phrase (for example ROLLBACK 4 OBJECTS),
same reject path, same audit and run history. Apply is fail-stop: actions run
strictly in order, the first Graph failure terminates the run with an exact
count of what was applied, and nothing after the failed action is attempted.
Rollback runs are not backed by an installed agent and cannot be re-run;
each rollback builds a fresh plan from current drift.

Snapshots are created only when the normal Graph cache refresh writes a tracked
resource. A first refresh establishes a baseline; later refreshes compare the
new canonicalized rows against the previous version for each object and store
added, removed, or modified object-version intervals. Refreshing audit resources
can improve attribution, but answering a drift query never calls Microsoft Graph.
The desktop host exposes timeline, entry detail, object history, and status APIs
from local SQLite snapshot/version rows.

Diffs are deterministic. The host canonicalizes tracked objects, ignores known
volatile fields, hashes canonical JSON, and computes field-level before/after
paths with the pure diff engine. The LLM never computes drift and is not allowed
to invent a changed field; it can only summarize bounded rows returned by the
host APIs or the read-only `query_drift` chat tool. Detail APIs omit raw
before/after bodies once either serialized side exceeds 48 KB, while retaining
the field-change list.

Attribution is honest rather than guessed. At query time the host joins the
diffed object id to cached Intune audit events and directory audits within the
previous-snapshot-to-current-snapshot window, padded five minutes backward for
clock skew. A matched result may show the actor UPN or app display name plus the
source audit family. If no cached audit row matches, attribution is `unknown`.
If either audit cache is absent or older than the snapshot window, the result is
`audit-cache-stale` so the UI can ask the admin to refresh audit data instead of
implying that a real actor could not be found.

Change history retention is local and configurable in Settings -> General. The
default keeps snapshot/version history for 180 days, bounded to 30-730 days, with
a never-prune option. Pruning runs at startup, on the scheduler tick, and through
the manual Settings action. Current object state is never deleted by drift
retention; only old historical snapshots and stale object versions are removed.

Disconnecting a tenant is an explicit destructive local-data operation. After
confirmation, the host removes the tenant record, tenant-pinned runs and queued
deliveries, Graph cache/status, conversations and messages, workspaces and
evidence, drift history, self-training/audit records, saved-query tenant
references, tenant-group membership, multi-tenant jobs/batches that include the
tenant, and its cache schedule before removing the MSAL account. Failure is
surfaced and never presented as a successful disconnect.

Verification for the chat surface includes `npm run smoke:intune-chat`. The smoke
test launches Electron in a dev-only fixture mode, seeds a local tenant, drives
the real preload/IPC chat path through a 10-prompt pass, verifies a grounded
answer, Stop, Regenerate, agent suggestion, collapsible history rail, copy
response action, accepts a local self-training suggestion, and confirms scheduled
cache refresh UI state.
The fixture injects deterministic local-provider readiness plus Graph and LLM
adapters, so it never depends on Ollama or another provider being installed on
the CI host. It does not replace a final live-tenant pilot run, but it guards the
desktop path without requiring tenant credentials in CI or local automation.
The v0.3 release gate also includes `npm run screenshots`, a dev-only Electron
capture harness gated by `OPENADMINOS_SCREENSHOT_CAPTURE=1` and `!app.isPackaged`.
It seeds a Contoso Demo tenant with an `.invalid` admin address, a local Ollama
model, the real registry index from `agents/index.json`, and smoke Graph/LLM
factories, then writes 1600x1000 PNGs for five app shell routes and every Agent
Hub registry detail under `docs/screenshots/`.

#### Context-window strategy

The model never receives an unbounded tenant dump. Chat first plans the data it
needs, queries SQLite and/or Graph deterministically, then sends a compact answer
pack to the LLM. SQL and Graph do the filtering, joins, sorting, counts, and top-N
sampling. The LLM explains the prepared evidence, calls out missing or stale data,
and avoids inventing tenant state.
Answer packs include the generation timestamp so time-bounded questions such as
"devices not synced in the last 7 days" do not force the model to infer the
current date. Common precise predicates should run deterministically before the
LLM sees the answer pack. For v0.2.2, stale managed-device sync questions parse
the day threshold, compute the cutoff from `generatedAt`, read matching
`managedDevices` rows from SQLite by `lastSyncDateTime`, sort oldest first, and
include the threshold/match metadata in the answer pack.

For large result sets the answer pack includes aggregate counts, grouped
breakdowns, and representative rows. v0.2.2 reads at most 40 rows per planned
resource from SQLite/Graph and includes at most 20 compact sample rows per
resource in the model prompt, with `selectedRows`, `includedSampleRows`, and
`omittedCachedRows` metadata so the model can disclose bounded evidence rather
than pretending it saw the full cache. Long policy or audit text may be
summarized in chunks before a final summary. Local embeddings can be added later
for free-text policy retrieval, but the first implementation should work without
embedding infrastructure.

#### Agents as skills

Installed agents expose routing metadata derived from their manifests: name,
description, category, mode, scopes, settings, model requirements, examples, and
write/destructive status. When chat detects that a prompt maps to an installed
agent, it should recommend that agent instead of improvising a workflow. The user
chooses whether to run it or inspect why it was suggested, including required
scopes. Chat should not add a generic "ask first" turn from an agent suggestion;
if more context is needed, the details disclosure should state the concrete
reason, matched prompt terms, matched concepts, planned sources, mode, scopes,
and confirmation behavior. Write-agent suggestions require explicit write intent
and category alignment when the prompt clearly names a category.

Agent runs started from chat are recorded as chat tool calls that link back to the
run id. The agent runtime remains the source of truth for execution, confirmation,
and audit records.

#### Optional local self-training

Self-training is an optional local feature, disabled by default. The product copy
must be explicit: it does not train the model, upload tenant data, rewrite public
manifests, add scopes, change read/write mode, alter connector egress, or bypass
confirmation. It stores admin-approved local instructions that can influence
future prompt/context composition.

The desktop host, not the agent, writes approved learning state under:

```text
<userData>/
  openadminos.db
  agent-learning/
    tenants/
      <tenantIdHash>/
        agents/
          <agentSlug>/
            self-training.yaml
```

Chat and agent runs can produce learning events: accepted agent routes, rejected
write plans, confirmed write plans, repeated corrections in chat, and relevant
agent setting changes. SQLite stores those events, pending suggestions, decisions,
and reset history. The admin must approve a suggestion before it becomes active.
Future agent LLM steps receive approved self-training entries from
`self-training.yaml` as a local overlay on top of the reviewed manifest prompt.
Resetting learned behavior for an agent marks accepted suggestions as reset,
rewrites that agent's `self-training.yaml`, and preserves the SQLite decision
history.

### Desktop renderer security

The Electron renderer runs with `contextIsolation: true`, `nodeIntegration:
false`, and `sandbox: true`. The preload is emitted as CommonJS so Electron's
sandboxed preload can expose the narrow `window.openAdminOS` bridge without
granting renderer Node access. All privileged work stays in Electron main.
Every `ipcMain.handle()` callback must validate the sender frame against the
loaded app origin before performing privileged work. Renderer-provided payloads
must be narrowed at runtime with bounded strings, booleans, known enums, and
plain JSON object size caps before reaching the store; TypeScript annotations in
the preload are not sufficient security validation.

The desktop HTML must not load remote fonts or decorative remote assets. The
app uses system font stacks and a restrictive Content Security Policy: scripts,
styles, images, and fonts are self/data/blob-limited as needed; renderer
connections are limited to the app/dev server and loopback local-provider
endpoints. The host classifies local-provider endpoints conservatively before
claiming local-only trust. Microsoft Graph, login, registry, and hosted-provider
traffic should flow through the main process unless a renderer-owned external
endpoint is explicitly approved and documented.

Desktop copy actions should use the bounded Electron clipboard bridge exposed by
preload instead of relying on sandboxed renderer clipboard permissions. Browser
clipboard fallbacks are acceptable only for renderer-only development.
Local destructive actions such as uninstalling an agent, disconnecting a tenant,
or clearing local data should use product modal components with explicit impact
copy and success/failure feedback. Native browser dialogs (`alert`, `confirm`,
`prompt`) are not acceptable for shipped desktop UX because they bypass the
design system and hide recovery context.
If the renderer is opened without the Electron desktop bridge, app routes should
show a designed bridge-unavailable diagnostic state instead of silently failing
or logging noisy console warnings. That state
is for renderer-only development; tenant-connected testing belongs in the
Electron window.

### Code signing

Required before public v1 release:
- **Windows:** Azure Artifact Signing (renamed from Trusted Signing in January 2026) under the validated identity `Ugurlabs UG (haftungsbeschränkt)`. The certificate is short-lived, issued and rotated by Microsoft, the private key never exists outside Microsoft's HSM, and CI holds only a revocable Entra service principal credential. Tagged releases build, sign, and publish an x64 NSIS `.exe` installer plus `latest.yml` for electron-updater. Maintainers may still request a manual AppX packaging-validation job for the deferred Microsoft Store path, but AppX files are not published as workflow artifacts or release assets. (The original v0.4.4-era pipeline used a DigiCert KeyLocker OV certificate, order #1504899298, valid to Aug 2027; it worked end to end and was replaced by Trusted Signing for faster SmartScreen reputation. It remains restorable from git history as a fallback.)
- **macOS:** Apple Developer Program ($99/yr), a Developer ID Application certificate for the app/DMG/ZIP, a Developer ID Installer certificate for the PKG, and notarization. Without notarization, Gatekeeper blocks the app.
- **Linux:** Release tags publish unsigned x64 artifacts as AppImage, `.deb`, and `.rpm`, plus `SHA256SUMS.txt` and a checksum section in the GitHub Release notes. Treat Linux support as current Ubuntu and other Debian-family systems, plus RHEL/Fedora-compatible desktop coverage, not "any distro" support. The `.deb` is also published into a signed static apt repository on GitHub Pages at `https://repo.openadminos.com/debian`; apt trust is repository-metadata signing, not per-file executable signing. The apt repository script validates `.deb` architecture from control metadata rather than Debian filename suffixes because Electron Builder release assets use `*-linux-amd64.deb` names. RPM repository/package signing remains deferred until OpenAdminOS operates an RPM repository. The v0.2.1 Linux backfill workflow checks out the v0.2.1 tag and patches only CI-local Linux package metadata before uploading artifacts to the existing release.
- Linux packages use `openadminos` as the executable and `com.openadminos.desktop.desktop` as the desktop-entry filename, with Electron Builder desktop-name synchronization enabled so GNOME/KDE window association matches the application ID.
- Packaged Linux desktop builds use Chromium software rendering by default and avoid VAAPI/GPU initialization. AppImages must tolerate Debian/Ubuntu VMs and desktops without working 3D acceleration; the main window also has a load/timeout reveal fallback so a missing `ready-to-show` event cannot leave the app invisible.
- Total: ~$500-700/yr, owned by the OpenAdminOS UG entity.

#### Windows signing and distribution decisions

- The shipped Windows artifact is an NSIS `.exe` installer, not an AppX. An
  `.exe` installs from a downloaded file without Store enrollment or sideloading
  policy, and it is the only Windows target electron-updater can auto-update.
- The installer is per-user (`nsis.perMachine` false), so neither installing nor
  auto-updating prompts for elevation. Requiring local admin rights to update an
  admin tool is a bad trade.
- `win.signtoolOptions.signingHashAlgorithms` is pinned to `["sha256"]`.
  electron-builder's default of `["sha1", "sha256"]` invokes the sign hook once
  per algorithm, doubling signing operations, and a SHA-1 pass fails against a
  modern certificate.
- `win.signtoolOptions.publisherName` must equal the certificate subject
  common name exactly. electron-builder writes it into the packaged app's
  `app-update.yml`, and electron-updater verifies downloaded updates against
  it; when it is absent, verification is skipped silently. The release job
  asserts the Authenticode status and the signer common name after every build
  and fails with the actual subject on mismatch, so this can never degrade
  quietly.
- Bundled third-party Microsoft binaries (MXC SDK) keep their vendor
  Authenticode signature instead of being re-signed; the release job verifies
  those vendor signatures after every build.
- Trusted Signing is Microsoft's own public-trust program and establishes
  SmartScreen reputation faster than a conventional OV certificate, but a
  brand-new file hash can still prompt briefly. User-facing copy stays honest
  about that rather than implying a guaranteed clean first run.

The build pipeline treats signing as a first-class release step. Manual packaging validation may run without release secrets, but a tagged release fails closed before publishing when any Windows Trusted Signing credential, macOS signing/notarization secret, or Linux apt-repository private-key secret is absent. The Linux apt passphrase remains optional because the repository signing key may be unencrypted.
Release automation treats `release: vX.Y.Z` as the canonical marker and parses it from the full merge commit message, so both squash merges and normal merge commits can cut the corresponding tag.
Tagged releases build and publish the supported Windows x64 installer, macOS Apple Silicon, and Linux x64 packages. Windows AppX validation is an opt-in manual workflow job and is not a dependency of release publication.
Release prep must bump every OpenAdminOS-owned package manifest and matching lockfile metadata that carries the product release version, including desktop, runtime, connector packages, QA packages, and the marketing website package.
Release publishing must use the matching `CHANGELOG.md` section as the GitHub Release body and fail if that section is missing; generated PR summaries are not an acceptable fallback for release notes.
Release gates preserve upgrade identities from v0.3: `com.openadminos.desktop` and the GitHub update publisher for macOS, plus the `openadminos` package/executable and stable desktop identity for Linux. Automated compatibility coverage must also open legacy JSON and SQLite state, apply additive migrations, and prove tenant, run, agent, chat, and cache records survive before packaging.
When deliberately backfilling an existing release tag, release publishing may overwrite same-name GitHub Release assets so installers, updater metadata, and checksums can be replaced without inventing a new product version.

The macOS menu bar companion must be created during any interactive app launch, including the case where a hidden background scheduler process already owns the Electron single-instance lock and receives the visible launch through the `second-instance` path.

---

## 3. Design system

### Tokens (from `apps/desktop/src/styles/globals.css`)

```
--color-bg: #1c1917              Background base
--color-bg-elevated: #252220     Elevated background
--color-bg-raised: #2d2926       Highest elevation
--color-sidebar-solid: #191614   Sidebar and rail (warm near-black, no cool cast)
--color-surface: #232120         Cards and controls
--color-surface-hover: #2a2724   Hovered surface

--color-text: #f5f1eb           Primary text
--color-text-soft: #b5ada3      Secondary text
--color-text-muted: #9a9085     Metadata and labels (≥ 4.6:1 on production surfaces)
--color-text-placeholder: #9c9186  Form and composer placeholders (≥ 4.5:1 on every input surface, including bg-raised)
--color-text-faint: #6b6157     Decorative marks only (dots, dividers, disabled ornament); never readable copy

--color-border: #322e2a
--color-border-strong: #403a35
--color-border-soft: #2a2622

--color-accent: #e8a87c         Warm copper; reserved for primary actions, focus, and active navigation
--color-accent-hover: #efb88f
--color-accent-soft: #e8a87c1f
--color-on-accent: #1a120c      Foreground on accent- and warning-filled controls (no hardcoded literals)

--color-success-fg: #9cc88f     Success and the local-only trust line (paired bg: #9cc88f1f)
--color-warning-fg: #e5c678     Write operations and attention (paired bg: #e5c6781f)
--color-danger-fg: #e58888      Errors and destructive actions (paired bg: #e588881f)
--color-info-fg: #a3bfd9        Informational and live-activity states: meters, pulses, spinners (paired bg: #a3bfd91f)
--color-think-fg: #c4a5d9       LLM reasoning blocks (paired bg: #c4a5d91f)

Legacy names (--color-success/-warning/-danger/-info/-think and their -soft
variants) remain defined and byte-identical to the -fg/-bg pairs above.

--radius-sm: 6px
--radius-md: 10px
--radius-lg: 14px
--radius-xl: 18px
```

Accent allocation: copper marks what the user can act on (primary buttons, focus
rings, active navigation, selected scope). Live activity uses info, pins and
decorative bullets use neutral text tokens, and the Chat user message is a
neutral raised bubble with a 2px copper right edge instead of a solid copper
fill. Destructive approval controls stay danger-coded; they are never copper.

### Typography

- **UI:** system UI stack (`ui-sans-serif`, `system-ui`, `-apple-system`, `Segoe UI`, sans-serif)
- **Code, IDs, telemetry, run IDs, JSON:** system monospace stack (`ui-monospace`, `SF Mono`, `Menlo`, `Consolas`, monospace)
- Base size: 14px, with 12–13px controls and 11px metadata for admin-focused density
- Line-height: 1.55
- Letter-spacing: 0

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

## 4a. UX simplification (v0.4)

v0.3 shipped with ten sidebar destinations and two equally-weighted primary paradigms (Agents and Chat). A fresh install presented the surface area of a mature product with no guided path. These decisions reduce day-one complexity without removing capability.

### Front door: Chat

Chat is the primary paradigm. "Ask a question about your tenant in plain language" requires zero new vocabulary from a Microsoft admin. Agents are the packaged, repeatable form of the same work and get suggested *from* chat when a question matches an installed agent's domain. Agents remain a first-class nav item; they are no longer the default landing surface.

Chat related-agent hints are deterministic and presentation-only. The renderer
matches each sent question against installed agent name, category, description,
simple bigrams, and a small local Microsoft admin synonym table. The matcher
uses a conservative score threshold of 8 and requires either two matched
tokens/bigrams or one strong name/category/synonym-domain hit. Hints render only
after the assistant message completes, can be dismissed, never persist to chat
messages, and never suggest the same agent twice in one conversation.

### Navigation (locked for v0.4)

Three workspace destinations plus Settings. The primary order stays fixed across routes, and Settings stays in the same navigation group rather than floating at the bottom of the window:

| Nav item | Route | Contains |
|---|---|---|
| Chat | `/chat` | Tenant Q&A (formerly "Intune Chat" in nav; covers Intune + Entra) |
| Agents | `/agents` | Tabs: Installed · Hub · Schedules |
| Changes | `/changes` | Tenant drift timeline |
| Settings | `/settings` | Providers, tenants, workspaces, connectors, general, privacy |

Demoted from top-level nav (routes remain, reachable via Settings and the command palette):
- **Workspaces** and **Connectors** — power-user surfaces; irrelevant until a user has more than one tenant or an external integration. Linked from Settings.
- **Activity** — run history remains available through search, run links, and agent surfaces without adding another daily destination.
- **Agent Hub** — a tab inside Agents, not a sibling of it.

Removed from navigation:
- **Home** — its checklist duplicated Chat onboarding, its recent work duplicated run history, and its trust card duplicated the persistent status strip. `/` redirects to `/chat`.
- **Report issue** — available in Settings → About and contextual failure recovery, not as permanent primary navigation.

### First run and contextual activation (updated for v0.5)

Chat is the first-run surface, and the full shell remains browsable without a tenant. A fresh install opens `/chat`; `/onboarding` is a compatibility redirect to `/chat`.

**v0.5 decision (2026-08-29):** a launch with zero connected tenants opens the shared setup dialog automatically (permissions review, then Microsoft sign-in, then provider selection when no provider is connected), so a fresh install starts guided instead of presenting an inert chat screen. The dialog is dismissible and auto-opens at most once per launch; a restored pending intent takes precedence; the menu-bar companion window and renderer-only development never auto-open. Once at least one tenant exists, setup returns to being purely contextual. Users can still dismiss the dialog and inspect Chat, Agents, Changes, and Settings, select a suggested question, and edit a local draft before granting tenant access. The empty-state heading, explanation, and suggested questions stay centered as one block immediately above the composer rather than floating in the middle of the transcript area.

Setup opens only when an action needs tenant context: sending Chat, starting or rerunning an agent, opening tenant Changes from its empty state, refreshing tenant cache data, or explicitly choosing Connect tenant. The shared setup dialog follows this order:

1. Review grouped read-only Microsoft Graph permissions and their exact rationales.
2. Complete Microsoft sign-in in the system browser.
3. Pick or repair an LLM provider when the pending action needs one.
4. Review an explicit resume action. Nothing sends or runs automatically after sign-in.

Pending setup intent is safe session metadata only: action kind, local return route, conversation id, agent slug, validated resource kind, optional run pinning or scheduled batch mode, and creation time. Chat text remains in its separately namespaced per-conversation session draft record and is never copied into the pending-intent record. Pending intents expire after 30 minutes. Cancel clears the intent but preserves the Chat draft. Sign-in exposes cancel, a three-minute soft waiting state, and a five-minute host timeout; the local loopback listener closes on cancel or timeout.

The persistent status strip and tenant switcher are the canonical Connect tenant entry points. Disconnecting the last tenant leaves the shell available and never destroys unrelated provider, registry, or local draft state. Agents still cannot run, Graph cache refreshes still cannot start, and Changes still cannot load tenant data without an active tenant.

Answered chat question means the local chat store contains at least one completed assistant message. Empty draft conversations, failed responses, and stopped responses do not count.

North-star metric: time from install to first successful result, target under 5 minutes. Measured locally only (no telemetry — consistent with constraint 1).

### Glossary (naming decisions)

| Term | Status | Meaning |
|---|---|---|
| Chat | Nav label (was "Intune Chat") | Plain-language tenant Q&A. Internal ids keep `intune-chat`. |
| Agent | Unchanged | Installable module with declared scopes and read/write mode |
| Hub | Tab inside Agents (was "Agent Hub" nav item) | Community agent store |
| Schedule | Tab inside Agents | Recurring agent runs |
| Workspace | Demoted to Settings | Saved multi-tenant working set |
| Connector | Demoted to Settings | External integration (non-Graph) |
| Run history | Replaces "Activity" as user-facing term | Past and active runs |
| Tenant | Unchanged | The Microsoft 365 tenant |
| Provider | Unchanged | LLM backend |

### Quality implementation decisions (locked for v0.4)

- Stable wording introduced by the v0.4 pass lives in typed copy modules. Trust messaging, Settings search entries, recoverable Chat errors, and agent display names have one derivation or formatting path rather than per-surface variants.
- StatusStrip is the canonical persistent tenant/provider/data-boundary surface. Local Chat does not need a second long trust explanation; hosted and attached-context sends retain explicit boundary confirmation.
- `Mod+K`, `Mod+N`, and `Mod+,` are defined once and shared by visible labels, renderer handling, and the native application menu.
- Dialogs and the Command Palette use one topmost-Escape model, dialog/combobox semantics, initial focus, focus trapping, and focus return. Escape never confirms an action.
- Chat send/stream/stop/fail/retry behavior is an explicit tested state machine. A failed question remains available to Retry, and retry re-enters the same tenant, hosted-provider, and workspace-context checks.
- Conversation drafts use per-conversation `sessionStorage` for v0.4. Drafts remain on the device, survive route changes within the session, clear after a successful send, and are never sent without the user action.
- Persisted conversations use `/chat/:conversationId` and Settings sections use `/settings/:section`. Reload and browser history restore those selections; `/chat` remains a new draft, and deleted or unknown conversation links render an explicit local recovery state instead of silently selecting another conversation.
- User-visible error details pass through the typed copy sanitizer before rendering. Stack frames, local paths, multiline exceptions, and oversized implementation details stay out of Chat, Settings, and write confirmation surfaces while short actionable provider or tenant messages remain visible.
- Hosted multi-tenant consent is recorded as a one-response acknowledgement. The batch modal does not offer a remembered-consent choice, so its audit payload must not claim one; every later hosted batch prompts again.
- At 1100 px and below, Chat history closes into a full-text overlay drawer; it never becomes a numbered mini-rail. The primary navigation frame remains fixed. Production screenshot evidence covers seven states, including typed write confirmation, at 900, 1100, and 1600 px with long tenant/model fixtures, default and reduced-motion lanes, and page-level overflow failure.
- Informative metadata uses at least 11 px and a minimum 4.5:1 token contrast on production surfaces. Placeholder text uses `--color-text-placeholder` and holds 4.5:1 on every input surface; `--color-text-faint` is decorative-only. Accent-filled controls use `--color-on-accent` rather than hardcoded ink literals. Semantic foreground tokens hold 4.5:1 on their paired soft backgrounds over every production surface. Reduced-motion and forced-colors fallbacks are global.
- Newly enabled schedules anchor their first due time at the enable action; enabling an interval never creates an immediate surprise run.
- Destructive write plans require a count-bound uppercase phrase that names the operation and target. The same grammar is enforced for declarative manifests, sandboxed plans, and runtime plans before the confirmation UI can appear.
- Connector execution fails closed: undeclared capabilities are rejected, and side-effect capabilities cannot run when the confirmation bridge is absent.
- Desktop release metadata is `0.4.3`. CI and tag-release workflows run typecheck, unit/renderer tests, Graph/registry QA, generated-doc checks, upgrade-compatibility checks, build, and both Electron smoke flows before packaging. Automatic version tagging waits for the exact `main` commit to pass CI, including any generated-doc reconciliation required after a squash merge. Linux self-update is disabled while executable packages remain unsigned; apt repository trust or an explicit package install is required. The apt repository requires its private signing key; a passphrase is optional so existing unencrypted repository keys remain supported. Signed supported builds surface update failures in a retryable in-app banner.

### Deliberately not done in v0.4

- No merge of Workspaces/Connectors page code into Settings.tsx — they stay separate routes, only nav placement changes (cheap, reversible).
- No LLM-driven agent suggestions in chat — matching is deterministic, local keyword/category matching against installed manifests.
- No platform-specific screen-reader integration or release-evidence gate. Platform-neutral keyboard, focus, semantic, contrast, forced-colors, and reduced-motion support remains part of the production UI.
- Usability validation with 3–5 external Intune admins is still owed; these decisions are the best pre-validation guess and should be revisited against real hesitation points.

---

## 5a. v0.1 — Public preview foundation

The first public-preview milestone. Goal: a polished Electron app that visually represents the full product vision, runs one agent end-to-end against synthetic data, and is paired with a public landing page with download, GitHub, trust-model, registry, and write-confirmation proof points. Built to generate screenshots, demo videos, downloads, and GitHub interest while establishing the public preview path toward real-tenant deployment.

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

1. **Guided first-run activation**: the real Chat-first shell opens immediately, and a zero-tenant launch auto-opens the setup dialog (see §4a). Tenant permissions, browser sign-in, and provider readiness otherwise appear only when a tenant-backed action is attempted, then return to an explicit resume review. <90 seconds from the first tenant-backed action to a grounded chat answer or successful agent run.
2. **MSAL consent flow** — Lawyer-grade transparency about Graph scopes requested. Read scopes only by default; write scopes requested per-agent at install time.
3. **LLM provider configuration** — All 5 providers, test connection, model dropdowns populated by querying the provider, per-agent overrides.
4. **Diff confirmation for write agents** — Side-by-side before/after, scope summary, typed confirmation for destructive actions.
5. **Error and failure states** — Designed states for: auth expired, Graph throttling, Ollama unreachable, model JSON validation fail, missing scope, hosted quota exceeded, tenant drift, network offline. (Reference: `docs/mockups/06-error-states.html`.)
6. **Empty states** — Zero agents installed, zero runs, zero tenants. These teach new users what the product is for.
7. **Registry browse** — Search, filter (author, mode, model requirements), install, signing/verification status, screenshots, changelog.
8. **Multi-tenant switcher done properly** — Search, color-coding, "currently scoped to" badges, scope guard against running an agent on the wrong tenant.
9. **Teams connector (graph-delegated)** — first connector to validate the abstraction. Channel + chat picker, post-message capabilities, Teams scopes folded into the MSAL consent flow, trust messaging integrated with the status strip. See §2 Connector abstraction.
10. **WhatsApp Web connector (external local session)** — second connector to validate QR-based local setup and non-Graph egress. QR linking, default/test target selection, outbound-only run notifications, no incoming-message access, Baileys reconnect handling, and explicit "delivered by WhatsApp" trust messaging. See §2 Connector abstraction.
11. **Notification connector set** — Outlook, Slack, Discord, and Signal are implemented as outbound-only run-report targets. Outlook uses delegated Graph `Mail.Send`; Slack uses a stored bot token; Discord uses a stored webhook URL; Signal uses local `signal-cli` or a local REST bridge. None of these connectors read inboxes or chat histories.

### Important (in v1.0, doesn't have to be perfect)

- Scheduled runs are available for installed agents. The UI creates the per-agent recurrence; once at least one Microsoft tenant is connected, OpenAdminOS can register a per-user OS scheduler so due runs continue while the UI is closed. macOS uses `~/Library/LaunchAgents/com.openadminos.scheduler.plist`; Windows uses Task Scheduler. Jobs still run as the signed OpenAdminOS app for the logged-in user, use the persisted MSAL token cache, write results to local history, and do not run when the machine is off or no user session exists. The Schedules view prioritizes active schedules, next run, last run, and recent scheduled activity. OS registration and scheduler errors are shown as compact remediation notices only when the user needs to act.
- A macOS-only menu bar companion is planned as an optional bundled surface inside the signed OpenAdminOS app package. It shows active tenant, provider trust, cache freshness, scheduler state, upcoming schedules, recent activity when there is actual work to inspect, and a compact read-only Intune Chat prompt entry point. It is not an error center: passive run failures, cache refresh errors, provider failures, and scheduler diagnostics stay in the full desktop app instead of being reported as issue cards in the popover. It must call the same host-owned services as the full app, persist to the same local SQLite store, and route write confirmations, hosted-provider first-use confirmation, tenant setup, provider setup, and long investigations to the full desktop window. The current implementation uses the OpenAdminOS app icon as the Electron Tray status item, a frameless `#/companion` renderer route with Ask as the primary flow plus compact schedule/activity sections, shared preload IPC, a `--menu-bar` launch mode, Settings -> General launch-at-login controls, and a generated nested Swift helper bundle at `OpenAdminOS.app/Contents/Library/LoginItems/OpenAdminOS Menu Bar Helper.app`. Packaged builds register that helper through Electron's macOS `loginItemService` settings so the helper starts OpenAdminOS in tray-only mode; development builds fall back to the main-app login item path. See `../vision.md`.
- Notification routing (per-agent: OS notification / email / connector). Built on the Connector abstraction; Teams, WhatsApp Web, Outlook, Slack, Discord, and Signal are wired through this surface. Agents can save delivery rules that post terminal run reports to either the connector default target or a per-agent target where that connector supports one, with manual/scheduled, success/failure, and changed-only controls. Per-agent delivery rules autosave when the admin enables a connector, changes a target, or changes delivery checkboxes; starting a run waits for any in-flight delivery save so the run uses the latest rule. Saved delivery rules are explicit approval to post without another prompt. Connector delivery appends post-run activity steps so the run timeline shows sent, failed, or skipped delivery outcomes after the agent result is created. Connector delivery is queued locally when a run reaches a terminal state, retried with bounded backoff for transient failures, and processed again on app reopen or scheduler ticks. Basic OS run-completion/failure notifications already exist. Each schedule can opt into success notifications, failure notifications, and "only when findings change." Scheduled run records are stamped with `changeState: new | changed | unchanged` by comparing the latest scheduled output to the prior successful scheduled output for the same agent.
- Agents should not hard-code routine Teams, WhatsApp, Outlook, Slack, Discord, or Signal posting when per-agent delivery rules can handle it. Connector steps remain appropriate when the connector call is the agent's core behavior; recurring report delivery belongs to the installed-agent delivery settings so admins can route the same result locally, to one connector, or to multiple targets.
- Manual agent runs open a preflight review before queueing. It shows the active tenant, provider residency, model, mode, and Graph scopes. It blocks when no tenant is active, warns when hosted providers are selected, and flags scopes that may trigger Microsoft incremental consent.
- Provider trust messaging is scoped to the surface: overview/settings/chat/status surfaces use the current active tenant/provider/default model, while queued run reports use the run's pinned tenant, provider, and model rather than the current global tenant/provider selection.
- Settings -> About includes a local release-readiness panel for support and demo prep: app version/build mode, notification availability, OS scheduler registration, menu bar launch state, active tenant, active LLM, Codex/Ollama detection, and registry state. These diagnostics are local UI state, not telemetry.
- Support issue reporting is visible from failed-run remediation cards and Settings → About, not as permanent sidebar navigation. It creates a public GitHub issue only after the admin reviews the form and explicitly confirms public submission; the desktop posts to the OpenAdminOS web API, and only the server holds the repo-scoped GitHub token. The same flow can export a local diagnostics JSON file for separate review. No background upload, desktop GitHub token storage, session replay, screenshot capture, or crash-triggered issue submission.
- Agent report streaming is part of the run experience. LLM providers should expose `RunLlmApi.stream()` where possible; the runtime publishes best-effort `RunRecord.liveSummary` while the current LLM step is generating, and clears it when the terminal `summary` is written. Ollama streams through its native chat API. OpenAI Codex runs through `codex exec --json` and consumes message deltas when the installed CLI emits them, falling back to the final assistant message when the CLI only emits completion events.
- Run history with filters (agent, tenant, date, status) and configurable
  retention for old eligible records
- Audit log export (JSON/CSV with SHA-256 hash chain; signed timestamps deferred)
- Keyboard shortcuts (⌘K palette, ⌘R rerun, ⌘/ search, ⌘? help)
- Agent permissions inspector (browser-extension-style permission screen pre-install)
- Update / version management (pin by default, explicit upgrade, changelog visible)
- Non-run diagnostic log export and retention policy (where stored, how big,
  when rotated)

### Designed before launch (not strict blockers)

- **Enterprise external connector: ServiceNow (`external` auth)** — proves the Connector abstraction generalizes to enterprise ticketing. Instance URL, keychain credentials, "data leaves your tenant" trust messaging. Designed after the Teams and WhatsApp Web connector surfaces stabilize.
- Agent signing / verification (registry supply-chain integrity)
- Sandbox / dry-run mode for read agents (preview Graph calls before executing). v0.2.3 adds an experimental MXC probe/runner behind `OPENADMINOS_EXPERIMENTAL_MXC=1`, but YAML Agent Templates remain the default execution model.
- Cost budgets & rate limits (per-agent or per-day spend caps for hosted LLMs)
- Localization framework (DE/NL/FR are the priority markets after EN)
- Accessibility audit (WCAG AA contrast, keyboard nav, screen reader labels)
- Opt-in product analytics (Posthog self-hosted or similar; aggregated, never per-tenant)
- Opt-in crash reporting (Sentry-equivalent for app crashes only)
- Auto-update channel (`electron-updater` against signed releases; needed for security patching)
- Offline / partial connectivity behavior (retry, cached state, resume on reconnect)

### v0.2.3 experimental sandbox stance

MXC support is intentionally an experimental host capability, not a shipped community-agent trust boundary. `@microsoft/mxc-sdk` is an optional dependency and sandboxed code is off by default. `OPENADMINOS_EXPERIMENTAL_MXC=1` only seeds the launch default; the desktop stores the actual user choice behind Settings -> General -> Experimental sandboxed code. Settings -> About reports the local sandbox state so support bundles can show whether the host has MXC available, disabled, unsupported, or failing probe. The diagnostic record includes the SDK-reported available methods, Windows isolation tier, and host-prep warnings when the current SDK exposes them. The detail text also explains that normal YAML Agent Templates keep using the manifest interpreter, while code-backed preview agents fail closed when MXC is disabled or unavailable.

The sandbox boundary protects the local machine from future untrusted code execution. It does not replace OpenAdminOS' tenant safeguards. Sandboxed agent code must not receive MSAL tokens, keychain secrets, provider credentials, connector credentials, unrestricted filesystem access, direct network access, clipboard access, or UI automation. Any future sandboxed TypeScript agent must communicate with the trusted Electron main process over the sandbox broker protocol: `graph.request`, `llm.complete`, `connector.invoke`, `write.plan`, and `log`. The host validates every broker request against the installed manifest, active tenant, declared Graph scopes, provider residency rules, connector capability confirmation, and the existing typed write-confirmation gate before executing it.

Default policy for MXC process runs is: read-only agent/runtime bundle, one per-run read-write temp directory, no outbound network, scrubbed environment, no window access, bounded stderr capture, broker-only host access, and a per-run timeout. `cwd` is written into `config.process.cwd`, but it must also be covered by `readonlyPaths` or `readwritePaths`; Microsoft documents that setting a working directory does not grant filesystem access. OpenAdminOS passes the MXC SDK's `experimental` spawn option only for MXC backends that require it (`vm`, `microvm`, `windows_sandbox`, `wslc`, `hyperlight`, `seatbelt`, `isolation_session`, and macOS `process` because it resolves to seatbelt). Stable one-shot backends such as Windows `processcontainer`, Linux `bubblewrap`, and Linux `lxc` do not get the SDK experimental flag merely because OpenAdminOS' own feature flag enabled the integration. Script agents use file-based broker IPC inside the per-run read-write temp directory via `OPENADMINOS_BROKER_DIR`: sandbox code writes `*.request.json`, the host validates and responds with `*.response.json`, and human-readable guest diagnostics belong on stderr or in `log` broker calls. The lower-level sandbox runner still supports newline-delimited stdio brokering for focused runtime tests, but app script agents do not rely on interactive stdio because macOS Seatbelt/MXC can echo or buffer PTY streams. `graph.request` is GET-only and must match manifest-declared Graph operations, including declared `$select` subsets. `llm.complete` is host-executed and cannot switch away from the active model. `connector.invoke` is allowed only for declared connector capabilities and still passes through the connector confirmation/audit wrapper. `write.plan` can only return a validated plan for a write-mode agent; it cannot apply Graph writes. Script agents return their read result by writing `result.json` inside the per-run read-write temp directory. If MXC is disabled or unavailable, OpenAdminOS must fail closed for untrusted-code backends; it must not silently fall back to in-process execution. Until MXC exits public preview and OpenAdminOS has signing plus broker enforcement tests in the desktop run path, community sharing remains YAML Agent Templates plus README/fixtures/metadata, not arbitrary TypeScript execution.

`execution.kind: script` is the first explicit code-backed manifest contract. The built-in Intune Device Posture Auditor uses it to run `agent.mjs` in MXC while the manifest's `skills` declare the broker policy for Graph and LLM calls. The sandboxed script reads managed-device posture through `graph.request`, computes compliance, sync-age, ownership, enrollment, missing-primary-user, and duplicate-name signals locally inside the sandbox, asks the active host LLM for the final summary through `llm.complete`, and writes the final report to the host-owned temp result file. This path was verified on macOS Apple Silicon with the MXC SDK reporting `seatbelt`, including the packaged Electron-as-Node runtime path used by the desktop app. Packaged macOS builds bundle the MXC SDK executor under `Contents/Resources/native/mxc-sdk/bin` and set `MXC_BIN_DIR` for the SDK before probing or spawning so users do not need a separate `mxc-exec-mac` install for the built-in preview agent. This preview path is built-in only; user-authored and community-submitted agents remain YAML Agent Templates until the setting, packaging story, and maintainer review policy are hardened.

Enterprise host preparation is explicitly admin-owned. On Windows, MXC's `wxc-host-prep.exe` may be needed for AppContainer-tier preparation such as system-drive and null-device ACLs. Current MXC host-prep commands are `prepare-system-drive` for system-drive ACLs and `prepare-null-device` for the NUL device, with the null-device preparation expected once per boot when that tier is selected. OpenAdminOS reports probe state, isolation warnings, and remediation copy, but it does not elevate itself, run host-prep automatically, or persist any privileged setup action. Linux/macOS preparation similarly stays outside the app: admins install the MXC SDK/native backend appropriate for their managed fleet, then re-run the Settings -> About probe.

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
| `01-onboarding.html` | Historical blocking first-run setup | ⚪ Superseded |
| `02-msal-consent.html` | Graph permissions screen | ✅ Done |
| `03-agents-grid.html` | Home / agents list | ✅ Done |
| `04-live-run.html` | Live run modal overlay | ✅ Done |
| `05-diff-confirm.html` | Write-agent diff confirmation | ✅ Done |
| `06-error-states.html` | 8 error patterns reference | ✅ Done |
| `07-llm-provider.html` | LLM provider configuration | ✅ Done |
| `08-tenant-switcher.html` | Multi-tenant management | ✅ Done |
| `09-registry.html` | Community agent registry browse | ✅ Done |
| `10-empty-states.html` | First-time user empty states | ✅ Done |
| `11-multi-tenant-chat.html` | Multi-tenant Intune Chat scope review and result artifact | ✅ Done |
| `12-workspaces.html` | Single-tenant Workspaces investigation surface | ✅ Done |
| `13-v0.4-one-surface.html` | Interactive Chat-first, single-contextual-rail UX exploration | 🟡 Proposed |
| `14-v0.4-implemented-review.html` | Interactive review of the implemented three-destination navigation and full-text Chat history drawer | ✅ Done |
| `15-contextual-setup.html` | Chat-first contextual tenant and provider activation | ✅ Done |
| `16-training-conveyor-concepts.html` | training.openadminos.com direction exploration (conveyor metaphor) | ⚪ Superseded |
| `17-training-railway-concepts.html` | training.openadminos.com style exploration (railway metaphor, four styles) | ⚪ Superseded ("Flap Hall" chosen) |
| `18-baseline-rollback.html` | v0.5 baseline drift, field-level evidence, and typed rollback confirmation | ✅ Done |
| `19-fleet.html` | v0.5 multi-tenant fleet drift status and per-tenant write confirmation | ✅ Done |
| `20-mcp-gateway.html` | v0.5 gateway settings, pairing, connected clients, and pending external proposals | ✅ Done |
| `21-telemetry.html` | v0.5 opt-in usage telemetry with the exact payload preview | ✅ Done |

When implementing screens in production code, port the design tokens from `_design.css` to the production app's theme system (Tailwind config or CSS variables in the global stylesheet). Build the components listed in §3 as proper React components, not as one-off implementations per screen.

### training.openadminos.com (decided 2026-08-29)

The model program's public "trained in public" page ships as a `/training` route inside `web/` (served on the training subdomain via a host rewrite; the domain itself must be attached to the Vercel project). Decisions locked during the concept rounds:

- **Design**: the "Flap Hall" direction — a split-flap departure board over a railway line where each training run is a train that dwells at pipeline stations (Generate → Validate → Train → Quantize → Evaluate → Review → Release). Held runs sit on a siding; a run only passes Review by human decision.
- **Data**: the page renders exclusively from `model/site/public-data.json` (schemaVersion 2), validated at build time. The benchmark chart uses only the exporter's `featured` series, which guarantees every displayed score carries its suite hash and retrieval condition. No hand-transcribed numbers.
- **Live state**: an authenticated `/api/training/run-state` route (Upstash) that the GPU pod posts to; the page is idle by default (released train parked at the terminus), shows live state only when fresh, and labels stale state honestly. No simulated runs in production.
- The interim concept mockup (`18-training-site-flaphall.html`) was removed once the production route landed; 16/17 remain as design history. The v0.5 capability mockups reuse numbers 18 to 21.

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
- Defender for Endpoint device actions (isolate machine, live response, etc.). These use the separate `api.security.microsoft.com` API rather than Microsoft Graph. v0.5 is Graph-only; Defender is a read/report surface (alerts, incidents, Secure Score), not an action surface. Revisit if there is demand for a second non-Graph client.
- Third-party configuration baseline content (for example OpenIntuneBaseline). Decided 2026-08-29: OpenAdminOS ships no bundled or derived third-party baselines, ever. Baseline content is user-generated only, via own-tenant exports.

---

## 8a. v0.5 capability surfaces

v0.5 adds four capability areas on top of the drift timeline; each maps to an acquirer-visible signal.

**Governed MCP write-gateway.** A local, loopback-only (127.0.0.1) MCP server, off by default, authenticated by a single pairing token held in safeStorage and bound to exactly one tenant at enable time. External AI clients get the same read-only tool allowlist as Chat. The only write capability is `propose_write_plan`: proposed actions are validated against the bundled Graph endpoint catalog (unknown endpoints rejected), turned into a standard `WritePlan`, and queued as an `external-proposal` system run that requires the normal typed confirmation in the desktop app. No external client can apply a change; a proposal can only be reviewed, confirmed, or rejected by a human. Apply is fail-stop and shares the rollback apply path.

**Retrieval.** Local documentation grounding ported from the model bench's `retrieve.mjs`: a locally installed index (Intune/Entra/Defender docs, matched to one embedding model) is cosine-ranked against the question, with source-file provenance on every hit. Query embedding hits a loopback embedding server and refuses any non-loopback endpoint, so a local provider never sends the question off-device. A missing index is a designed "not documentation-grounded yet" state, not an error. Index distribution (first-run download of the ~263 MB index) and the embedding-model serving are host infrastructure tracked separately; the ranking engine and honest states ship in v0.5.

**Opt-in usage telemetry.** Off by default. Counts and versions only: a resettable anonymous install id, app version, OS/arch, whether the active provider is local or hosted, and bucketed (never exact) tenant/agent/run counts, plus whether a retrieval index is installed. Never tenant content, tenant ids, prompts, run results, or error text. The Privacy preview shows the exact JSON, and the send path serializes that same payload, so preview and wire can never diverge. Nothing is sent unless the user opts in AND the build has a collector URL configured (empty by default).

**Fleet.** For installs with two or more tenants, a Fleet view aggregates each tenant's active baseline, drift counts, and last capture time, filterable by tenant group. Multi-tenant runs keep per-tenant confirmation for writes.

---

## 9. Adjacent products in the OpenAdminOS portfolio

For context — these exist or are in flight, and may interact with OpenAdminOS over time:

- **TenantPDF** (tenantpdf.com) — hosted SaaS for branded tenant documentation PDFs. Future integration: OpenAdminOS run reports could export via TenantPDF.
- **IntuneDocumentation** (legacy) — frontend PDF generation tool.
- **IntuneGet-FrontBackend** (legacy) — multi-tenant auth experiment.
- **IntuneTUI** (deprecated) — terminal-based Intune tool. The lesson from this project drove OpenAdminOS' decision to use a desktop GUI instead of a terminal — admins are not developer-y enough for TUIs as a primary surface.

OpenAdminOS is the flagship community project. The others are either narrow paid products (TenantPDF) or instructive prior art.
