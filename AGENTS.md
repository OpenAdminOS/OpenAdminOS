# AGENTS.md — Operating Instructions

You are building **OpenAdminOS** — an open-source, local-first desktop platform for Microsoft Intune & Entra administrators to run AI agents against their tenants. This file tells you how to work on this codebase. Read it fully before doing anything else.

---

## What this project is

OpenAdminOS is a **TypeScript monorepo** that ships as a polished **Electron desktop app** (Windows + macOS, Linux best-effort). One codebase, one surface — there is no CLI.

The product lets a Microsoft 365 admin:
1. Connect a tenant via MSAL (Graph API).
2. Pick an LLM provider (Ollama or LM Studio for local; Anthropic, OpenAI, or Azure OpenAI for hosted).
3. Browse a community-contributed registry of agents (each agent is a TypeScript module with declared Graph scopes and a read/write classification).
4. Run agents against the tenant — read-only agents run autonomously, write agents always pause for diff confirmation.

The trust story is **local-first**: tenant data and prompts never leave the device when a local LLM is used. UI messaging changes honestly when a hosted provider is selected.

The reference architecture is t3.gg's **t3code** project (https://github.com/pingdotgg/t3code) — Electron + Vite + React monorepo with a clean provider-adapter pattern. Study its shape before structuring this one. Don't copy the Effect runtime adoption wholesale; do copy the directory layout, contracts package, and adapter pattern.

---

## How to work in this repo

### Read SPEC.md before writing any code

`docs/SPEC.md` is the source of truth for product decisions, architecture choices, design system, and screen-by-screen UX. If anything in code conflicts with SPEC.md, the spec wins unless you've explicitly proposed a change and gotten approval.

### Reference the mockups for visual decisions

`docs/mockups/` contains 8 fully-designed HTML mockups using the production design system. When building any UI, open the relevant mockup first. The CSS variables in `docs/mockups/_design.css` are the design tokens — port them directly to the production app's theme system.

Mapping:
- `01-onboarding.html` → first-run setup flow
- `02-msal-consent.html` → Graph permissions screen
- `03-agents-grid.html` → home / agents list
- `04-live-run.html` → live run modal
- `05-diff-confirm.html` → write-agent diff confirmation
- `06-error-states.html` → error state reference page (8 patterns)
- `07-llm-provider.html` → LLM provider configuration
- `08-tenant-switcher.html` → multi-tenant management

### Three screens are still un-mocked

Build these from scratch using the design system established in the existing mockups:
- **Registry browse** (community agent marketplace)
- **Empty states** (zero agents installed, zero runs, zero tenants)
- **Diff confirmation deep variants** (different write-agent action types)

When you build them, save them as `docs/mockups/09-registry.html`, `docs/mockups/10-empty-states.html`, etc., so they live alongside the others as design reference.

### Commit discipline

- One conceptual change per commit.
- Commit messages: `area: short imperative summary` (e.g. `runtime: add per-agent cost tracking`, `ui: empty state for zero tenants`).
- Don't bundle unrelated changes — if you touched something incidental, commit it separately.

### When in doubt, ask

Decisions that are *not* in SPEC.md should be flagged, not invented. If you're choosing between two reasonable approaches and the spec is silent, leave a `// TODO(ugur): <question>` comment and surface the question rather than picking unilaterally. This applies especially to:

- Naming choices (public API surface, package names, route names)
- Defaults that affect trust messaging (which LLM provider is default, what telemetry is on/off)
- Any external dependency added (license, maintenance, supply-chain risk)

---

## Hard constraints

These are non-negotiable. If you find yourself about to violate one, stop and ask.

1. **Tenant data and LLM prompts never leave the user's machine when a local provider is selected.** No tenant-content, prompt, run-result, analytics-event, or error-reporting telemetry. When a hosted provider is selected, the UI must honestly state where data goes (e.g., "Anthropic API · US").

2. **Write agents always pause for diff confirmation.** No "skip this prompt" toggle. No "trust this agent" exception. Every write operation gets human-in-the-loop approval, every time. Destructive operations require typed confirmation (e.g., user must type `RETIRE 47 DEVICES` to proceed).

3. **No agent runs without an active tenant scope.** The current tenant is shown in the status strip at all times. If the tenant context is ambiguous or expired, agents cannot start.

4. **No silent failures.** Every error has a designed state with a clear recovery path (see `06-error-states.html`). Generic "something went wrong" messages are forbidden.

5. **One UI, one surface.** The desktop app is the only end-user surface. No CLI fork, no separate web tree. Repo scripts and contributor tooling are not the same thing as a published end-user CLI.

6. **Open-source from day one.** Public GitHub repo, MIT license, contributing guide, code of conduct. No "we'll open source it later" — it's open from commit zero.

---

## Stack

- **Language:** TypeScript everywhere
- **Monorepo:** pnpm workspaces + Turborepo
- **Desktop:** Electron (main + preload + renderer)
- **Renderer UI:** Vite + React + React Router + Tailwind. Note: SPEC.md previously said Next.js 14 App Router — for the Electron renderer that's overkill (no SSR, no app/route boilerplate needed). Vite is the right call. Next.js stays for `apps/marketing/` only.
- **Marketing site:** Next.js, deployed to Vercel at openadminos.com
- **MSAL:** `@azure/msal-node` for tenant auth, Graph API for everything else
- **LLM abstraction:** A pluggable provider interface; concrete implementations for Ollama, LM Studio, Anthropic-via-Codex, OpenAI-via-Codex, Azure OpenAI. Where possible, piggyback on locally-installed vendor CLIs (Codex, Codex) to avoid storing API keys and to inherit the user's existing vendor auth.
- **Agent registry:** GitHub-hosted (like Home Assistant integrations); each agent is a TypeScript module with a manifest declaring scopes, read/write mode, model requirements
- **Local storage:** SQLite (via `better-sqlite3`) for run history, tenant configs, agent installations. OS keychain (`keytar`) for secrets.
- **Code signing:** Windows EV cert + Apple Developer Program + notarization, driven by `electron-builder` (deferred but the build pipeline must accept signing as a step from day one)
- **Auto-update:** `electron-updater` against signed GitHub releases

---

## Project naming and identity

- Product name: **OpenAdminOS**
- Domain: **openadminos.com**
- GitHub: **github.com/OpenAdminOS/OpenAdminOS**
- Tagline: *"Open-source, local-first agents for Microsoft 365 admins."*

The brand is restrained — no AI-hype language, no "intelligent" or "smart" adjectives, no gradient swooshes. The visual identity is utilitarian, dense, terminal-adjacent. See the mockups for the established tone.

---

## What to build first

The current focus is **v0.1 — Private preview showcase**, scoped in `docs/SPEC.md` §5a. The phased plan with acceptance criteria lives in `tasks/todo.md`. Read both before starting work. The longer pre-1.0 path is in SPEC.md §5 — don't jump ahead of v0.1 unless something is blocking it.

Order of attack for v0.1 (full detail in `tasks/todo.md`):
1. Monorepo scaffold: pnpm + Turborepo, `apps/desktop` (Electron + Vite), `apps/marketing` (Next.js), shared `packages/*` shells. End state: `pnpm dev` opens an Electron window with the dark theme.
2. Design system: port `_design.css` tokens to Tailwind, build core primitives and layout shell.
3. Screen implementation: all 8 designed mockups + 2 new (`09-registry`, `10-empty-states`) as React routes with mocked data.
4. LLM abstraction + Ollama provider: real interface, real streaming, smoke test.
5. Sample agent + synthetic Graph data layer: one read-only agent runnable end-to-end.
6. Marketing site at openadminos.com with download, trust-model, registry, and write-confirmation sections.
7. Polish, screenshots, demo video, tag v0.1.0.

---

## Tone for any user-facing copy

Honest, plain, slightly dry. No exclamation marks. No "Great choice!" or "Awesome!" affirmations. Admins are professionals — talk to them like one.

Examples of the right voice (pulled from the mockups):
- "Connecting tenant requires admin consent. You'll be redirected to Microsoft to approve these scopes."
- "Local-only · No data leaves this device"
- "This will retire 47 devices. Type RETIRE 47 DEVICES to confirm."
- "Ollama isn't running. Start it with `ollama serve`, then try again."

Examples of voice to avoid:
- "🚀 Ready to supercharge your workflow?"
- "Our intelligent agents will revolutionize how you manage Intune!"
- "Oops! Something went wrong. Please try again."

---

## When you're done with a task

End every session by updating `docs/SPEC.md` if any decisions were made or constraints discovered, and add a one-line entry to `CHANGELOG.md` under the `[Unreleased]` section. This is how Uli stays in the loop without having to read every diff.
