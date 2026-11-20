# Model fit escalation (workstream E)

Detect when the local model is a poor fit for a request and ask the admin before
running that one request with a configured hosted provider or a larger local
model. Decided by the maintainer on 2026-11-19: hosted is allowed only after a
notice inside Chat that says what happens and where data goes, and an explicit
accept. Never silent, never preselected. Approval is per request.

Branch `chat/model-fit-escalation` from origin/main. Mockup number 36, because
PR #207 already adds `35-personal-agent.html`.

## Signals (what counts as a poor fit)

- Context too small. Today: the provider error text. PR #211 (Ollama
  `Ollama context size too small: This request needs N tokens of context, but M
  supports at most L.`), Ollama's raw 400 (`request (N tokens) exceeds the
  available context size (L tokens)`), llama.cpp `exceed_context_size_error`,
  Apple Foundation's "context window is too small". Later: workstream A's typed
  `context-too-small` failure, read by duck typing (`kind` or `code`, with
  needed and limit numbers). No second estimator.
- Repeated investigation failure on a local model (the existing in-memory
  `agenticModelHasFailedRepeatedly` counter). Workstream B+C adds reasons later.
- Thinking-only answer: only through a typed reason (`kind: "thinking-only"`),
  no text guessing; the gpt-oss branch decides the shape.

Only a local provider gets the offer.

## Deliverables

- [x] Mockup `docs/mockups/36-model-fit.html` and index entry: the Chat notice
      with plain numbers, the choices (hosted with location label and cost note,
      larger local model, split, keep local), the accept step, the after state,
      the decline state, the policy state, and the agent run failure with
      Run with provider and its accept step.
- [x] Shared pure module `apps/desktop/src/shared/model-fit.ts`: classify a
      failure, list choices from the provider list (configured and ready only,
      hosted never first or preselected), parse model size.
- [x] Copy `apps/desktop/src/copy/model-fit.ts` using `providerDataLocation`.
- [x] Contracts in `packages/agent-sdk`: `ModelFitIssue`, `ChatModelOverride`
      on `SendIntuneChatMessageInput`, `modelFit` and `switchedFrom` on
      `IntuneChatMessage` (stored in answer meta).
- [x] Main: `electron/intune-chat/model-fit.ts` resolves and validates a
      per-request override (listed, ready, local active provider, hosted needs a
      fresh non-remembered consent for that provider and model); minimal hook in
      `service.ts`; IPC validation in `main.ts`.
- [x] Renderer Chat: notice, accept step (the existing hosted consent panel in
      a per-request mode, no remember box, no Enter shortcut), after-state line
      on the answer, decline line.
- [x] Agent runs: the run failure view offers Run with provider for a
      context-too-small failure on a local model; the run preflight is the
      accept step and says why and that it is this run only; Start run reruns
      with the chosen provider. Write agents still stop at the diff.
- [x] Tests (below), SPEC.md section, CHANGELOG line.

## Acceptance criteria

1. With a local model and a request that does not fit (mocked context window
   error), Chat shows the notice with the numbers, sends nothing to a hosted
   provider until the admin accepts, and after accepting answers with the
   chosen provider and shows its location label on the answer.
2. Declining leaves the conversation on the local model with a plain next step.
3. An agent run that fails with context too small on a local model offers Run
   with provider; the accept step names the provider and where data goes; Start
   reruns that agent with the chosen provider.
4. Tests: no switch without accept (host refuses an override with no consent or
   a remembered one); hosted never preselected; notice text includes the
   location label; a policy that removes hosted providers hides the option;
   agent rerun uses the chosen provider.
5. Desktop electron and renderer tests pass under Node 22; typecheck passes.
6. Live check with Claude Code or Codex if feasible, provider and model named.

## Open questions (TODO(ugur) in code)

- Remember for this conversation: not offered in v1.
- Larger local model: chosen by the parameter size in the model name; its
  context window is not read, so it is not checked against the request size.
- Cost note: generic, the app does not know the admin's plan or price.
- Masking: no data policy or masking code is on main yet (PR #209 is open).
  When it lands, the per-request hosted send goes through the same `buildLlm`
  choke point as any hosted send.

## Review

PR #213, based on main (merged up to date four times; workstreams A and B+C
are on origin but not merged, so this PR reads their typed failures by shape
instead of stacking on them).

Reviews: eighteen rounds of Codex gpt-6.2-sol (high), Muse Wonder Full 1.0
(high; round 1 failed on a transport error, round 12 returned no report) and a
Claude feature-dev evaluator. Muse and the Claude evaluator found nothing
blocking from round 2 on. Sol's blocking findings, each fixed with tests:
- round 1: Ollama Cloud models treated as local; approval not bound to the request.
- round 2: acceptance reusable for another request; two sends from one
  acceptance; remote-backed Ollama aliases; rerun in an unreviewed organization.
- round 3: accept step could send text the admin removed; cached alias
  locality; ordinary sends reusing a fit acceptance.
- round 4: on-device requirement dropped after admission; Azure endpoint
  change between phases; merge conflict with main.
- round 5: alias change between calls; destination change during review; Run
  for real dropping the safeguards.
- round 6: check and binding from two reads; Lemonade endpoint not bound;
  remote-backed active model raising the on-device notice.
- round 7: Run again dropping the safeguards; redirects from self-hosted
  servers outside this device; stale locality at classification.
- round 8: Stop ignored during the failure-time locality check.
- round 9: Ollama's own context retry inside one adapter call is not
  re-checked. Not fixable here (packages/runtime/src/llm-ollama.ts is out of
  scope for this workstream and has no hook); recorded as a follow-up.
- rounds 10 to 13: smaller binding and wording gaps, no blocking finding
  from round 13.
- round 14: a provider picked in the setup detour became the active
  provider; Start let the host resolve a model the review did not show.
- round 15: Azure deployment change before review; resume opening an
  ordinary provider picker; hosted reruns without a pinned model; setup
  stalling on a cached Copilot result.
- round 16: the host picking an unapproved hosted model; Gemini's
  `gemini-default` placeholder; Run for real moving to another endpoint
  after setup.
- round 17: no blocking finding. Should-fixes from Sol and Muse (one listed
  hosted model check everywhere, per-call model check, multi-tenant
  withdrawal, accept step closing when its provider drops out) are fixed.
- round 18: no blocking finding. Should-fixes fixed: a policy-supplied
  model is not counted as reported (`modelsFromPolicy`); a hosted choice
  falls back to a listed model when the default is not listed, the same in
  the run review; a refused fit start reads its destination again.

Live check: real Chat service with the local model mocked and the real
Claude Code CLI (2.1.328, alias `sonnet`, answered as claude-sonnet-5-5).
No local model was loaded (maintainer instruction, see tasks/lessons.md).

Acceptance criteria 1 to 4 are covered by electron/intune-chat/model-fit.test.ts,
electron/model-fit-binding.test.ts, electron/run-lifecycle.test.ts,
src/pages/IntuneChatModelFit.test.tsx, src/pages/RunResult.test.tsx and
src/setup/pending-intent.test.ts. Criterion 5: the full electron suite passes
under Node 22 (1602 of 1602 at the last full run; renderer 902 of 902); typecheck is clean.

Open TODO(ugur): remember for this conversation; read local context lengths
for local choices; cost estimate on hosted rows; label Ollama Cloud and
remote-backed models everywhere; the thinking-only shape from the reasoning
report branch; a hook before the Ollama adapter's internal context retry.
