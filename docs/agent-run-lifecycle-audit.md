# Agent sign-in and cancellation audit

Date: 2026-09-06. Scope: the 14 repository registry manifests, their shared
read/plan/apply lifecycle, system apply, authentication, persistence, and scheduling.
This is an analysis of the current source, not a shipped fix or a live-tenant test.

## Findings

### P1: Cancel records cancellation but does not stop execution

`apps/desktop/electron/runs.ts:95` saves a cancelled snapshot and adds the run ID
to a set. The set only suppresses progress persistence (`:823`); it is not checked
by the execution drivers, Graph calls, LLM calls, or action loops. An approved
write run can therefore continue changing the tenant while its history says
cancelled. Suppressed snapshots also hide subsequent outcomes from that history.

Affected: every agent's execution; especially `offboarding-agent` and
`stale-guest-cleanup`, plus baseline rollback and approved external proposals.
Typed confirmation is still enforced before apply. This finding concerns stopping
an already approved execution, not bypassing that approval.

Verified with an isolated RunService harness using a two-action rollback and a
deferred first mocked Graph request. Cancel was awaited before releasing that
request. The second request still executed, and the persisted run stayed cancelled.
No Microsoft request was sent. The template apply loop likewise has no stop check
(`packages/runtime/src/agent-template.ts:679`).

### P1: Abandoned incremental sign-in can wait indefinitely

`apps/desktop/electron/state.ts:5277` calls `runInteractiveFlow` without a signal
or timeout. The listener only installs its timer if one is supplied
(`packages/runtime/src/msal.ts:384`). The browser is launched through
`shell.openExternal` (`apps/desktop/electron/main.ts:6235`), so the app has no
window-close callback. Closing the tab/window does not return an OAuth result.
MSAL continues waiting for the loopback authorization response.

The Graph HTTP timeout does not cover this wait: token acquisition occurs before
its timer starts (`packages/runtime/src/graph-adapter.ts:272`). The first Graph
step remains running, matching the supplied Conditional Access screenshot.
Initial tenant setup already supplies an abort signal and a five-minute timeout
(`apps/desktop/electron/state.ts:4937`), but agent consent does not reuse them.
Graph-backed connector setup/delivery call sites also omit these controls.

### P2: Scheduled execution can open an unattended sign-in and block later runs

`fireDueSchedules` uses ordinary `startRun` with a schedule trigger
(`apps/desktop/electron/state.ts:3755`). That trigger does not change the interactive
fallback in `buildGraph`. A missing permission or expired session can therefore
open a browser even for background work. Once stuck, the existing in-flight check
skips future scheduled runs of that agent (`:3744`).

### P2: Stale running records survive application restarts

The persistence reader restores runs unchanged (`apps/desktop/electron/state.ts:5425`);
no startup reconciliation of interrupted agent runs was found. Execution workers
and the cancelled-ID set are process-local. A process exit during a run can leave
a running record without a worker after relaunch, also blocking its schedule.
Retention explicitly protects these records (`:2108`). This is a source finding;
a packaged-app restart was not exercised.

### P2: Confirmation can save running before fallible provider discovery

`confirmRun` writes the running state before awaiting `host.listProviders`
(`apps/desktop/electron/runs.ts:508`). If discovery rejects, the method exits before
starting `driveApply`, leaving the saved run running with no worker. Resolve the
required inputs before committing that transition, or persist a terminal failure.

## Agent coverage

Every entry uses the same incremental-consent path. Exposure depends on whether
silent token acquisition succeeds for the declared scopes, not on the agent name.

| Agent | Mode | Additional apply concern |
| --- | --- | --- |
| compliance-overview | read | None |
| conditional-access-explainer | read | None |
| dormant-app-registrations | read | None |
| find-inactive-devices | read | None |
| intune-device-posture-auditor | read | None |
| offboarding-agent | write | Approved device retirements continue after Cancel |
| os-update-posture | read | None |
| risky-sign-in-triage | read | None |
| secure-score-prioritizer | read | None |
| sign-in-failure-explainer | read | None |
| stale-guest-cleanup | write | Approved guest actions continue after Cancel |
| tenant-change-audit | read | None |
| tenant-health-report | read | None |
| user-license-overview | read | None |

## Recommended correction and acceptance checks

1. Give each execution a cancellation controller propagated through auth, Graph,
   LLM, and connector work. Check cancellation before each subsequent action.
   Keep outcomes for already-dispatched writes, whose remote effects cannot be
   undone by aborting a local request. Do not swallow cancellation in the
   template loop's per-action failure handler.
2. Bound every interactive sign-in wait, using the existing setup timeout as the
   consistency reference. Show that the run is waiting for Microsoft sign-in and
   offer cancellation. A system-browser close cannot itself be observed through
   the current launch API, so a timeout and explicit cancellation are necessary.
3. Make scheduled authentication failure actionable without opening unattended
   consent windows. Reconcile interrupted runs once at startup without replaying
   writes or discarding plans awaiting confirmation.
4. Check terminal-state protection inside the serialized persistence operation,
   so a previously queued progress snapshot cannot revive a cancelled run.
5. Add regression coverage for abandoned sign-in, cancellation during token
   acquisition, late auth success, cancellation between writes, serialized
   snapshot races, restart recovery, scheduled reauthentication, and provider
   discovery failure during confirmation.

## Validation

- Existing sign-in listener, run confirmation, and rollback tests: 15 passed.
- Registry QA: 168 passed, 0 warnings, 0 failures across all 14 agents.
- Mocked cancellation reproduction: confirmed a second write after cancellation.
- Existing green tests do not cover the abandoned agent-consent flow or actual
  cancellation of ongoing execution. Registry QA validates manifest quality,
  not these lifecycle guarantees.

Installed custom agents and version-pinned manifests in a user's app data were
not inspected. The shared-runtime findings also apply to them when they use these
execution paths. No production behavior was changed as part of this audit.
