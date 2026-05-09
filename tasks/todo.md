# v0.1 — Private preview showcase

**Goal:** A polished Electron app that visually represents the full Open Agents vision, runs one agent end-to-end against synthetic data, paired with a public landing page that captures private-preview signups. Built to generate screenshots, demo videos, and an audience — not to be production-deployable against real tenants.

Scope and acceptance criteria are codified in `docs/SPEC.md` §5a. This file owns the *how* and *when*. SPEC owns the *what*.

---

## Open questions to resolve before scaffolding begins

These should be answered before Phase 1 starts. Recommendations included; final call is Uli's.

1. **Vite vs Next.js for the desktop renderer.**
   - SPEC.md previously said Next.js 14 App Router. For an Electron renderer (no SSR, no server routes, no app/router boilerplate needed) Vite + React + React Router is significantly simpler, faster dev loop, and matches what t3code does.
   - Recommendation: **Vite for the renderer, Next.js only for `apps/marketing/`.** Already reflected in updated SPEC.md and CLAUDE.md.
   - Status: needs confirm before Phase 1.

2. **Mock tenant or real MSAL in v0.1?**
   - Real MSAL is multi-week work (registered Azure app, redirect URIs, scope consent UX, token refresh, OS keychain storage, multi-tenant). Not strictly needed for screenshots.
   - Recommendation: **Mock tenant in v0.1.** Build the consent screen as a static screenshot view. Real MSAL lands in v0.2.
   - Status: needs confirm.

3. **Email capture stack for openagents.sh signup.**
   - Options: Resend + Vercel Edge function + small Postgres table; ConvertKit; Tally embed; Formspree; Substack-as-newsletter.
   - Recommendation: **Resend + Vercel Edge function writing to a tiny Postgres (Neon free tier).** Self-owned data, no third-party form embed, ~30 minutes to set up. Can swap to ConvertKit later if newsletter cadence emerges.
   - Status: needs confirm.

4. **DNS / domain for openagents.sh.**
   - Where is the domain registered, and where does DNS live? (Cloudflare, Namecheap, Vercel-managed, etc.)
   - Need to know before Phase 6 deployment.
   - Status: needs Uli to confirm.

5. **Demo agent topic for the showcase.**
   - Candidates: "Find inactive devices (90+ days)", "List non-compliant devices", "Stale guest accounts", "Privileged accounts without MFA".
   - Recommendation: **"Find inactive devices (90+ days)"** — read-only, easy to fake convincingly, broad immediate appeal, screenshots well.
   - Status: needs confirm.

6. **Target date for v0.1 ready-to-demo.**
   - Affects scope cut decisions. A "by end of week" v0.1 looks very different from a "by end of month."
   - Status: needs Uli to set.

7. **Windows packaging in scope for v0.1?**
   - Building/signing/notarizing for Mac alone is ~half the work of also doing Windows. For screenshots + Loom, Mac-only is fine. Real Windows installer for v0.2.
   - Recommendation: **Mac-only build artifacts in v0.1.** Codebase stays cross-platform; we just don't ship Windows bundles yet.
   - Status: needs confirm.

8. **App icon / brand mark.**
   - Mockups show a placeholder "U" mark. Need a real app icon (PNG/ICO/ICNS sets) for the Dock/taskbar in screenshots.
   - Status: needs Uli to provide or commission.

---

## Phased plan

Each phase ends in a runnable, demonstrable artifact. Don't start the next phase until the prior phase's acceptance criteria are met.

---

### Phase 1 — Monorepo scaffold

**Deliverable:** `pnpm install && pnpm dev` opens an Electron window showing a "Hello Open Agents" page with the dark theme tokens loaded. TypeScript compiles, lint passes, the build pipeline produces a Mac `.app`.

- [ ] pnpm workspaces + Turborepo at the root
- [ ] `apps/desktop/` — Electron main process, preload, renderer (Vite + React + React Router)
- [ ] `apps/desktop/` build via `electron-builder` with placeholder signing config (no certs yet)
- [ ] `apps/marketing/` — Next.js 14 (deferred until Phase 6, but workspace shell created)
- [ ] `packages/ui/`, `packages/llm/`, `packages/storage/`, `packages/agent-sdk/`, `packages/runtime/`, `packages/graph/`, `packages/registry/` — empty workspace shells with `package.json` and a typed entry point
- [ ] Shared `tsconfig.base.json`, ESLint config, Prettier config
- [ ] Turbo pipeline for `dev`, `build`, `typecheck`, `lint`
- [ ] Root scripts: `pnpm dev` boots Electron in HMR mode; `pnpm build:desktop` produces `.app`
- [ ] `.github/workflows/ci.yml` running typecheck + lint on PR (no signing yet)
- [ ] Repo hygiene: `.gitignore`, `.editorconfig`, `.nvmrc` (or Volta config), `.prettierignore`

**Acceptance:**
- Fresh clone, fresh install, `pnpm dev` opens an Electron window in <30 seconds
- Window shows "Open Agents — v0.1.0-dev" with the `--bg-0` background and Geist + JetBrains Mono fonts loaded
- HMR works: edit a renderer file, see the change without a full reload
- `pnpm typecheck` and `pnpm lint` both pass
- `pnpm build:desktop` produces a `.dmg` on Mac

---

### Phase 2 — Design system

**Deliverable:** A `/design-system` route in the desktop app that renders every primitive and composite component from the mockups, against the production tokens. Used as a living style guide and as the canvas for future polish.

- [ ] Port `docs/mockups/_design.css` tokens to `tailwind.config.ts` (colors, fonts, sizes, spacing)
- [ ] Or alternative: tokens as CSS variables in `apps/desktop/src/styles/tokens.css` — Tailwind classes reference them. Decide based on which is more ergonomic.
- [ ] Geist (UI) + JetBrains Mono (code) loaded via `@fontsource/*`
- [ ] Primitives: `Button`, `IconButton`, `Pill`, `Tag` (variants: read, write, verified, community), `StatusDot`, `Toggle`, `Tabs`, `Modal`
- [ ] Layout shell: `TitleBar` (Mac traffic-light controls), `Sidebar` (collapsible sections), `StatusStrip` (4 cells), `MainContent` frame
- [ ] Composite: `AgentCard`, `RunTimeline`, `TelemetryStrip`, `ActivityFeed` (plain/raw modes), `ReasoningBlock` (purple-accented streaming UI)
- [ ] `/design-system` internal route renders all of the above with real props

**Acceptance:**
- All components match their mockup counterparts pixel-close at 1280×800
- Dark theme tokens consistent across components
- `/design-system` route is the contributor reference; new components must be added here when introduced

---

### Phase 3 — Screen implementation (mocked data)

**Deliverable:** All 10 screens reachable via sidebar/keyboard, visually matching the mockups, with mocked data. This is what generates the screenshots.

For each screen: design (if missing) → React route → mocked data → trust messaging hook-up → review against mockup → done.

- [ ] **01 Onboarding** — 3-step flow with state machine (tenant → LLM → first agent). Tenant step uses mock data, LLM step actually pings Ollama (real), agent install step is scripted.
- [ ] **02 MSAL consent** — built as a static screen for screenshot purposes. No real OAuth flow in v0.1.
- [ ] **03 Agents grid** — static list of 6 sample agents, sortable, search-filterable.
- [ ] **04 Live run modal** — built with mocked streaming initially; real Ollama streaming wired in Phase 4.
- [ ] **05 Diff confirm** — UI built, with mocked before/after diff data. Typed-confirmation interaction works locally; no real Graph write happens.
- [ ] **06 Error states** — implemented as a reference page reachable from the design-system route, plus inline rendering at relevant trigger points.
- [ ] **07 LLM provider** — *real* against Ollama (test connection, list models). Hosted providers shown as configurable but not actually wired.
- [ ] **08 Tenant switcher** — mocked 3 tenants with color coding and search.
- [ ] **09 Registry browse** — *new design needed*. Save as `docs/mockups/09-registry.html` first, then implement. Static JSON of ~12 sample agents with filter/search/install button (install is mocked).
- [ ] **10 Empty states** — *new design needed*. Save as `docs/mockups/10-empty-states.html` first, then implement. Three empty states: zero agents installed, zero runs, zero tenants.
- [ ] Trust messaging: implement as a single derived state that flips every "Local-only · No data leaves this device" instance simultaneously when the LLM provider changes. Same for the cost cell.

**Acceptance:**
- Every screen reachable from the sidebar; keyboard nav works (Tab order sensible)
- Visual fidelity ≥95% against mockups (informal — we're not measuring pixels, but a side-by-side review should show no obvious mismatches)
- Trust messaging: switch LLM provider in §07 → every other screen's "data residency" cell updates in real time
- Screens 09 and 10 designed as HTML mockups *first* (so they live alongside the others), then implemented in React

---

### Phase 4 — Real LLM provider abstraction + Ollama

**Deliverable:** The `LLMProvider` interface in `packages/llm/`, with `OllamaProvider` as a working concrete implementation. The interface is provider-agnostic and proven by a smoke test that a stub `MockProvider` can satisfy the same surface.

- [ ] `LLMProvider` interface per SPEC.md §2: `id`, `isLocal`, `listModels()`, `testConnection()`, `complete()`
- [ ] `OllamaProvider` implementation against `http://127.0.0.1:11434`
- [ ] Streaming completion via `complete()` returning `AsyncIterable<CompletionChunk>`
- [ ] `MockProvider` for tests + screenshots without Ollama
- [ ] Smoke test (Vitest): same test runs against both providers, asserts identical interface contract
- [ ] `testConnection()` returns structured error states (Ollama not running, no models installed, version mismatch)
- [ ] Wire the live run modal to consume the real provider via `complete()` streaming

**Acceptance:**
- With Ollama running locally and at least one model pulled: clicking "Run" on the sample agent streams real LLM output into the live run modal
- With Ollama not running: a designed error state appears with the correct recovery instruction (`ollama serve`, exact copy from `06-error-states.html`)
- Provider-agnostic smoke test passes for both `OllamaProvider` and `MockProvider`
- All trust messaging stays consistent throughout (purple reasoning blocks for streaming, "$0.00 local" cost cell)

---

### Phase 5 — Synthetic Graph data + sample agent

**Deliverable:** A `MockGraphClient` in `packages/graph/` that returns realistic synthetic tenant data, plus the first agent in `agents/sample-list-inactive-devices/` that runs end-to-end using it.

- [ ] `GraphClient` interface (the same one the real MSAL-backed client will eventually implement)
- [ ] `MockGraphClient` implementation with synthetic data: ~50 devices (Win/Mac mix, varying compliance, varying last-check-in dates), ~20 users, ~5 conditional access policies. Data committed as a JSON fixture so screenshots are deterministic.
- [ ] `agents/sample-list-inactive-devices/` directory:
  - [ ] `manifest.ts` — declared scopes, mode `'read'`, `preferredModel`
  - [ ] `agent.ts` — `run()` function that calls `ctx.graph.devices.list()`, filters by `lastSyncDateTime > 90 days`, formats into a structured prompt for `ctx.llm.complete()`, returns a structured result list
  - [ ] `README.md` — sample agent doc as a contributor reference
- [ ] `packages/agent-sdk/` exposes `AgentContext` and the surface agents author against
- [ ] Wire the runtime so clicking "Run" on the sample agent in the agents grid actually executes it

**Acceptance:**
- Sample agent runs end-to-end with Ollama: Graph fixtures load → LLM generates summary → results render in the activity feed
- The agent code doesn't know it's not a real tenant — same interface either way
- Synthetic data realistic enough that screenshots are credible (not "Test User 1" placeholders — actual-looking device names like `LAP-DE-MUC-0142`, real-looking timestamps)

---

### Phase 6 — Marketing site + private-preview signup

**Deliverable:** openagents.sh deployed and live, with a hero section, "what / why / how" sections, demo screenshot or short loop video, and an email capture form that writes to a real backend.

- [ ] `apps/marketing/` Next.js 14 App Router + Tailwind
- [ ] Hero section: tagline, primary CTA (signup), screenshot of the desktop app
- [ ] Sections: What it is, How it works, Why local-first, Get early access
- [ ] Honest copy throughout — no AI-hype language, no exclamation marks (per project tone in CLAUDE.md)
- [ ] Email signup form → Vercel Edge function → Resend (confirmation email) + Postgres (Neon) for storage
- [ ] Privacy note on the form: what we do with the email, when we contact, opt-out
- [ ] Mobile responsive at 360px+
- [ ] Open Graph + Twitter card metadata for sharing
- [ ] Deploy to Vercel; point `openagents.sh` DNS at it
- [ ] Set up `openagents.ugurlabs.com` 301 redirect to `openagents.sh`

**Acceptance:**
- `https://openagents.sh` resolves with a TLS cert
- Submitting a real email captures it (verified by checking Postgres + receiving the Resend confirmation)
- Lighthouse: Performance ≥90, Accessibility ≥95, SEO ≥95 on the landing page
- No telemetry beyond the signup itself; no third-party trackers

---

### Phase 7 — Polish, screenshots, demo video, tag v0.1.0

**Deliverable:** Hero screenshot in README, full screenshot gallery on the marketing site, 60–90s demo video on Loom (or YouTube unlisted), and a tagged `v0.1.0` GitHub release.

- [ ] Capture screenshots at 2x retina for: 01, 03, 04, 05, 07, 08, 09, 10
- [ ] Update README.md with hero screenshot + a "What it looks like" section linking to the gallery
- [ ] Marketing site gallery uses the same screenshot set
- [ ] Record demo video showing: app opens → onboarding → LLM provider → first run with streaming → result table. ≤90 seconds.
- [ ] Embed video on the marketing site
- [ ] Tag `v0.1.0` GitHub release with changelog entry
- [ ] Announcement post draft (LinkedIn + Twitter) — review with Uli before posting

**Acceptance:**
- README hero image is high-quality, unambiguous about what the product is
- Demo video shows the full happy path with no editing of state (it's the actual app, not a Figma render)
- v0.1.0 tag points to a working build that someone could clone and run
- Marketing site has the screenshot gallery and the embedded video

---

## How we evaluate v0.1 readiness

Per CLAUDE.md, "Never mark a task complete without proving it works." Before declaring v0.1 done:

1. Fresh clone test on a clean machine: `git clone && pnpm install && pnpm dev` works first try.
2. Walk through the SPEC.md §5a acceptance criteria one by one against the running app. Each must pass.
3. Run a separate `feature-dev:code-reviewer` subagent over the v0.1 codebase before tagging. Address findings or document why we deferred them.
4. Get at least one external person (not Uli, not Claude) to take screenshots from the app and confirm the experience matches the README hero.

---

## Lessons applied

`tasks/lessons.md` is consulted at the start of each session. Notable lessons that have shaped this plan:

- _(none yet — will accumulate as v0.1 work proceeds)_
