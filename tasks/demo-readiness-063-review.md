# PR 88 demo-readiness follow-up review

Date: 2026-09-15. Scope: Chat/cache evidence, Team assessments, handoffs, retries,
streaming persistence, generated drafts, and unsigned agent installation.

## Findings and fixes

- **Fixed: invalid queries became false zero answers.** Cache field/type/shape checks
  now reject unsupported criteria. Failed cache and Graph lookups prevent unsupported
  final answers. Common device questions use exact host-owned predicates and retain
  coverage/freshness caveats.
- **Fixed: compliance states were lost.** Structured assessment results retain all
  observed states, zero-filled standard states and explicit missing values. Their
  counts reconcile with the retrieved inventory.
- **Fixed: later handoffs lost original structured evidence.** Each bounded handoff
  resolves ancestor references from host history, validates tenant/completion state,
  and preserves original assessment records alongside model reports.
- **Fixed: local read-only retries discarded evidence.** The host reconstructs the
  original task, pins the tenant and validates source records. Hosted or write retries
  require Team review. Retries occupy the Team execution slot but do not impersonate
  the previous mission or replay its handoffs.
- **Fixed: streaming persistence could backlog terminal states.** Coalescing retains
  the latest cumulative snapshot. A blocked-write regression with 300 progress updates
  persists the final failed state in two writes. This supports the fix but does not
  prove the cause of the earlier installed-app 84-second delay.
- **Changed by explicit product decision: no agent signing requirement.** Official
  and custom HTTPS catalogs install/update unsigned manifests. Tests retain digest
  mismatch rejection, schema/metadata validation and official revision checks. Older
  signature-requiring clients need an app update. Desktop signing is unaffected.

## Remaining findings

1. **Presentation blocker: local model factual accuracy.** Apple Foundation sometimes
   invents or misstates assessment totals even when structured counts are correct.
   Original evidence now reaches Research, allowing correction, but the initial
   narrative is still not reliably accurate. Completed execution is not factual validation.
2. **Presentation blocker: generated PowerShell quality.** Repeated Qwen drafts exposed
   hard-coded snapshot findings, an automatic-variable assignment, missing pagination,
   omitted delegated-context checks, and incorrect string/date expressions. Guidance
   now includes a short reference pattern, but remaining semantic errors mean three
   consecutive usable drafts have not been established. Scripts were not executed.
3. **Answer coverage: investigative Chat.** The bounded app-registration total replay
   succeeds; an audience-filtered question still picked an unrelated endpoint. License
   replays explicitly report inability to verify from this saved-cache setup. Live
   collection/provider behavior must still be tested before presenting these topics.
4. **Installed acceptance pending.** Local source tests and real-provider saved-cache
   rehearsals do not establish that the installed binary contains these fixes or that
   its live tenant collection, microphone, cancel/retry and selected demo sequence pass.

## Verification

- Most recent full local run: 614 Node tests and 125 renderer tests passed, with one
  runtime test skipped. Typecheck, production build and Graph QA passed; QA retains
  four existing warnings for scope-free Team workflows.
- Subsequent focused checks cover ancestor evidence, cross-tenant rejection, Team
  retry/terminal persistence, manifests and unsigned official/custom install/update.
- Real-provider source chains use the configured Apple Foundation and Ollama Qwen
  models with a private copy of the actual device snapshot. They exercise the real
  Office scheduler, runtime, assessment and automatic handoffs. They do not perform
  fresh Graph reads or substitute for installed-app acceptance.
- PowerShell parsing and installed command metadata checks identify syntax/parameter
  issues only. Passing them does not validate runtime behavior, factual claims, paging,
  authentication checks or generated script safety.

Private answers, prompts, run identifiers and draft artifacts remain outside this
public repository. No tenant changes, message sends or generated-script execution
were performed. PR publication/checks and installed-build results will be recorded
when complete. This review does not mark the live demo ready.
