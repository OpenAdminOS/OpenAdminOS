# Agent Template interpreter

**Goal:** Let agents be declared as YAML pipelines (no code) so non-technical contributors can author and read them. Implement the schema, interpreter, format handlers, and migrate `find-inactive-devices` as the first canonical Agent Template example. The existing TS-based path stays fully functional as a fallback for agents that need code.

**Status:** In progress.

---

## Scope for this pass

- [ ] **Schema** in `@openagents/agent-sdk`: TS types for `AgentTemplate`, `TemplateStep`, `TemplateTrigger`, `TemplateResult`. Pure types only; the runtime owns parsing/validation.
- [ ] **Parser + validator** in `@openagents/runtime`: `parseAgentTemplate(yamlOrJsonText)` using `js-yaml`. Returns the typed manifest or a structured `ManifestValidationError` with line context where possible.
- [ ] **Templating** in `@openagents/runtime`: a minimal Liquid-subset (`{{ path }}`, `{{ path | filter }}`) with built-in filters `size`, `total`, `sample(n)`, `default("…")`, `join(", ")`. No big template-engine dep. Preserves primitive types when the entire string is a single `{{ … }}` expression (so `"{{ settings.warnDays }}"` evaluates to `30`, not `"30"`).
- [ ] **Format handlers** in `@openagents/runtime`:
  - `graph` — calls `ctx.graph` methods declared by the step.
  - `transform` — pure data shaping. Initial transform kind: `group-by-age`. Others (`filter`, `project`, `sort`) added on demand.
  - `llm` — renders `system` + `prompt` via the templater, calls `ctx.llm.complete`, gates on `ctx.llm.available` when `when: ctx.llm.available` is set.
- [ ] **Interpreter** in `@openagents/runtime`: `runAgentTemplate(manifest, ctx)` walks `skills[]` top-to-bottom, executes each step with its format handler, stores outputs by step `id` in a pipeline state object, evaluates the final `result` block, and returns `AgentRunResult`.
- [ ] **Loader update** in `@openagents/runtime`: `loadAgentModule` now prefers `agents/<slug>/manifest.yaml` if it exists with a `skills:` block; otherwise falls back to `dist/agent.js`. When the YAML path is taken, the runtime synthesizes an `AgentModule` whose `run()` invokes the interpreter.
- [ ] **`find-inactive-devices` migration**: add `manifest.yaml` declaring the same pipeline the current `src/agent.ts` implements. The TS source stays for the transition (just unused by the loader now). Run record output matches today's: same totals, same retire bucket device IDs.
- [ ] **QA gate**: when an agent template manifest is present, validate `skills[*].format` against the supported set, `graph` step scopes against the local msgraph index, and `transform.kind` against the registered transforms. The code-based path is unchanged.
- [ ] Typecheck, qa, and build all green; CI passes.

## Out of scope for this pass

- **`write` format** — `retire-inactive-devices` stays code-based until the write format is designed (must integrate with the existing typed-phrase confirmation + real-writes toggle).
- **Scheduled triggers** — manifest schema includes `triggers[]` but the interpreter only supports `kind: manual` for now.
- **NL2Agent builder UI** — separate slice; depends on this foundation.
- **Manifest preview UI in the Agent Hub** — separate slice; this PR lets you read the YAML in the source tree.
- **Removing code-based source for migrated agents** — separate cleanup slice once the YAML path is proven against real and synthetic Graph for a release cycle.
- **Install-time settings UI** — manifest declares them; runtime uses `default` values from the manifest. Per-install user overrides land later.
- **JSON Schema export for IDE autocomplete** — nice to have, separate slice.

## Acceptance criteria

- [x] `npm install`, `npm run typecheck`, `npm run qa`, `npm run build` all green.
- [x] `find-inactive-devices` invoked via the Agent Template pipeline against the synthetic Graph fixture produces a `RunRecord` with:
  - `result.data.totalDevices === 22`
  - 4 devices in each of the warn / stale / retire buckets
  - `result.data.buckets.retire` includes IDs `d-019..d-022`
  - The LLM polish step runs when `ctx.llm.available === true`, skipped otherwise
- [x] The loader picks the YAML path when `manifest.yaml` is present; renaming it falls back cleanly to `dist/agent.js`.
- [x] No secrets, no `.env`, no emojis.

## Naming note

Originally drafted as "Tier 1 / Tier 2" — refactored to **Agent Template** (the YAML / declarative path) and **code-based agent** (the TypeScript escape hatch). The "tier" framing implied a hierarchy and more tiers; there are really only two authoring modes, and one of them is the documented default.

## Review

- `@openagents/agent-sdk` gained `AgentTemplate`, `TemplateStep` (`graph` | `transform` | `llm`), `TemplateTrigger`, `TemplateSetting`, `TemplateResult` types. Pure types — parsing and validation live in the runtime.
- `@openagents/runtime/src/template-engine.ts` ships the Liquid-subset templater (filters: `size`, `total`, `length`, `sample(n)`, `default`, `join`, `upper`, `lower`, `type`). Standalone-expression strings preserve primitive types so `"{{ settings.warnDays }}"` evaluates to integer `30`.
- `@openagents/runtime/src/agent-template.ts` ships `parseAgentTemplate(text)`, `runAgentTemplate(manifest, ctx)`, the format handlers (`graph`, `transform.group-by-age`, `llm`), and `agentTemplateToModule(manifest)` which adapts a parsed template into a `ReadAgentModule` for the existing run pipeline.
- `loadAgentModule` prefers `manifest.yaml`; code-based agents fall through unchanged.
- `agents/find-inactive-devices/manifest.yaml` is the first canonical Agent Template. Smoke-tested against the synthetic Graph fixture: 22 total devices, bucket sizes 4/4/4, retire band ids `d-019..d-022`, LLM step gated correctly, thresholds resolve from settings defaults.
