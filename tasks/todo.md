# Tier 1 manifest interpreter

**Goal:** Let agents be declared as YAML pipelines (no code) so non-technical contributors can author and read them. Implement the schema, interpreter, format handlers, and migrate `find-inactive-devices` as the first canonical Tier 1 example. The existing TS-based ("Tier 2") path stays fully functional as a fallback for agents that need code.

**Status:** In progress.

---

## Scope for this pass

- [ ] **Schema** in `@openagents/agent-sdk`: TS types for `Tier1Manifest`, `Tier1Skill`, `Tier1Trigger`, `Tier1ResultShape`. Pure types only; the runtime owns parsing/validation.
- [ ] **Parser + validator** in `@openagents/runtime`: `parseTier1Manifest(yamlOrJsonText)` using `js-yaml`. Returns the typed manifest or a structured `ManifestValidationError` with line context where possible.
- [ ] **Templating** in `@openagents/runtime`: a minimal Liquid-subset (`{{ path }}`, `{{ path | filter }}`) with built-in filters `size`, `total`, `sample(n)`, `default("…")`, `join(", ")`. No big template-engine dep. Preserves primitive types when the entire string is a single `{{ … }}` expression (so `"{{ settings.warnDays }}"` evaluates to `30`, not `"30"`).
- [ ] **Format handlers** in `@openagents/runtime`:
  - `graph` — calls `ctx.graph` methods declared by the skill.
  - `transform` — pure data shaping. Initial transform kind: `group-by-age`. Others (`filter`, `project`, `sort`) added on demand.
  - `llm` — renders `system` + `prompt` via the templater, calls `ctx.llm.complete`, gates on `ctx.llm.available` when `when: ctx.llm.available` is set.
- [ ] **Interpreter** in `@openagents/runtime`: `runTier1Manifest(manifest, ctx, settings)` walks `skills[]` top-to-bottom, executes each skill with its format handler, stores outputs by skill `id` in a pipeline state object, evaluates the final `result` block, and returns `AgentRunResult`.
- [ ] **Loader update** in `@openagents/runtime`: `loadAgentModule` now prefers `agents/<slug>/manifest.yaml` if it exists with a `skills:` block; otherwise falls back to `dist/agent.js` (Tier 2). When Tier 1 is loaded, the runtime synthesizes an `AgentModule` whose `run()` invokes the interpreter.
- [ ] **`find-inactive-devices` migration**: add `manifest.yaml` declaring the same pipeline the current `src/agent.ts` implements. The TS source stays for the v0.1 transition (it's just unused by the loader now). Run record output matches today's: same totals, same retire bucket device IDs.
- [ ] **QA gate**: when a Tier 1 manifest is present, validate `skills[*].format` against the supported set, `graph` skills' declared scopes against the local msgraph index (reusing the existing scope check), and `transform.kind` against the registered transforms. Tier 2 path is unchanged.
- [ ] Typecheck, qa, and build all green; CI passes.

## Out of scope for this pass

- **`write` format** — `retire-inactive-devices` stays Tier 2 until the write format is designed (must integrate with the existing typed-phrase confirmation + real-writes toggle).
- **Scheduled triggers** — manifest schema includes `triggers[]` but the interpreter only supports `kind: manual` for now.
- **NL2Agent builder UI** — separate slice; depends on this foundation.
- **Manifest preview UI in the Agent Hub** — separate slice; this PR lets you read the YAML in the source tree.
- **Removing Tier 2 source for migrated agents** — separate cleanup slice once Tier 1 is proven against real and synthetic Graph for a release cycle.
- **Install-time settings UI** — manifest declares them; runtime uses `default` values from the manifest. Per-install user overrides land later.
- **JSON Schema export for IDE autocomplete** — nice to have, separate slice.

## Acceptance criteria

- [ ] `npm install`, `npm run typecheck`, `npm run qa`, `npm run build` all green.
- [ ] `find-inactive-devices` invoked via the Tier 1 pipeline against the synthetic Graph fixture produces a `RunRecord` with:
  - `result.data.totalDevices === 22`
  - 4 devices in each of the warn / stale / retire buckets
  - `result.data.buckets.retire` includes IDs `d-019..d-022`
  - The LLM polish step runs when `ctx.llm.available === true`, skipped otherwise
- [ ] Renaming `agents/find-inactive-devices/manifest.yaml` to disable Tier 1 falls back cleanly to the Tier 2 `dist/agent.js` and produces the same result.
- [ ] Removing the `dist/` directory while leaving `manifest.yaml` still works — proves the Tier 1 path doesn't depend on Tier 2 build output.
- [ ] No secrets, no `.env`, no emojis.

## Review

(to fill in after implementation)
