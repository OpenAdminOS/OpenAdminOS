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
