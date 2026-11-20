# Workstream A: Conditional Access explainer fits local models

Branch: `agents/ca-explainer-fit`. Demos on 2026-11-24 use OpenAdmin 8B on Ollama (num_ctx 16384 pinned).

## Problem

A 33 policy tenant renders a review prompt of about 40,000 tokens. Ollama returns HTTP 400 and the admin sees a raw error. The app never estimates prompt size.

## Plan

- [x] Runtime: `compact-conditional-access` transform that turns each Graph policy into a short record (name, state, modified age, user/app scope summaries, client app types, platforms, locations, risk levels, grant operator and controls, authentication strength, session control keys). Well known privileged role template ids become names (verified against `GET /directoryRoleTemplates`).
- [x] Runtime: `group-by-age` gains an optional `pick` field so buckets can hold names instead of whole objects.
- [x] Manifest: the CA explainer prompt uses the compact records, age buckets hold names only, and the report asks for plain explanations and concrete improvements.
- [x] SDK: optional `RunLlmApi.contextWindow(model)`, a typed `ContextTooSmallError` (code `context-too-small`, needed and limit numbers), and `RunRecord.failureReason`.
- [x] Runtime: `estimatePromptTokens` and `checkPromptFit` exported; agent LLM calls check the fit before sending when a context window is known.
- [x] Ollama: context window from `/api/show` in a separate helper module. Since #211 raises `num_ctx` on an overflow, the adapter reports the model maximum; for a caller that does not raise it, the helper returns the pinned `num_ctx`, else the loaded size from `/api/ps`, else the maximum. One line hook in `llm-ollama.ts`.
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
- Ollama limit is the model maximum (product decision from #211), so on OpenAdmin 8B the preflight blocks only above 262,144; the explainer fits the pinned 16,384 on its own up to about 119 policies.
- `minAppVersion` follows the release with each manifest's features (0.7.3 for the CA explainer and agents using `top(n)`); a build from source reports 0.7.2 until the version bump.
- Reviews: Claude round 1 (2 findings, fixed), Sol round 1 (2 blocking, 5 should fix, 1 nit, fixed), Muse round 1 on an older head (fixed or already fixed), Sol round 2 pending at the time of writing.
- Not verified: LM Studio context fields (left undefined), a live run with a hosted provider.
