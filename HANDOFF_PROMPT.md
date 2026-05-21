# First Message to Claude Code

Copy and paste the message below as your first message to Claude Code in this repository. It tells Claude Code where to start, what to read first, and how to ask before guessing.

---

## Paste this:

I'm handing you a fresh repo for a project called **OpenAdminOS**. Before you write any code or make any structural decisions, do this:

1. Read `CLAUDE.md` in the root. It tells you how to work in this codebase.
2. Read `docs/SPEC.md` end-to-end. This is the source of truth for the product.
3. Open every file in `docs/mockups/` (start with `index.html`) so you understand the design language before building anything.
4. Read the t3code reference architecture at https://github.com/pingdotgg/t3code — our monorepo shape should follow that pattern.

Once you've done that, propose a phased plan for the initial scaffolding (monorepo setup, shared tooling, the empty shells of `apps/desktop`, `apps/web`, `apps/cli`, and the core `packages/`). Don't start scaffolding until I've reviewed the plan. Phase the work so each phase ends in something I can run and see.

After the scaffold is approved, the first real feature to build is the **LLM provider abstraction in `packages/llm/`** with a working **Ollama** implementation, plus a smoke test that proves the abstraction is provider-agnostic. We'll add MSAL and the first agent after that.

A few things I want to make sure you internalize from the spec before starting:

- **Local-first is not a marketing line, it's an architectural constraint.** No telemetry, no analytics, no error reporting that could include tenant data. Don't add any "helpful" instrumentation.
- **Write agents always pause for diff confirmation.** Every time. Don't add a "remember my choice" toggle. Don't add a "trust this agent" exception. The first time someone asks for one in an issue, point them at this spec.
- **The CLI and the desktop app share the same UI.** Don't fork the React tree.
- **Open source from commit zero.** Public repo, MIT license, contributing guide already in place. Don't suggest delaying the public push.

When in doubt about anything not covered in the spec, leave a `// TODO(uli):` comment with your question rather than picking a default. I'd rather answer a question than have to undo an unilateral choice.

Ready when you are.

---

## After Claude Code responds with its plan

Review it for:

- Does it match the t3code architecture pattern, or did Claude Code propose something else? If it deviated, ask why.
- Does Phase 1 produce something runnable? It should — even if it's just `pnpm dev` opening an empty Next.js page in a Tauri window.
- Is the LLM abstraction the actual first feature? It should be — it validates the most important design decision in the codebase.
- Did Claude Code surface any open questions? It should have at least 2-3.

If it looks good, give it the go-ahead. If anything's off, push back specifically — Claude Code is good at adjusting when you point at concrete things, less good at re-deriving from vague feedback.
