# Full local reset and uninstall guidance (workstream D)

Branch `settings/local-reset` from `origin/main`.

## Problem

Removing the app deletes only the bundle. The data folder, the Keychain item
"OpenAdminOS Safe Storage", MSAL token caches, updater caches and other per-user
files stay, so a reinstall restores tenant access with no sign-in. The app has
no full reset.

## Design

Two phases, so nothing is deleted while Chromium, SQLite or MSAL hold files.

1. **Request (running app).** Settings > Data > Reset OpenAdminOS opens a product
   modal with the impact list and the typed phrase `RESET OPENADMINOS`. The main
   process checks the phrase again, refuses while a write run is applying, then:
   writes a pending-reset marker into the data folder (if this fails, nothing
   changed and the modal says so), removes the Microsoft sign-in of every
   tenant from the token caches, turns off the OS scheduler and the menu bar
   login item, stops the gateway, MCP servers and stores (awaited, bounded), and
   relaunches.
2. **Wipe (next launch, before anything else).** At the top of the main script,
   after the single-instance lock and before `whenReady`, so before any store,
   session, safeStorage or Local State use: if the marker exists, delete every
   entry of the data folder except `policy.json`, the marker and Chromium's
   single-instance lock files. `openadminos.db-audit-anchor.json` and
   `-audit-pending.json` are removed only after the database is gone. Then, in
   packaged builds only: the Keychain item (macOS, exact service and account),
   the scheduler LaunchAgent or scheduled task, updater caches and the other
   per-user leftovers. The marker goes last, so an interrupted wipe resumes at
   the next launch. Data folder failures keep the marker and open a designed
   "Reset did not finish" screen (Try again relaunches, Show folder, Quit)
   instead of the app. Leftover failures are reported on the first-run notice
   and not retried (a later retry could delete the new Keychain key).
3. **After.** The app starts on first run with a notice: what was removed, what
   could not be, and that Entra consent stays in the tenant.

Dev builds: the data folder is `OPENADMINOS_USER_DATA_DIR` when set (otherwise
the shared default folder, which the modal names). Dev builds use Chromium's
mock keychain on macOS, so they never touch the Keychain item, and never touch
the installed app's scheduler, login item or caches.

## Checklist

- [x] Mockup `docs/mockups/34-local-reset.html` (Settings entry, modal, closing
      state, failure state, reset did not finish, post-reset first run), linked
      from `docs/mockups/index.html`
- [x] `electron/local-reset.ts`: marker, wipe plan, wipe, leftovers, request
      orchestration with injected steps
- [x] Main process wiring: IPC (reset, report, dismiss, relaunch, show folder,
      quit), top-level wipe, incomplete mode, phase 2 scheduler and login item
- [x] Store: forget every sign-in, bounded awaited shutdown, applying-run check
- [x] Renderer: Data section row, `ResetOpenAdminOSDialog`, reset incomplete
      screen, post-reset notice, settings search item, copy
- [x] NSIS research and `TODO(ugur)` on `deleteAppDataOnUninstall`
- [x] Docs page "Uninstall and reset" (gitbook + generated web docs)
- [x] Tests (electron + renderer), typecheck, Node 22
- [x] End-to-end check in a development build with a throwaway profile (see Review)
- [x] SPEC.md, CHANGELOG.md
- [ ] PR, reviews (Sol, Muse, Claude), fixes

## Acceptance criteria

- After reset and relaunch the app shows first run, has no tenants, no stored
  tokens, no provider secrets, and a fresh openadminos.db with no audit
  integrity error.
- `policy.json` survives. Nothing outside the listed OpenAdminOS paths is
  touched.
- Typed phrase required; a wrong phrase keeps the button disabled.
- All desktop tests pass under Node 22, typecheck passes.

## Review

- Electron tests (Node 22): 1539 of 1539 pass; `electron/local-reset.test.ts`
  covers the removal plan, policy.json kept, audit anchor removed only with the
  database, resume after interruption, Keychain call arguments, and an end to
  end run with the store (fresh first-run state, audit export without an
  integrity error).
- Renderer tests (Node 22): all pass; 17 timed out in the full run at load
  average 27 and passed when run alone.
- Typecheck passes.
- End to end in a development build with `OPENADMINOS_USER_DATA_DIR` set to a
  scratch folder, driven over CDP: seeded tenant, token file and provider and
  connector secrets; a wrong phrase kept Reset disabled; Reset and restart
  relaunched into first run with the notice, no tenants, `firstRunScan`
  pending, no tokens or secrets, `policy.json` unchanged, and an audit export
  without an integrity error. A folder made undeletable opened Reset did not
  finish; after unlocking it, Try again finished the reset.
- Not done: a packaged build. Installed builds ignore
  `OPENADMINOS_USER_DATA_DIR` and would delete the real Keychain item
  `OpenAdminOS Safe Storage`, so the Keychain, LaunchAgent, login item and
  cache removal ran only in tests with a recorded command runner. Windows was
  not run.
- The seeded end-to-end profile had Ollama as its provider. No message was
  sent and `ollama ps` showed no loaded model afterwards; later live checks use
  a hosted provider only (maintainer rule, 2026-11-19).
- Review round 1: Claude reviewer no blocking findings; Sol four blocking
  (approval race, dev and installed builds sharing a profile, marker commit
  point, Keychain match and retry), all fixed with tests; Muse failed on a
  transport error and runs again in round 2.
- Review round 2: Claude no blocking; Sol three blocking (case-insensitive
  policy file, login item and scheduler repair on a development reset, a
  scheduler-owned process unloading its own LaunchAgent), all fixed; Muse no
  blocking, its medium and low items fixed (folder listed again before the
  marker goes, Windows query timeout counts as unknown, Reset off until the
  impact list loads, login item checked, failed progress record reported).
  Sol confirmed from Electron 42.8.1 sources that the main script runs before
  Local State is read.
- Review round 3: Claude and Muse no blocking (follow-ups applied: yielding
  wake skips the lock, ticks stop after a request, second folder check before
  the marker goes, one warning per item, failed progress record tested); Sol
  four blocking (planted link at the marker temp path, cancelled apply still
  settling, relaunch of a scheduler-owned process, marker committed between
  the pre-lock read and the lock), all fixed with tests where they can run
  here.
- Review round 4: Claude no blocking; Sol three blocking: a data folder or
  token cache that is a link (fixed: refused and skipped), a confirmed apply
  whose record a disconnect removed (fixed: applies tracked in memory until
  they settle), and the pre-lock scheduler repair racing a development reset
  (not changed: a development reset never touches the installed app's
  scheduler by design, so a repointed registration is the intended outcome;
  argued in round 5). Login item warning now replaced or cleared by the retry.
- Review round 5: Claude and Muse no blocking (follow-ups applied: blocker
  copy mentions cancelling, handoff exits after the spawn settles, a real
  drive test for apply tracking, comment placement); Sol withdrew the
  scheduler race and found three blocking (hard-linked token cache, a marker
  that is a link, the recovery window writing into a linked profile), all
  fixed with tests where they can run here.
- Review round 6: Claude and Muse no blocking; Sol three blocking (a folder
  at the marker path, sign-out after a failed folder listing, recovery
  falling back to the original profile), all fixed with tests; a scheduler
  retry that works clears the request's warning; the recovery profile is
  removed on quit.
- Review round 7: Claude no blocking (recovery profile left by app.exit,
  fixed); Muse one blocking (malformed marker), fixed; Sol four blocking:
  trailing separator on a linked folder (fixed), launchctl bootout by path
  (fixed: by label, plain file only), malformed marker (fixed), and the
  single-instance lock created in a linked folder before recovery redirects
  the profile (not changed: Chromium creates its lock files in the profile on
  every launch, before and without this PR; argued in round 8). Linux pre-ready
  notice falls back to zenity or kdialog.
- Review round 8: Claude no blocking; Sol withdrew the lock item and found
  three blocking (a `link/.` style path, a policy.json linked to a file
  inside the folder, the uninstall guide unloading by path), all fixed;
  Muse one blocking (the same path forms), fixed, plus recovery profile
  removal on process exit, no saved window state for the recovery window, and
  a stricter Linux notice fallback.
- Review round 9: Claude and Muse no blocking (follow-ups applied: folder
  at the policy path stops the reset, Keychain loop probes once more before
  warning, policy comparison ignores letter case on macOS and Windows); Sol
  four blocking (`link/../name`, a Linux bind mount at the data folder, the
  Windows manual steps through a junction, a policy link chain through the
  data folder), all fixed with tests, the Windows and macOS manual steps
  check for links first; an empty warning list is written with the progress
  record. The local full suites failed only on load timeouts at a load
  average of 137; every failed file passed alone.
- Review round 10: Claude no blocking; Sol four blocking (nested Linux
  mount, policy link chains through aliases and `..`, Windows manual steps
  past nested links, policy folder only checked at launch) and Muse two
  blocking (policy link with `..`, policy folder at request time). Closed by
  class: any linked policy.json stops the reset, one policy check runs at
  request and launch, a mount at or under a folder (Linux) or a folder on
  another device than its parent refuses removal, the Windows manual script
  walks the tree and removes links as links, and the Keychain loop ends with
  a read-only lookup.
- Found in the end to end run and fixed: the incomplete screen called the
  appearance handler before it was registered, and failure reasons repeated
  full paths.
