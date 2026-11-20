# Workstream A: Conditional Access explainer fits local models

Branch: `agents/ca-explainer-fit`. Demos on 2026-11-24 use OpenAdmin 8B on Ollama (num_ctx 16384 pinned).

## Problem

A 33 policy tenant renders a review prompt of about 40,000 tokens. Ollama returns HTTP 400 and the admin sees a raw error. The app never estimates prompt size.

## Plan

- [x] Runtime: `compact-conditional-access` transform that turns each Graph policy into a short record (name, state, modified age, user/app scope summaries, client app types, platforms, locations, risk levels, grant operator and controls, authentication strength, session control keys). Well known privileged role template ids become names (verified against `GET /directoryRoleTemplates`).
- [x] Runtime: `group-by-age` gains an optional `pick` field so buckets can hold names instead of whole objects.
- [x] Manifest: the CA explainer prompt uses the compact records, age buckets hold names only, and the report asks for plain explanations and concrete improvements.
- [x] SDK: optional `RunLlmApi.contextWindow(model)`, a typed `ContextTooSmallError` (code `context-too-small`, needed and limit numbers), and `RunRecord.failureReason`.
- [x] Runtime: `estimateTokens` and `checkPromptFit` exported; agent LLM calls check the fit before sending when a context window is known.
- [x] Ollama: context window from `/api/show` in a separate helper module. A pinned `num_ctx` is the limit (what the first request gets); an unpinned model is limited by its maximum, and its first send carries an explicit `num_ctx` covering the request (never below the loaded size), so it is never served at a smaller default. #211's retry still handles an estimate that came out low.
- [x] LM Studio: left undefined (API shape could not be verified).
- [x] Wrappers forward `contextWindow` (tenant data filter, run thinking wrapper, self training overlay).
- [x] Desktop: RunFailureRemediation playbook for `context-too-small`, read from the typed reason.
- [x] Other agents: prompts stop interpolating `group-by-field` buckets of whole records; high cardinality count maps are capped; long remediation samples are bounded.
- [x] Docs: SPEC.md decision, CHANGELOG line, JSON Schema for new transform settings.

## Acceptance criteria

1. A fixture of 33 realistic CA policies renders a review prompt that fits in 16,384 tokens with a 1,100 token answer budget, measured by the estimator, with a test.
2. A fixture of 100 policies either fits or fails in preflight with the typed `context-too-small` reason and the designed message, never a raw HTTP 400. Tested.
3. No policy object appears twice in the prompt. Tested.
4. Hosted providers are unaffected: no known context window means no preflight block. Tested.
5. Runtime, agent-sdk and desktop test suites pass under Node 22; typecheck passes.

## Review

- Numbers (estimator, synthetic fixture): 33 policies need 6,535 tokens with the 1,100 token answer, 100 need 14,125, the largest count that fits 16,384 is 119. Real prompt counts measured once before the no-local-model rule: 4,143 (33) and 9,944 (100) on OpenAdmin 8B.
- Ollama limit is the pinned `num_ctx` (16,384 for OpenAdmin 8B), else the model maximum, and an unpinned model gets a num_ctx covering the request on its first send. An integration test through the real adapter with mocked HTTP shows 250 policies never reach /api/chat (in the stacked PR, with the manifest).
- Release in two steps (Sol round 4): PR #214 ships the runtime, preflight, desktop gate and the other agents (bounded with `count-by-field` steps and the `top` setting, all on their old minimums). The CA explainer 1.2.0 manifest, its fit tests and fixture are in a stacked PR whose `minAppVersion` must be set to the first nightly published after #214 merges. A build from source reports 0.7.2 until the version bump.
- Reviews: Claude round 1 (2 findings, fixed), Sol round 1 (2 blocking, 5 should fix, 1 nit, fixed), Muse round 1 (fixed), Sol round 2 (2 blocking, 4 should fix, 1 nit, fixed), Sol round 3 (1 blocking, 4 should fix, fixed), Muse round 2 (no blocking, fixed), Sol round 4 (2 blocking, 1 should fix, 1 nit, fixed: up-front num_ctx for unpinned Ollama models, two-step release, terminal-error check). Further rounds are recorded on the PR.
- Not verified: LM Studio context fields (left undefined), a live run with a hosted provider.
