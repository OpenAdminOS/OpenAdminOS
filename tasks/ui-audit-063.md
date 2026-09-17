# Desktop UI audit, 0.6.3

Status: in progress. Requested scope: all reachable UI controls and installed agents.
Tests use computer use against the installed desktop. An untested control is not a pass.
Tenant writes, connector sends, permission expansion and permanent deletion stop at
review boundaries. Missing accounts or capabilities are recorded as blocked.

## Baseline before the new PR build

Installed `/Applications/OpenAdminOS.app`, 0.6.3, 12 installed agents. The existing
binary predates the new Chat/Team/catalog fixes, so affected acceptance paths must
be repeated after installing the current-head build.

| Screen / control | Observed result |
| --- | --- |
| Cache > Needs attention | Filters to the failed Defender incidents resource; exposes HTTP 400, requested top 250 and endpoint limit 50 |
| Agents > Installed | Opens the 12-agent inventory |
| Installed search | `compliance` filters the list to 6 matching names/descriptions |
| Compliance overview card | Opens its detail page, scopes, settings, result shape and recent runs |
| Configure > number > Save | Saved 15, reopened with 15; restored 14 and verified the original effective threshold |
| Raw manifest disclosure | Opens the loaded YAML |
| Pipeline disclosure and prompt | Expanded seven steps, opened the LLM prompt and verified its contents |
| Share > Open in browser | Opens the correct public GitHub agent directory; test tab closed afterwards |

| Schedule presets | Saved 15m, 1h, 4h, 12h and 24h; corresponding status/toasts verified |
| Custom schedule | Selected hours and saved 30 hours (1800 minutes) |
| Notification toggles | Success, failure and change-only each changed and restored |
| Disable schedule | Restored Manual only after schedule tests |

| Delivery setup / hide | Opens and hides connector options; disconnected services are disabled. No automatic-send rule enabled |
| Uninstall / Cancel | Shows local-removal review and returns with the agent installed |
| Per-run model dropdown | Lists current installed models and unavailable providers; execution deferred to updated build |

## Pending inventory

- Global tenant switcher, quick search, sidebar expand/search, window controls and menus.
- Chat conversation lifecycle, search, prompts, edit/regenerate/cancel, sources,
  exports, workspace attachments, model selection and Nova entry points.
- Agent Team roster/editor, assignments, evidence, findings, handoffs, questions,
  full screen, schedules, pause/stop, retry and three Codex chains.
- Every installed agent: details, preflight, read run or write proposal, result,
  trace, retry, configuration, schedules, update/uninstall confirmation boundaries.
- Hub search/filter/install/update/provenance and custom agent builder.
- Changes, Workspaces, Cache selection/search/preload/cancel/retry/frequency.
- Settings tabs, provider testing, tenant/auth status, storage, export, update/help.
- Connector configuration and review screens; sends require destination-specific approval.

Record failures and fixes below as the audit progresses. No claim that every control
or agent works has been established yet.

## Failures found during click-through

- Per-run model menu ignores Escape in the old installed build. Source fix and keyboard regression test pass; installed verification pending.
- General > Export audit log fails for both JSON and CSV with `content is too long` at 702 retained run records. Source now saves host-generated content directly through the native dialog; large-file regression passes. Installed verification pending.
- Privacy > Copy telemetry payload and documentation Refresh accepted clicks but exposed no visible confirmation. Copy success is not established by accessibility state alone.
- General retention prune controls invoke permanent deletion directly in source. Not clicked against retained user evidence.

## Additional controls checked

- Privacy registry Change opens review, custom input exposes trust acknowledgment,
  Use official restores the canonical field, and Cancel retains the original source.
- Documentation Install from folder opens the native picker; Cancel returns with the
  existing index available. Actual replacement was not needed for this baseline.
- About Create issue opens a review with public-data warnings and disabled submission
  until acknowledgment. Cancel exits without publication.
- Export diagnostics JSON saved to the private local review folder. The UI reported
  success and the file parsed as JSON. No upload occurred.
- What's new opened the correct public CHANGELOG in the browser; test tab closed.
- Chat Clear history opens a deletion review; Cancel preserved the conversations.
- Chat Clear active tenant cache opens a correctly scoped deletion review. No Clear
  action was performed. Computer Use then lost the window before cancellation could
  be verified. Earlier commentary overstated that cancellation; this remains pending.
- Gateway is off. Enabling external-client tenant access requires a separate concrete
  access decision, so the enable control was inspected without activating it.
- About retains an outdated `0.2 readiness` heading in the 0.6.3 build, cosmetic issue.

Computer Use stopped finding the app window after the cache review, including after
session reset and full-path reacquisition. The user was asked to restore the window.

## Installed build 0a11988, resumed after unlock

- Backed up the prior application and complete app data under the private build
  review directory, installed the signed/notarized artifact, and launched via CUA.
  Installed app.asar SHA-256 matches the verified artifact.
- Cancelled the previously open cache deletion review; existing data remained.
- The exact Windows-not-encrypted prompt refreshed live managed-device evidence and
  correctly listed three matches from nine records. Source details and What ran
  showed the endpoint, selected fields and boolean/Windows filters. Regeneration
  returned the same result.
- Edited/resubmitted prompt: encrypted Windows count one, unencrypted macOS count
  three, noncompliant Windows count four and compliant Windows count zero, all
  correctly qualified by the snapshot.
- Unknown-encryption wording with `have` missed direct routing. The investigator
  rejected its invalid field and fetched evidence; Stop produced a terminal cancelled
  response and restored controls. Direct phrasing coverage is fixed in source with
  a regression preserving unsupported extra-filter rejection. Installed retest pending.
- Codex (4.4s), Ollama (1.3s), Apple Foundation (1.3s) and Anthropic (3.5s) provider
  smoke tests passed in Settings. Global provider remains the configured local model.
- JSON (2,366,892 bytes) and CSV (2,118,207 bytes) audit exports both saved through
  the native dialog. Parsed files each contain 2,123 events. This verifies the old
  two-million-character failure is fixed in the installed app.
- Preview catalog uses the same public repository and immutable reviewed manifest
  commit 0a11988 via `demo/pr88-catalog-0a11988`. All 16 hashes verified before push.
  This branch has no Actions trigger without a PR; its Vercel check passed. Main
  catalog is unchanged. Settings source review/save and refresh succeeded.


### Completed Codex Team chain and result controls

- Updated Compliance overview, Team evidence review and Team PowerShell draft through
  the reviewed unsigned preview catalog. No catalog signing key was required.
- Chief, Research and Script use the already configured Codex provider. Script was
  re-enabled after its earlier paused rehearsal. A complete installed chain finished:
  `run_mu35fbtf_kak9sc`, `run_mu35fpab_xh8igq`, `run_mu35g1nc_o7fb3v`,
  `run_mu35i9xs_dqbk7e`. Counts reconcile: nine devices, eight noncompliant, one grace.
  Root structured evidence reaches the final draft. The draft cites all three source
  run IDs. Private exports and PowerShell AST/parameter checks passed; no draft executed.
- Evidence link opens the correct new run. An earlier stale AX URL was an automation
  observation issue. Logs, severity filter, reasoning, Markdown and JSON exports pass.
- Run again on hosted Team results silently failed. Source now routes to assignment
  review and catches ordinary start errors; eight RunResult tests passed before the
  additional tenant-retarget restriction. Installed retest is pending.
- Per-run provider menu closes with Escape and restores focus on the updated build.

### Expanded standalone sweep on the installed build

| Agent | Local configured 8B outcome |
| --- | --- |
| Conditional Access explainer | Completed, but invented a coverage fraction and prematurely suggested enabling a report-only policy |
| Dormant app registrations | Failed: approximately 77,068 input tokens exceed 16,384 context |
| OS update posture | Completed, but unsupported vulnerability-zero wording in summary |
| Tenant change audit | Failed: approximately 16,988 input tokens exceed 16,384 context |
| Tenant health report | Completed, but result omitted grace state and summary skipped stale-inventory-first action |
| Find inactive devices | Completed, but summary overreached toward retirement from inventory alone |
| Intune Device Posture Auditor | Completed, but invented user-assignment conclusion and wrong device names in a state list |

Existing delivery rules caused three reports (OS posture, tenant health and inactive
 devices) to be sent to the configured Teams General channel before the rules were
identified. This was disclosed to the user. WhatsApp attempts failed because it is
unlinked. Further manual delivery is being disabled through UI for the rehearsal;
original delivery settings are retained in the pre-install backup and will be
restored after testing. Do not treat delivery as newly authorized test scope.

The maintainer explicitly approved standalone Codex comparisons. Dormant-app and OS
posture Codex runs completed; content review and remaining comparisons are in progress.
New evidence-budget tests cover oversized individual records, preserved totals,
whole-record samples and explicit partial coverage. Health counts reconcile in a
regression containing grace, missing and future states. These source changes still
need installation and live retest.


- Codex comparisons also completed tenant change audit and tenant health; exact
  report review continues. Stale guest cleanup returned zero planned changes.
- Offboarding produced one proposed action and paused at typed confirmation.
  An incorrect phrase did not arm Apply; Cancel rejected the proposal. No tenant
  mutation was approved. No new permission consent was accepted.
- Local validation after source fixes: 624 Node tests passed, one skipped; 129
  renderer tests passed; full typecheck passed; registry QA 181 pass, four warnings,
  zero failures. Focused Team retry tests passed after adding the cross-tenant guard.


## Final installed-preview follow-up, September 15-16

Code build `db19a6d64209bfc3b84e444e2a99220b39dc83ae` passed current-head
CI, generated-doc verification, Vercel and GitBook checks. Release workflow
35026726405 passed source verification and Windows, macOS and Linux packaging.
Publishing jobs were intentionally skipped; no release was published. The macOS
artifact passed strict/deep codesign verification and Gatekeeper notarization.
The app and complete local data were backed up before replacement. Installed
app.asar SHA-256 is `2dd76b50b4b3df19f2f7699cec6aa87377ff059cbbb3e0c7a452a5163a6ab8f8`.
Tenant, 12 installed agents, history, registry source and configured providers survived.

### Agent results and report quality

All 12 installed agents were exercised through the desktop, including Team workflows
and write-proposal review. This does not mean all model answers passed. Seven
standalone read agents completed with Codex. Updated manifests for dormant apps,
change audit, tenant health and Conditional Access installed through the unsigned
preview catalog with hashes and permission review. No new permission consent occurred.

- Updated dormant-app and change-audit templates also complete locally without their
  previous context overflows. The local model still invents facts or misstates sample
  counts. Completion is a runtime pass and an answer-quality failure.
- Codex retests of the updated templates correctly distinguish full aggregate counts
  from partial detail samples, state included/omitted counts and avoid extrapolation.
- Updated health evidence and Codex prose reconcile all compliance states and lead
  with stale-inventory limits. Conditional Access prose distinguishes report-only
  evaluation from enforcement and requested targeting from resolved membership.
- The installed Codex Team chain completed assessment, Chief review, Research handoff
  and a PowerShell draft. Original structured evidence remains in the final handoff.
  The draft passed syntax and installed command-parameter checks; it was not executed.
  One complete installed chain is established, not three consecutive installed chains.
- Hosted Team retry now opens the owning assignment through Review in Agent Team.
  List/office, zoom/fit, pause/resume motion, hide/show details and fullscreen/exit
  controls changed state and returned successfully.

### Chat and cache

- Direct installed answers passed for the original Windows encryption question,
  encrypted Windows, unencrypted macOS, Windows compliance and unknown-encryption
  wording, plus exact user/group/app-registration/Conditional Access inventory totals.
  Counts were checked against source rows; cache limitations remain visible.
- Conversation rename, pin/unpin and Markdown export passed. The exported local file
  was present. Prompt edit/resend, regeneration and cancellation were exercised.
- Sign-in request failed answer quality: it did not list the five requested entries
  and recorded outcomes. The licensing fix discovers the correct endpoint, but the
  local model still requested invalid fields and then an unsupported cache resource.
  Those requests were rejected. A usable licensing seat table is not established.
- Retry incomplete repaired the Defender incidents collection. Cancel preload produced
  a cancelled terminal state while retaining prior snapshots. A subsequent full
  refresh completed all 45 selected catalog resources. This does not mean every Graph
  endpoint is covered or that stale devices recently checked in.

### Nova voice and other UI

With explicit approval for the configured OpenAI speech provider, setup validation
passed and Start reached Listening. Mute changed the state to microphone muted;
Stop returned to idle and reset session consent. Fullscreen, conversation visibility
and voice-settings navigation worked. No spoken question and audible answer were
verified. This is session-lifecycle evidence, not complete audio acceptance.

Quick search filtered navigation and dismissed with Escape. Changes field diff and
attribution opened; time comparison returned rows. A local audit baseline was created
with zero drift and retired while preserving history. Cross-tenant comparison needs
a second connected tenant. A local audit workspace was created, received a note and
was archived without deleting chat/run/cache history. Native run-link picker opened
and was cancelled; actual linking was not established.

### Coverage limits

The audit remains incomplete for every-control acceptance: some provider/connector
paths need accounts, multi-tenant paths need another tenant, destructive operations
were not applied, actual voice conversation is unverified, and local-model factual
failures remain. Every search/filter combination and all lifecycle variants have not been
exhaustively exercised. These are not passing results.


### Final cleanup and review

All nine manual-delivery toggles were restored through the desktop after the test
runs completed. A read-only comparison of every installed agent's delivery object
against the pre-audit backup found zero differences. There were no queued, running
or awaiting-approval agent runs at cleanup. The earlier three Teams reports remain;
no cleanup message or deletion was sent.

The final-build Nova retest also exercised unmute back to Listening and Stop answer
while idle, followed by Stop Nova and overlay close. Actual interruption of spoken
output remains unverified. The final license answer explicitly states that failed
lookups prevent a verified count, rather than reporting zero.

The teammate wizard exercised all role choices, required-field validation, workflow
refresh, schedule/advanced disclosure, final work-order review and Back/Cancel.
No additional teammate or scheduled assignment was created.

Code review revisited catalog schema/revision/hash enforcement without signatures,
Codex completion isolation, bounded record envelopes, direct-count routing, licensing
query constraints and Team retry tenant boundaries. Current-head checks passed and
GitHub reported no reviews or unresolved review threads. This is an author review,
not an independent reviewer approval.


Custom builder follow-up: the local model's generated YAML failed parsing after its
repair attempt. The UI displayed the line-specific error and blocked Test/Save. Manual
YAML correction and removal of an unsupported selected user field passed validation.
Test draft passed tenant/provider/schema/scopes/connector/write-gate preflight and
unlocked Save & install. The unsaved draft was closed; no extra agent was installed
or run. Generation quality failed, while validation and recovery controls passed.
