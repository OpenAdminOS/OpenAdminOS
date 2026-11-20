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
   changed and the modal says so), closes every organization to new work (no
   sign-out: round 22 removed it, see SPEC), turns off the OS scheduler and the menu bar
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
- [x] Store: close tenant work, bounded awaited shutdown, applying-run check
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
- Review round 11: Claude no blocking; Muse one blocking (a volume mounted
  inside the data folder or a cache off Linux); Sol four blocking (the same
  nested mount, manual steps without mount and policy checks, an elevated
  Windows reset removing another account's task). Fixed: every folder tree
  the reset empties is walked for another device, the guide has a "Before
  removing files by hand" section and the Windows script stops on a linked
  policy file, the Windows task is removed only when its action is this
  account's copy, links removed with Directory.Delete instead of cmd. Open
  follow-up: a per-user Windows task name (the scheduler registration is
  outside this change).
- Review round 12: Claude and Muse no blocking (Muse: long refusals were cut
  by the 240 character filter, fixed; unreadable policy entry refuses; Linux
  notice stops on a signal; guide repeats the Keychain command and stops on
  a policy folder); Sol four blocking (task owner on a shared install, the
  Linux findmnt check, the manual steps deleting policy.json, the dialog
  clipped at the minimum window height), all fixed: ownership only by a
  program under this account's profile, `findmnt -rno TARGET | grep -F`,
  `find ... ! -iname policy.json` in the macOS and Linux steps, a scrolling
  dialog body with fixed buttons.
- Review round 13: Claude one blocking (a code fence closed mid-line, so the
  rest of the guide rendered as code), Muse one blocking (the macOS cookie
  store, a plain file, was always skipped by the folder walk), Sol two
  blocking (a service account's task pointing at this profile, `findmnt`
  escaping spaces) plus the same two. All fixed: the walk runs only for
  folders, the task must also run as this account (name or SID), the guide
  decodes mount targets and stops when the check fails, the fences are
  fixed, and a policy.json that is not a plain file refuses.
- Review round 14: Claude and Muse no blocking (Muse: docs did not name the
  non-plain-file policy case, fixed); Sol two blocking (a connector send in
  flight during a reset, a failed `findmnt` hidden by the pipeline) plus a
  medium (a Task Scheduler error read as absent). Fixed: the reset waits for
  any running or queued run and declines connector approvals from the
  request on, the guide's Linux check reports "No mount found" or STOP
  explicitly, and task presence comes from the full task list.
- Review round 15: Claude no blocking; Sol two blocking (Nova sends and
  queued report deliveries during a reset, the Windows guide pasting the
  task query and delete together) plus a medium (a refused reset declining
  a pending approval). Fixed: once every check passes, connector approvals
  are declined and every organization is closed through the tenant
  lifecycle (no new Nova send, delivery or run; the shutdown drains leased
  work; a later refusal reopens them), deliveries skip during a reset, and
  the guide splits the task query and delete.
- Review round 15 (Muse): three blocking, the same quiesce area: a run still
  finishing after cancel or disconnect, Nova sends and delivery passes, and
  run starts after the checks. Fixed with in-flight counters (run starts,
  Nova sends, delivery passes) and RunService.hasActiveDrive in the reset
  check, refusals for new runs and Nova sends once a reset started, plus
  the SPEC timeout sentence and "other than" wording.
- Review round 16: Claude one important (a schedule refused during a reset
  was recorded as a failed run, fixed with LocalResetInProgressError, an
  organization boundary for the scheduler and companion); Sol one blocking
  (sign-out after the folder became a link, skipped now) and two mediums
  (approvals declined and work closed before the marker commit, moved after
  it; the Linux guide ignored XDG paths, fixed); Muse one blocking (the
  WhatsApp test send, gated and counted now) plus the same ordering medium
  and the gateway, Splashtop and rollback starters, gated now.
- Review round 17: Claude and Muse no blocking (Muse lows applied: shutdown
  comment moved, Splashtop and rollback gate tests, Nova follow-up passes
  gated and counted); Sol two blocking (a marker written again through a
  folder that became a link, linked parent folders such as ~/Library/Caches)
  and two mediums (plan starters checked again before saving, `defaults
  delete` failures), all fixed.
- Review round 18: Claude and Muse no blocking; Sol four blocking. Three were
  about links and mounts above the data folder or caches (outside the home
  folder, a mount on ~/.config, the Windows script). Reverted the round 17
  ancestor check instead: a link or mount above the OpenAdminOS folder does
  not widen what a reset removes (only that folder's contents at its real
  location, which the app has been using), and the check blocked dotfile
  manager setups. The fourth (a folder swapped mid wipe) is fixed: the wipe
  keeps the folder's device and inode and stops before the progress record
  and the marker removal if they change. Also: a failed `defaults read`
  warns, the chmod test is POSIX only.
- Review round 19: Claude and Muse no blocking; Sol accepted the "Folders
  above" reasoning and found two blocking: a folder swapped in the middle of
  the removal loop (fixed: identity checked before every removal) and a
  marker restored or roamed with a copy of the folder (fixed: the marker is
  bound to the folder's device and inode). Muse lows: gateway proposals
  counted, a test for an unconfirmed `defaults read`, the notice lifetime
  documented.
- Review round 20: Claude one important (the device number can change across
  a reboot or remount, which would refuse a resumed reset on the same
  machine; the binding now uses inode and birth time); Sol one blocking (the
  warnings rewrite captured a replaced folder's identity; the first write's
  identity is now required for the rewrite and the sign-out) and a test race
  (the confirmation test now waits for the delivery pass); Muse no blocking,
  lows applied (temp marker removal checked too, a cheap per-removal check,
  no identity without inode and birth time).
- Review round 21: Claude and Muse no blocking (the sign-out check now uses
  the shared session comparison; without a birth time the device must match
  too); Sol two blocking (a folder swapped during the async checks before the
  first write, fixed by taking the identity before them; the relaunch pulling
  the embedding model into Ollama's store, skipped on that launch) and a
  medium (the ctime fallback for blocked statx, a birth time equal to the
  change time now counts as unknown).
- Review round 22: Claude and Muse no blocking (Muse nits on two comments,
  applied); Sol two blocking and a medium. The phase 1 sign-out is removed:
  it rewrote token caches in place, which cannot be bound to the folder the
  reset was accepted for (rounds 16, 20, 21 and 22 all found holes there);
  the launch wipe deletes the token files before anything reads them. This
  deviates from the brief's step list and is flagged in the hand-back. The
  Keychain deletion and lookup are limited to the login keychain, in the app
  and the guide. An entry that cannot be removed keeps the entries named
  after it, so a locked `openadminos.db` keeps its `-wal` and `-shm`.
- Review round 23: Claude and Muse no blocking (the SDK comment and two
  lines of this file still described the sign-out, fixed). Sol two blocking
  and a medium. Fixed: closing and draining organizations after the marker
  uses the in-memory state, so the reset never creates a state file in a
  folder swapped in; a lookup across the keychain search list warns when an
  item of the same name is in another keychain. Declined, with the reasoning
  in SPEC ("Accepted limit"): a folder replaced during a single recursive
  removal or the marker's file creation; Node has no handle-relative
  removal, the per-entry identity check limits it to one entry, and only a
  process of the same account can cause it.
- Review round 24: Claude and Muse no blocking; Sol accepted the round 23
  limit and found one blocking (the checks' state read created a missing
  state file, which could replace a restored one; while a reset is checked
  or under way a missing state file is now never created) and two mediums
  (the sandbox flag came back through the relaunch environment, now restored
  to the launch value; the keychain lookup could hide a match or a login
  failure, now each other keychain in the search list is looked up on its
  own with its own warning). Muse lows applied: the same keychain fix, the
  narrower SPEC sentence, a writable check in the close test.
- Review round 25: Claude no blocking. Sol one blocking (on Windows, removing
  a read-only file that a backup also hard links clears the shared
  attribute; such entries now stay and are listed, in the app and in the
  guide's script) and a medium (the post-reset warnings list is now bounded
  and scrolls). Muse one blocking (ordinary state writes still reached
  state.json after the marker; every write is now refused once the marker is
  committed, a queued one included) and a low (the login keychain is
  recognized by file identity in the other-keychain loop).
- Review round 26: Claude no blocking. Sol two blocking and a medium. Fixed:
  on Linux the marker match requires the same device (a Btrfs snapshot
  restored as the home keeps inode and birth time); the Windows guide no
  longer says removing `Local State` protects every copy. Declined, with the
  reasoning in SPEC: a write already running when the reset commits (the
  running app's own exposure; a drain only moves the window). Muse no
  blocking; its lows applied: the commit is checked again before the state
  file rename, an unlistable folder on Windows stays, Windows separators in
  the listed path.
- Review round 27: Claude and Muse no blocking; Sol withdrew the round 26
  in-flight write blocker and found one blocking (on Windows the hard-link
  check runs before the removal and can take seconds; the folder and the
  entry are now checked again right after it, cache folders too) and two
  mediums (the write guard now turns on at the marker's rename, before its
  flush, and atomicRename checks it before every retry; the Linux guide says
  to quit OpenAdminOS first). Muse lows: the SPEC marker bullet names the
  Linux device rule; the retry check has a unit test (the state write's own
  pre-rename check is covered through it, not by a timed integration test).
- Review round 28: Claude and Muse no blocking. Sol two blocking: the data
  folder is now checked before every step outside it, each Keychain
  deletion attempt included, so a profile restored during the cleanup keeps
  its key; a cache folder's identity is taken before all its checks and
  compared after the last one. Muse lows applied: entry identity includes
  the birth time and an entry with neither inode nor birth time counts as
  replaced, a cache recheck test, a failing commit callback is only logged,
  the SPEC cross reference.
- Review round 29: Claude and Muse no blocking. Sol two blocking: on Linux
  the mount table is read again before every removal in the data folder; on
  Windows the account is looked up before the task, the task definition is
  read again right before the delete and the delete runs only when it is
  unchanged (the window between that read and the delete is accepted, the
  per-user task name follow-up closes it). Muse lows: the folder guard runs
  inside the scheduler step before each removal it makes; an unknown cache
  identity has its own reason.
- Review round 30: Claude and Muse no blocking; Sol accepted the remaining
  Windows task window. Sol one blocking (files restored into the same
  folder during the cleanup outside it; the guard now also requires the
  folder to hold only the kept files, so the Keychain key stays and the
  files are listed) and a medium (the Windows folder guard now runs after
  the second task read). Muse lows: the Linux mount table is read again
  right before a cache folder's removal; "another item on this disk".
- Review round 31: Claude and Muse no blocking. Sol two blocking and a
  medium: the audit log's side files are frozen at the commit, including the
  pending retry on close; a cache folder's identity is compared after the
  guard and the mount check; the guard runs once more before the cleanup is
  recorded as done. Muse: the same cache order, and SPEC records the window
  between the last check and the `security` command as accepted. Full suite:
  one Nova follow-up test timed out under load (120 s) and passed three
  times alone.
- Review round 32: Claude and Muse no blocking. Sol one blocking (the
  guard listed the folder after checking it; it now checks the identity
  again after the listing). Muse: no prune while the audit log is frozen
  (medium), and a refused reset unfreezes it (low).
- Review round 33: Claude and Muse no blocking. Sol one blocking (a token
  refresh that returns after the commit wrote or, on a decrypt failure,
  deleted a token cache by path); every token cache store, legacy ones
  included, is now held after the commit: no write, no clear, reads return
  an empty cache without opening the file.
- Review round 34: Claude no blocking. Sol one blocking (closing SQLite
  at the reset shutdown deletes the write-ahead log by path; the databases
  are now left open until the process exits). Muse two blocking and a
  medium, all credential files written or deleted by path after the commit
  (Splashtop, WhatsApp Web, provider and connector secrets). Instead of
  fixing each caller, the commit now seals the data folder for the process
  (data-folder-seal.ts, checked by every secret store), stops the WhatsApp
  Web client, and WhatsApp Web and Splashtop network calls are refused
  once a reset starts and hold it while they run. Muse lows: a reset
  message passes through the sign-in error wording; the token test asserts
  clear and the reopening.
- Review round 35: Claude, Sol and Muse each found the same class: writers
  outside the secret stores still wrote by path after the commit. One rule
  now: every WhatsApp Web client of the process stops for good at the
  commit (package level stop, checked before every socket, credential, key
  and auth folder write or removal, also after awaits); the secret stores
  recheck the seal after awaits; the registry cache, agent manifests and
  uninstall, the index promotion and the window state check the seal before
  their last write; their entry points are refused once a reset has started
  and hold it while they run. Not applied: Muse's low on clearing the
  Connectors error banner on a successful status poll (it would also clear
  action errors).
- Review round 36: Claude no blocking (index download could hold a reset
  indefinitely: now not counted, aborted at the commit, 30 minute timeout;
  a stopped WhatsApp client kept a connected status: it now leaves it).
  Sol and Muse two blocking each, again writers outside the list (queued
  Baileys writes, agent drafts, self-training, window state). Instead of a
  fifth round of per writer checks: a process wide guard on Node's file
  system API refuses every change by path inside the data folder from the
  commit (data-folder-seal.ts), with the marker allowed so its warnings can
  still be added; drafts and self-training are also gated and counted.
- Review round 37: Claude and Muse no blocking (guard verified against the
  compiled ESM build and Baileys' imports). Sol one blocking (AppImage
  restart through the mount that goes away; now through `APPIMAGE`) and a
  medium (scheduler and login item now checked against the committed
  folder). Muse and Claude lows applied: links into the folder resolved,
  update checks stop at the commit (electron-updater captured its fs
  functions), streams fail as streams, the commit stops self-writing work
  before sealing, the rejection log listener is removed on unseal.
- Review round 38: Claude and Muse no blocking. Sol one blocking (the
  relaunch helper's no_new_privs keeps a new AppImage from mounting; a
  detached shell now starts the AppImage file) and a medium (the login item
  retry at the next launch checks the wiped folder). Claude and Muse lows
  applied: seal before the updater stop in the commit callback, a stopped
  updater stays stopped, refused streams log their error, dangling links
  followed, APPIMAGE trusted only inside APPDIR, the marker allowed by exact
  name and temporary pattern, no new hard links from inside, hard links
  that already exist recorded as accepted.
- Review round 39: Claude and Muse no blocking. Sol one blocking (an
  extract-and-run AppImage lost its mode at the restart): an APPDIR that is
  not a mount now restarts with APPIMAGE_EXTRACT_AND_RUN=1, and the shell
  waits for the AppImage runtime too. Muse lows: the AppImage is checked
  for being executable first (logged otherwise), APPDIR compared resolved.
- Process lesson: twice I edited the tree while a reviewer was reading it;
  parked the edits as patches. Recorded in tasks/lessons.md.
- Found in the end to end run and fixed: the incomplete screen called the
  appearance handler before it was registered, and failure reasons repeated
  full paths.
