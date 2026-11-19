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

- [ ] Mockup `docs/mockups/34-local-reset.html` (Settings entry, modal, closing
      state, failure state, reset did not finish, post-reset first run), linked
      from `docs/mockups/index.html`
- [ ] `electron/local-reset.ts`: marker, wipe plan, wipe, leftovers, request
      orchestration with injected steps
- [ ] Main process wiring: IPC (reset, report, dismiss, relaunch, show folder,
      quit), top-level wipe, incomplete mode, phase 2 scheduler and login item
- [ ] Store: forget every sign-in, bounded awaited shutdown, applying-run check
- [ ] Renderer: Data section row, `ResetOpenAdminOSDialog`, reset incomplete
      screen, post-reset notice, settings search item, copy
- [ ] NSIS research and `TODO(ugur)` on `deleteAppDataOnUninstall`
- [ ] Docs page "Uninstall and reset" (gitbook + generated web docs)
- [ ] Tests (electron + renderer), typecheck, Node 22
- [ ] Local unsigned packaged build check with a throwaway profile
- [ ] SPEC.md, CHANGELOG.md
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

(filled in at the end)
