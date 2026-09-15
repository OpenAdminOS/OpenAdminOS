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
