# 0.6.3 live desktop demo readiness

Scope: resolve the known Chat, Nova and Agent Team failures from the September 15
reviews, then verify a signed installed build with the configured tenant/providers.
This is a readiness plan, not a claim that every product workflow is verified.

## 1. Reliable evidence across Chat and Nova

- [x] Fix the observed managed-device encryption filters and incident page size in source.
- [x] Reject invalid cache filters and block unsupported zero-count answers.
- [x] Exercise additional topics: users, groups, applications, Conditional Access and licenses.
- [ ] For each topic, check counts and lists against actual source rows; retain freshness,
  coverage and unknown-value distinctions. Include wording variations and follow-ups.
- [ ] Verify permission failures, missing/partial/stale cache, cancellation, timeout and retry.

Evidence: [Chat regression review](chat-063-regression-review.md).

## 2. Complete Agent Team assessments

- [x] Preserve the complete compliance-state map in the assessment result and summary
  prompt, including grace period, error, conflict, not evaluated and unexpected states.
- [x] Require state counts to reconcile with the inventory total; keep unknown values explicit.
- [x] Preserve source run references and coverage when handing the assessment to Research.
- [x] Rehearse report quality with the assigned provider, including repetitive-output handling.

## 3. Dependable draft generation and recovery

- [x] Preserve the original task and evidence when retrying a Team run.
- [ ] Diagnose the observed delay between step timeout and final failed-run state.
- [ ] Bound draft scope and output; make timeout/cancellation recoverable without losing evidence.
- [x] Check generated PowerShell syntax, command parameters, Graph paths, permissions,
  authentication guidance and pagination. Validate against command metadata where available.
- [x] Keep unverified drafts visibly unverified. A completed model response alone is not a
  validated script. Do not execute generated scripts or tenant changes during rehearsal.

Evidence: [installed Agent Team review](agent-team-063-live-review.md).

## 4. Deliver the verified source to the desktop

- [x] Update PR #88 with focused fixes and regression evidence; verify checks on its current head.
- [x] Produce a signed preview build identifying the source commit.
- [x] Preserve existing local data and install that build; verify the running binary/version.
- [x] Refresh the affected cache collections and inspect per-resource coverage/errors.

## 5. Live acceptance rehearsal

Use the configured tenant and providers. Record exact prompts, actual source counts,
run references, elapsed times, failures and recovery outcomes in private evidence.
Keep only sanitized coverage summaries in this repository.

Proposed acceptance gate:

- At least 20 ordinary Chat/Nova questions across the six subject areas above, including
  ambiguous and failure cases. Correct source-based answers or explicit inability to verify.
- Three consecutive complete assessment → Research handoff → draft runs. Each preserves
  source evidence, reaches the correct terminal state and produces a reviewed usable draft.
- One deliberately cancelled run and one retry retain the expected task/evidence boundaries.
- All of the selected presentation sequence passes in the installed desktop application.

Automation supports this gate but cannot substitute for it. Any remaining failed path is
named explicitly in the demo scope. Provider changes, tenant changes, release publication
and expansion beyond the known blockers are separate decisions.

## Current review status

Source fixes are implemented and tested. The current local providers still produce
occasional incorrect numeric summaries and drafts with semantic errors despite
successful execution and source-linked handoffs. The signed preview is installed and one complete Codex Team chain passed. The full
installed-build acceptance gate remains open, including three consecutive chains,
spoken audio and the remaining investigative-answer and UI coverage gaps. See [follow-up review](demo-readiness-063-review.md).

Installing or updating agents requires no catalog or manifest signatures. HTTPS
source review, manifest hashes and permission review remain. Desktop installer
signing is separate.
