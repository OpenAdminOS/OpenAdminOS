# Workstream A: Conditional Access explainer fits local models

Branch: `agents/ca-explainer-fit`. Demos on 2026-11-24 use OpenAdmin 8B on Ollama (num_ctx 16384 pinned).

## Problem

A 33 policy tenant renders a review prompt of about 40,000 tokens. Ollama returns HTTP 400 and the admin sees a raw error. The app never estimates prompt size.

## Plan

- [ ] Runtime: `compact-conditional-access` transform that turns each Graph policy into a short record (name, state, modified age, user/app scope summaries, client app types, platforms, locations, risk levels, grant operator and controls, authentication strength, session control keys). Well known privileged role template ids become names (verified against `GET /directoryRoleTemplates`).
- [ ] Runtime: `group-by-age` gains an optional `pick` field so buckets can hold names instead of whole objects.
- [ ] Manifest: the CA explainer prompt uses the compact records, age buckets hold names only, and the report asks for plain explanations and concrete improvements.
- [ ] SDK: optional `RunLlmApi.contextWindow(model)`, a typed `ContextTooSmallError` (code `context-too-small`, needed and limit numbers), and `RunRecord.failureReason`.
- [ ] Runtime: `estimatePromptTokens` and `checkPromptFit` exported; agent LLM calls check the fit before sending when a context window is known.
- [ ] Ollama: context window from `/api/show` in a separate helper module (pinned `num_ctx` wins, else the loaded size from `/api/ps`, else the model maximum). One line hook in `llm-ollama.ts`.
- [ ] LM Studio: left undefined (API shape could not be verified).
- [ ] Wrappers forward `contextWindow` (tenant data filter, run thinking wrapper, self training overlay).
- [ ] Desktop: RunFailureRemediation playbook for `context-too-small`, read from the typed reason.
- [ ] Other agents: prompts stop interpolating `group-by-field` buckets of whole records; high cardinality count maps are capped; long remediation samples are bounded.
- [ ] Docs: SPEC.md decision, CHANGELOG line, JSON Schema for new transform settings.

## Acceptance criteria

1. A fixture of 33 realistic CA policies renders a review prompt that fits in 16,384 tokens with a 1,100 token answer budget, measured by the estimator, with a test.
2. A fixture of 100 policies either fits or fails in preflight with the typed `context-too-small` reason and the designed message, never a raw HTTP 400. Tested.
3. No policy object appears twice in the prompt. Tested.
4. Hosted providers are unaffected: no known context window means no preflight block. Tested.
5. Runtime, agent-sdk and desktop test suites pass under Node 22; typecheck passes.

## Review

(filled in at hand-back)
