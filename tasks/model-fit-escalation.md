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

- [ ] Mockup `docs/mockups/36-model-fit.html` and index entry: the Chat notice
      with plain numbers, the choices (hosted with location label and cost note,
      larger local model, split, keep local), the accept step, the after state,
      the decline state, the policy state, and the agent run failure with
      Run with provider and its accept step.
- [ ] Shared pure module `apps/desktop/src/shared/model-fit.ts`: classify a
      failure, list choices from the provider list (configured and ready only,
      hosted never first or preselected), parse model size.
- [ ] Copy `apps/desktop/src/copy/model-fit.ts` using `providerDataLocation`.
- [ ] Contracts in `packages/agent-sdk`: `ModelFitIssue`, `ChatModelOverride`
      on `SendIntuneChatMessageInput`, `modelFit` and `switchedFrom` on
      `IntuneChatMessage` (stored in answer meta).
- [ ] Main: `electron/intune-chat/model-fit.ts` resolves and validates a
      per-request override (listed, ready, local active provider, hosted needs a
      fresh non-remembered consent for that provider and model); minimal hook in
      `service.ts`; IPC validation in `main.ts`.
- [ ] Renderer Chat: notice, accept step (the existing hosted consent panel in
      a per-request mode, no remember box, no Enter shortcut), after-state line
      on the answer, decline line.
- [ ] Agent runs: the run failure view offers Run with provider for a
      context-too-small failure on a local model; the run preflight is the
      accept step and says why and that it is this run only; Start run reruns
      with the chosen provider. Write agents still stop at the diff.
- [ ] Tests (below), SPEC.md section, CHANGELOG line.

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

(filled in at the end)
