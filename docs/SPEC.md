# Open Agents — Product Specification

> Source of truth for product decisions, architecture, design system, and roadmap. Read this before writing code. If reality diverges from this doc, update the doc as part of the same change.

---

## 1. What we're building

**Open Agents** is an open-source desktop platform for Microsoft 365 administrators (initially Intune & Entra) to run AI agents against their tenants. Agents are TypeScript modules contributed by the community, run locally on the admin's machine, and operate against the tenant via Microsoft Graph.

The product is local-first: by default, tenant data and LLM prompts never leave the user's device. The user can opt into hosted LLM providers (Anthropic, OpenAI, Azure OpenAI), and when they do, the UI honestly reflects that data leaves the device.

### Distribution surface

- **Desktop app** (Electron, Windows + macOS + Linux, signed installers) — the only end-user surface

There is no separate CLI. Power users get the same GUI; contributor tooling (agent scaffold, dev/test commands) lives in repo scripts, not in a published `npx` binary.

### Audience

- Primary: Microsoft 365 / Intune / Entra administrators in mid-to-large organizations and MSPs
- Secondary: IT consultants, MVP community members, scripting-fluent admins
- Explicitly NOT: end users, developers building general-purpose AI apps, hybrid AD admins

### Why this exists

Most AI tools for IT admins today are wrappers around ChatGPT — single-purpose, cloud-only, no extensibility. Open Agents is a **platform**: the runtime, the registry, the trust model. Community-contributed agents accumulate over time. The closest mental model is **Home Assistant for Microsoft 365 admins** — local-first runtime, GitHub-hosted integrations, opinionated UX.

---

## 2. Architecture

### Monorepo layout

```
openagents/
├── apps/
│   ├── desktop/              # Electron main + preload + renderer (Vite + React)
│   └── marketing/            # Public marketing site (openagents.sh) — Next.js
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

The cost we accept: ~80–150MB installer size (vs ~5–10MB Tauri), ~150–250MB idle memory per window. For an IT-admin tool on managed devices this can pinch corporate deployment limits, but it's not a blocker. Trust posture is *architectural* (no telemetry, local-first, write confirmation), not framework-derived.

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

Per-agent model overrides are required: an agent's manifest can specify a preferred model and the user can override it.

### Agent contract

An agent is a TypeScript module with a default-exported manifest and a `run` function:

```ts
export default {
  id: 'intune-compliance-check',
  name: 'Intune Compliance Check',
  description: 'Lists devices that fall out of compliance and suggests remediation.',
  author: { name: 'ugurlabs', verified: true },
  version: '1.2.0',
  mode: 'read',                        // 'read' | 'write'
  scopes: [                            // Graph permissions required
    'DeviceManagementManagedDevices.Read.All',
  ],
  modelRequirements: {
    minContextTokens: 8000,
    preferredModel: 'claude-sonnet-4-7',
  },
  async run(ctx: AgentContext) {
    // ctx.graph — the Graph API client (auto-scoped to tenant)
    // ctx.llm — the LLM provider (auto-configured)
    // ctx.log — structured logging that streams to the UI
    // ctx.confirm(diff) — required for write agents; throws if user rejects
  },
};
```

### Registry model

The registry is a GitHub repository (e.g., `ugurlabs/openagents-registry`). Each agent is a directory containing the TypeScript source, a manifest, and a README. The desktop app fetches the registry index on demand, lets the user browse, and installs agents to a local directory. Installed agents are versioned and pinned by default — updates are explicit.

This is modeled directly on **Home Assistant integrations**. Read their docs (https://developers.home-assistant.io/docs/creating_integration_file_structure/) for the contributor experience pattern we're targeting.

### Local storage

SQLite via `better-sqlite3` for:
- Tenant configurations (encrypted via OS keychain for tokens)
- Installed agent registry
- Run history (full structured logs)
- LLM provider configurations (with hosted-provider API keys in OS keychain)

No cloud sync. No telemetry by default.

### Code signing

Required before public v1 release:
- **Windows:** EV certificate (~$400-600/yr), hardware token + cloud HSM for CI signing. Without EV, SmartScreen will warn users for weeks until the cert builds reputation.
- **macOS:** Apple Developer Program ($99/yr) + notarization. Without notarization, Gatekeeper blocks the app.
- Total: ~$500-700/yr, owned by the Ugurlabs UG entity.

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
| Telemetry default | Off | Local-first means local-first |
| Update model for agents | Pin by default, explicit upgrade | Avoids surprise behavior changes mid-shift |
| Tenant scope expiry behavior | Block all agent runs until re-auth | No partial-trust states |
| Multi-tenant switcher | Color-coded, search-first, scope-guarded | MSPs may manage 100+ tenants |
| Failed write agent recovery | Show diff of partial state, suggest manual review | Never auto-rollback |

---

## 5a. v0.1 — Private preview showcase

The first shippable milestone. Goal: a polished Electron app that visually represents the full product vision, runs one agent end-to-end against synthetic data, and is paired with a public landing page that captures private-preview signups. Built to generate screenshots, demo videos, and signups — not to be production-deployable against real tenants.

### What v0.1 includes

- Electron app shell (Win + Mac, Linux best-effort) with the full design system
- All 8 mockup screens implemented as real React routes (visual fidelity matching `docs/mockups/`)
- 2 new screens designed and built: registry browse (`09-registry.html`) and empty states (`10-empty-states.html`)
- LLM provider abstraction with one working provider (Ollama) — real connection, real streaming
- One sample read-only agent runnable end-to-end against synthetic Graph data
- Public marketing site at openagents.sh with email signup for private preview
- Hero screenshots (in README + landing page) and a demo video

### What v0.1 deliberately defers

- Real MSAL tenant connection (use mock tenant; OAuth flow lands in v0.2)
- Other LLM providers (LM Studio, Anthropic-via-Claude-Code, OpenAI-via-Codex, Azure OpenAI)
- Write agents and diff confirmation behavior (UI built for screenshots, no real writes)
- GitHub-backed registry (registry browse uses static JSON in v0.1)
- Persistent SQLite (in-memory + localStorage acceptable for v0.1)
- Code signing (build pipeline ready; certs deferred)
- Auto-update
- Audit log export, scheduled runs, notification routing — all v1.0 territory

### v0.1 acceptance criteria

1. Fresh clone → `pnpm install && pnpm dev` opens the Electron app in under 30 seconds.
2. All 10 screens reachable from sidebar/keyboard, visually matching mockups within 95% fidelity.
3. With Ollama running locally and a model installed: clicking "Run" on the sample agent streams real LLM output into the live run modal, completes successfully, displays structured results.
4. With Ollama not running: a designed error state appears with the correct recovery instruction (`ollama serve`).
5. Trust messaging flips correctly when toggling the LLM provider between local and (mocked) hosted in §07.
6. openagents.sh is publicly resolvable; signup form captures emails to a real backend (verified by submitting a test).
7. README includes a hero screenshot taken from the running app.
8. A 60–90s demo video is publicly viewable.

The detailed phased plan to reach these acceptance criteria lives in `tasks/todo.md`. SPEC.md owns *what*, `tasks/todo.md` owns *how* and *when*.

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

### Important (in v1.0, doesn't have to be perfect)

- Scheduled runs (recurrence, pause/resume, notification routing)
- Notification settings (per-agent, OS notification / email / Teams webhook / none)
- Run history with filters (agent, tenant, date, status)
- Audit log export (JSON/CSV with cryptographic timestamps for compliance buyers)
- Keyboard shortcuts (⌘K palette, ⌘R rerun, ⌘/ search, ⌘? help)
- Agent permissions inspector (browser-extension-style permission screen pre-install)
- Update / version management (pin by default, explicit upgrade, changelog visible)
- Logs export and retention policy (where stored, how big, when rotated)

### Designed before launch (not strict blockers)

- Agent signing / verification (registry supply-chain integrity)
- Sandbox / dry-run mode for read agents (preview Graph calls before executing)
- Cost budgets & rate limits (per-agent or per-day spend caps for hosted LLMs)
- Localization framework (DE/NL/FR are the priority markets after EN)
- Accessibility audit (WCAG AA contrast, keyboard nav, screen reader labels)
- Opt-in telemetry (Posthog self-hosted or similar; aggregated, never per-tenant)
- Opt-in crash reporting (Sentry-equivalent for app crashes only)
- Auto-update channel (`electron-updater` against signed releases; needed for security patching)
- Offline / partial connectivity behavior (retry, cached state, resume on reconnect)

### Polish (v1.1+)

- Tooltips and empty-state coaching
- Light theme + high-contrast theme
- Visual diff for complex objects (CA policies, conditional access)
- Run comparison ("what changed between last week and this week?")
- Sharing / collaboration (deep link to run, PDF export — TenantPDF integration)
- Agent authoring DX (`openagents agent init` scaffold, local dev/test mode, publish flow)
- Marketplace metadata (screenshots, video demos, changelog, support links per agent)
- Health dashboard (aggregated trust score across all agents on a tenant)

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

- **Sub-branding inside the product**: Open Agents is the project name; should the desktop app's window title also say "Open Agents," or is there a layer of brand inside the product (e.g., "Open Agents by Ugurlabs")?
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

## 9. Adjacent products in the Ugurlabs portfolio

For context — these exist or are in flight, and may interact with Open Agents over time:

- **TenantPDF** (tenantpdf.com) — hosted SaaS for branded tenant documentation PDFs. Future integration: Open Agents run reports could export via TenantPDF.
- **IntuneDocumentation** (legacy) — frontend PDF generation tool.
- **IntuneGet-FrontBackend** (legacy) — multi-tenant auth experiment.
- **IntuneTUI** (deprecated) — terminal-based Intune tool. The lesson from this project drove Open Agents' decision to use a desktop GUI instead of a terminal — admins are not developer-y enough for TUIs as a primary surface.

Open Agents is the flagship community project. The others are either narrow paid products (TenantPDF) or instructive prior art.
