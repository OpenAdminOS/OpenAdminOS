# Agent Team visual review and implemented follow-up

Baseline reviewed 2026-09-11 against `e98f20e` on `fix/0.6.1-agent-team`.
The user approved the follow-up below, which is now implemented on the review branch.
No release has been published. Baseline findings are retained for comparison.
Updated product code: `8452b55f1a11d769c9d8f1d5561773ab6acc7a35`.
The page, editor, fullscreen controller and native-check source hashes matched across
all three review machines. Final renderer suite: 23 files / 111 tests; desktop host:
240 tests, including six native-controller lifecycle regressions.
The functional review remains in [agent-team-061-review.md](agent-team-061-review.md).

## Evidence and scope

| Platform | Evidence | Assessment |
| --- | --- | --- |
| Linux | Fresh Electron/Xvfb rehearsal on the reviewed head | Room, expanded presentation, editor and 200% zoom inspected; rehearsal passed |
| macOS | Native Apple Silicon Electron captures from the same review session, retrieved over SSH | Same layout problems; platform typography/shortcut differences render as expected |
| Windows | Native Windows 11 interactive-session Electron captures from the same review session, retrieved over SSH | Same layout problems; native selects and keyboard focus render visibly |

Mac and Windows screenshots were produced during the preceding native review, not
regenerated for this report. Their product code matches this head; the intervening
commit only added the Mac review record. The images use isolated synthetic tenant
and model data, not the user's tenant. Versions still display 0.6.0 because this
branch has not prepared a release. Pixel dimensions differ with native display scale;
these are not pixel-equality tests. The old root screenshots remain historical design
references; the captures linked below are the 0.6.1 review evidence.

| Capture | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Normal office | [Image](../docs/screenshots/office/review-061/linux/office-1440.png) | [Image](../docs/screenshots/office/review-061/macos/office-1440.png) | [Image](../docs/screenshots/office/review-061/windows/office-1440.png) |
| Expanded presentation | [Image](../docs/screenshots/office/review-061/linux/office-presentation.png) | [Image](../docs/screenshots/office/review-061/macos/office-presentation.png) | [Image](../docs/screenshots/office/review-061/windows/office-presentation.png) |
| Editor | [Image](../docs/screenshots/office/review-061/linux/office-editor.png) | [Image](../docs/screenshots/office/review-061/macos/office-editor.png) | [Image](../docs/screenshots/office/review-061/windows/office-editor.png) |
| 200% zoom | [Image](../docs/screenshots/office/review-061/linux/office-zoom-200.png) | [Image](../docs/screenshots/office/review-061/macos/office-zoom-200.png) | [Image](../docs/screenshots/office/review-061/windows/office-zoom-200.png) |

Also inspected the native 900px room captures and forced-colors captures. Forced
colors is Chromium emulation, not an OS accessibility certification. The saved
editor images show editing; first-creation analysis additionally uses the existing
fresh-profile interaction results and the new-role/empty-state code paths.

## Baseline findings, in priority order

1. **P1: the office is largely below the fold.** The normal view places a large
   briefing, search, filters, and nested scrolling findings above the room on all
   three platforms. At narrower widths even the view controls wrap. Preserve a
   compact, always-visible attention summary with a direct review action; make the
   detailed briefing expandable or a dedicated panel. Keep urgent decisions reachable
   without scrolling past the scene. Source: `apps/desktop/src/pages/Office.tsx:150`.
2. **P1: first-teammate setup is a configuration form rather than a guided outcome.**
   The empty-state CTA sends people to tenant settings or the Hub, while the header
   opens the editor. The editor asks for appearance, responsibility, tenant, provider,
   model, ordered agents and advanced policies together. Save and prerequisite
   recovery appear far down the scroll area. Use one entry point and a short staged
   flow with a persistent action footer and visible prerequisite checklist.
   Sources: `Office.tsx:308`, `Office.tsx:903`, `Office.tsx:1186`.
3. **P1: no horizontal overflow is not sufficient zoom validation.** At 200% zoom,
   long scene labels visibly overlap on all three platforms. The rehearsal banner
   also makes the header unusually tall; that part is test-only. Fix the production
   label collisions with selected/focused labels and an accessible roster carrying
   full names/statuses. Reflow controls and retain access to every teammate. Sources:
   `apps/desktop/src/styles/office.css:1035`, `:1582`, `:1722`.
4. **P2: expanded office is not fullscreen.** Expansion conceals the inbox and can
   hide the assignment panel. Presentation also conceals shell information, but
   retains tall header/toolbars, side gutters and a roster extending below the
   viewport. The CSS width cap estimates height with a fixed 420px subtraction,
   rather than fitting the entire room/control stack. Sources: `Office.tsx:167`,
   `apps/desktop/src/styles/office.css:1713`.
5. **P2: controls do not describe their active state.** “Expand office” stays named
   that way when expanded; “Hide details” stays named that way when details are
   already hidden. Both expose `aria-pressed`, but their visible exit path is weak.
   Use explicit enter/exit wording and separate layout from concealment.
   Sources: `Office.tsx:167`, `Office.tsx:185`.
6. **P2: mixed terminology obscures the model.** The sidebar says teammates, header
   says Add persona, search says Persona or finding, and the editor mixes agents
   and workflows. Use teammate consistently for the persistent team member; explain
   its installed workflows separately. Sources: `Office.tsx:147`, `:159`, `:893`,
   `apps/desktop/src/components/office/TeamInbox.tsx`.
7. **P2: artwork is stronger than its operational readability.** Desks, lounge, game
   corner and recognizable icons are present and render consistently. Long names
   truncate in the room and nearby event bubbles compete with labels. Keep full
   names in the roster/detail view, emphasize the selected teammate, and give new
   actionable evidence precedence over ambient decoration. Walking and games must
   continue to mean location/idle behavior, not fabricated task progress.

The original artwork and motion system should be retained. The largest improvement
comes from composition, labels, and setup guidance, not adding another rendering engine.
Review criteria also included the current
[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

## Implemented terminology

| Concept | Recommended interface wording |
| --- | --- |
| Sidebar feature | Agent Team |
| Persistent configured worker | Teammate, with “AI teammate” in introductory explanation |
| Create / edit | Add teammate / Edit teammate |
| Reusable responsibility | Role: Policy Watcher, Research Bot, Script Bot, Chief of Staff |
| Executable installed capability | Agent workflow; do not conflate it with provider skills/plugins |
| One execution | Assignment, with links to its underlying runs |
| Visual location | Office |

Keep internal `OfficePersona`, IDs, routes and storage unchanged. This is a copy and
information-hierarchy change, not a schema migration. Avoid “employee” or “hire,”
which would imply broader human capabilities or employment. Future human invitations
need explicit human/AI distinctions; multiplayer remains outside this change.

## Implemented first-teammate flow

1. **Choose a role.** Show icon, plain-language responsibility, required workflows,
   and expected output. Explain that Research Bot reviews supplied evidence and
   Script Bot drafts PowerShell without executing it. Allow custom configuration.
2. **Prepare its workspace.** Choose tenant and available provider/model. Offer
   contextual setup and retain the draft. Show missing workflows and install each
   through the existing signed catalog and permission confirmation. A missing
   prerequisite must never silently reduce the chosen role's capabilities.
3. **Choose when it works.** Present the role's actual schedule proposal and an
   explicit manual option; summarize the next run and app/background requirements.
   Keep advanced planning, watch rules and time budgets available but secondary.
4. **Review and add.** Summarize role, tenant, data destination, ordered workflows,
   read/write classification and schedule. Preserve hosted-provider consent and
   normal per-write approval. Keep Back and the final action visible while scrolling.
5. **Guide the first result.** Select the new teammate in the office and sidebar.
   Offer an explicit first run when ready, distinguish scheduled from checked, and
   point to evidence once completed. Creation must not fabricate a successful check.

## Fullscreen feasibility and acceptance

The app already declares Electron's native `togglefullscreen` menu role in
`apps/desktop/electron/main.ts:4581` and saves/restores window fullscreen state in
`window-state.ts`. The follow-up adds an office-specific fullscreen controller and renderer action,
using existing Electron window support without a new rendering dependency.

- Provide a dedicated **Full screen** action that focuses the office and uses the
  native window fullscreen capability. Keep **Exit full screen** visible and support
  Escape and native OS exit controls; restore the prior route, selection, layout,
  focus, and window state. Nested dialogs consume Escape before the fullscreen layer.
- Keep **Hide details / Show details** independent. Fullscreen alone must not hide
  the active tenant/provider boundary or imply that names have been concealed.
  Preserve current write-review requirements; an anonymized demonstration view must
  not introduce actions with ambiguous tenant scope.
- Fit the original 1000:560 scene inside both available dimensions, accounting for
  actual toolbar and scope-strip height. Keep floor selection and pause accessible.
  Use an optional drawer for details/roster and accept modest letterboxing to avoid
  cutting off desks or stretching characters. At high zoom, allow accessible controls
  to reflow/scroll rather than shrinking their text below the requested scale.
- Verify normal, expanded and native fullscreen at laptop sizes and 1920×1080 on
  all three platforms, 100%/200% application zoom, keyboard focus, reduced motion,
  hidden-window suspension, window resize, and exiting while a dialog is open.
  Test macOS native Spaces transition and Windows display scaling explicitly.

## Implemented result and verification

- All seven baseline findings are addressed: consistent teammate copy, a four-step
  editor with persistent actions, contextual prerequisites, compact attention summary,
  native fullscreen independent of concealment, selected/focused labels, and a fixed
  evidence strip with a full-name roster. The original artwork and motion remain.
- Creation selects the saved teammate and guides the first assignment. Back preserves
  the draft. Missing workflows remain selected until installed or explicitly removed.
  The review step exposes the actual ordered read/write workflows and data destination.
- Provider setup buttons do not submit the editor. Connected providers that do not
  enumerate models retain an explicitly configured model, matching host readiness.
- Native fullscreen handles Escape, nested-dialog precedence, OS exit and route exit.
  Prior fullscreen is preserved. Linux window-manager resize transitions can emit a
  transient leave/enter pair; the controller confirms a settled native exit before
  releasing the Office view. A host regression covers this sequence.
- The detailed fullscreen capture exposed incorrect work-order evidence after a
  planned skip. Rows now match their workflow slug within the assignment, rather
  than the original step index; skipped rows are explicit and have no false evidence.
  Renderer and native rehearsal assertions cover the correction.
- Cross-platform verification uses source-built Electron and isolated fixture profiles.
  Builds and full suites passed; final targeted regressions and native captures include
  the fullscreen synchronization fix. macOS renderer tests were rerun with two workers
  after a five-second test timeout under load. This was a test scheduling limit, not a
  native app failure.
- Native checks cover windowed 1366×768 and 1920×1080 requests, actual display fullscreen,
  details/concealment, 200% zoom, full-name roster access, and lifecycle exits. Capture reloads wait for the new document before reading selectors, avoiding stale
  frames and a macOS `UnknownVizError` when capturing a destroyed document. Native
  display scale determines actual physical capture dimensions; Windows uses 175% OS
  scaling and macOS uses Retina. At 200% on short displays, controls and roster remain
  scrollable; the entire UI is not promised to fit on one screen.
- Rehearsal still exercises creation, first ordered assignment, two evidence handoffs,
  bounded Chief planning, source-linked questions, admin review, 24 teammates, reduced
  motion, forced-colors emulation and hidden-window motion suspension. No live tenant
  write or PowerShell draft execution occurs.

| Updated capture | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Choose a role | [Image](../docs/screenshots/office/review-061-after/linux/setup-role.png) | [Image](../docs/screenshots/office/review-061-after/macos/setup-role.png) | [Image](../docs/screenshots/office/review-061-after/windows/setup-role.png) |
| Prepare workspace | [Image](../docs/screenshots/office/review-061-after/linux/setup-workspace.png) | [Image](../docs/screenshots/office/review-061-after/macos/setup-workspace.png) | [Image](../docs/screenshots/office/review-061-after/windows/setup-workspace.png) |
| Review and add | [Image](../docs/screenshots/office/review-061-after/linux/setup-review.png) | [Image](../docs/screenshots/office/review-061-after/macos/setup-review.png) | [Image](../docs/screenshots/office/review-061-after/windows/setup-review.png) |
| Normal office | [Image](../docs/screenshots/office/review-061-after/linux/office-window-1366.png) | [Image](../docs/screenshots/office/review-061-after/macos/office-window-1366.png) | [Image](../docs/screenshots/office/review-061-after/windows/office-window-1366.png) |
| Native fullscreen | [Image](../docs/screenshots/office/review-061-after/linux/office-fullscreen.png) | [Image](../docs/screenshots/office/review-061-after/macos/office-fullscreen.png) | [Image](../docs/screenshots/office/review-061-after/windows/office-fullscreen.png) |
| Fullscreen details | [Image](../docs/screenshots/office/review-061-after/linux/office-fullscreen-details.png) | [Image](../docs/screenshots/office/review-061-after/macos/office-fullscreen-details.png) | [Image](../docs/screenshots/office/review-061-after/windows/office-fullscreen-details.png) |
| Fullscreen at 200% | [Image](../docs/screenshots/office/review-061-after/linux/office-fullscreen-zoom-200.png) | [Image](../docs/screenshots/office/review-061-after/macos/office-fullscreen-zoom-200.png) | [Image](../docs/screenshots/office/review-061-after/windows/office-fullscreen-zoom-200.png) |
| Roster after scrolling at 200% | [Image](../docs/screenshots/office/review-061-after/linux/office-fullscreen-roster-200.png) | [Image](../docs/screenshots/office/review-061-after/macos/office-fullscreen-roster-200.png) | [Image](../docs/screenshots/office/review-061-after/windows/office-fullscreen-roster-200.png) |

The earlier fresh-profile signed installation checks remain documented in the functional
review. This follow-up reruns the new guided renderer flow and native fixture deployment;
it does not claim another live app sign-in. Signed installer upgrades, live MSAL
sign-in/deployment, notification authorization, native screen readers and manual Mac
pointer validation remain release checks. The Mac development app still reports
`UNErrorDomain` 1 for notifications. Existing installed applications and their profiles
remain separate from these review builds.
