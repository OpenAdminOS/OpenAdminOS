# Agent Team visual review and proposed follow-up

Reviewed 2026-09-11 against `e98f20e` on `fix/0.6.1-agent-team`.
This is a review and implementation proposal, not a claim that the proposed UI ships.
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

## Findings, in priority order

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

## Proposed terminology

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
information-hierarchy proposal, not a schema migration. Avoid “employee” or “hire,”
which would imply broader human capabilities or employment. Future human invitations
need explicit human/AI distinctions; multiplayer is not implemented by this proposal.

## Proposed first-teammate flow

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
`window-state.ts`. There is no office-specific fullscreen action. Existing window
support makes this feasible without a new rendering dependency; native entry/exit
behavior still needs implementation and testing rather than being inferred from CSS.

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

## Next implementation order and remaining limits

1. Consistent teammate copy and one first-run entry point.
2. Guided setup with persistent actions and retained draft/install recovery.
3. Compact attention summary and office-focused layout.
4. Independent fullscreen and concealment controls with native lifecycle handling.
5. Label collision/reflow fixes and renewed native visual verification.

These are proposed changes. No new UI behavior or release is claimed in this review.
Signed installer upgrades, live app MSAL sign-in/deployment, native screen readers,
Mac manual pointer behavior and native fullscreen transitions remain unverified.
The earlier automated Mac click-stability limitation is not a proven end-user bug.
