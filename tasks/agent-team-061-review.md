# Agent Team 0.6.1 independent review

Review the released 0.6.0 behavior before applying fixes. Work on
`fix/0.6.1-agent-team`; a patch release requires a separate publication decision.

## Coverage

| Flow | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Fresh profile and setup recovery | Native Electron + renderer regression passed | Native Electron, isolated profile passed | Native Electron, isolated profile passed |
| Role presets and persona deployment | Presets passed; deployment passed with fixtures | Native presets and fixture deployment passed | Native presets and fixture deployment passed |
| Signed team workflow installation | Evidence review through Hub; PowerShell through editor, both signed installs | Both signed workflows installed through persona editor | Both signed workflows installed through persona editor |
| Customization, editing, pause, removal | Renderer and host tests passed | Renderer and host tests passed | Renderer and host tests passed |
| Manual runs, schedules, restart recovery | Host tests + Electron fixture rehearsal passed | Host tests + native fixture rehearsal passed | Host tests + native fixture rehearsal passed |
| Evidence handoffs, questions, review inbox | Electron fixture rehearsal passed | Native fixture rehearsal passed | Native fixture rehearsal passed |
| Provider unavailable, missing workflows, permissions | Regression tests; live Ollama + read-only Lokka checks passed | Native tenant gate, Ollama readiness, and regression tests passed | Native missing-provider gate and regression tests passed |
| Keyboard, scaling, motion, background behavior | Xvfb rehearsal passed; native assistive technology/hardware pending | Native keyboard, motion suspension, 200% zoom passed; assistive technology/manual pointer checks pending | Native pointer/keyboard, motion suspension, 200% zoom passed; assistive technology pending |

The Linux fresh-profile test uses the real Electron host, renderer, registry,
and installed local providers. No tenant credentials are copied. Fixture-backed
execution checks are recorded separately from live tenant checks. Authenticated
OpenSSH over Tailscale and native Electron execution were verified on both remote
platforms. No private host addresses or account details belong
in this report.

## Findings reproduced before fixes

1. **P1: the initial selected role is not applied.** Create persona marks Policy
   Watcher selected but initializes an empty work order, Manual only, no assessment,
   and different appearance from clicking that same role. Verified in Electron.
2. **P1: installing prerequisites discards the persona draft.** Enter a custom name,
   follow the install link to Agent Hub, install a workflow, and return to Agent
   Team. The editor and its unsaved values are gone. Verified in Electron.
3. **P1: presets silently drop missing workflows.** The preset handler filters its
   work order to installed agents. A partially installed Chief can consequently
   be saved with only part of its advertised responsibility. Confirmed in code;
   the regression test now verifies a renamed, partially installed Chief stays blocked.
4. **P1: provider default can select an embedding model.** A fresh profile selected
   `nomic-embed-text:latest`; live `/api/show` reported only `embedding`, and
   `/api/generate` rejected a harmless test prompt with HTTP 400 (does not support
   generate). The fixed discovery reports four generation-capable local models,
   chooses a generation model, and completes its capability probe in 21 ms locally.
5. **P2: installation errors escape the Hub confirmation dialog.** The Hub previously
   rethrew an installation rejection without a local catch. Errors now remain visible
   alongside confirmation; the persona install regression covers failure and retry.
6. **Test tooling: Windows launcher used a shell shim.** Office rehearsal now resolves
   the Electron executable through its package. Linux and native Windows rehearsals pass.
7. **P1: Windows profile replacement can fail transiently.** Native rehearsal failed
   saving a provider selection with `EPERM` during atomic state replacement. A bounded
   retry keeps the previous file intact. A subsequent complete native rehearsal passes.
   The process holding the file was not identified.
8. **P1: Windows provider arguments were interpreted by the command shell.** A fixture
   prompt containing ordinary punctuation reproduced a shell command error. Native
   executables and official npm entry points now launch without a command shell. Tests
   verify literal prompt/system arguments, empty tool arguments, spaces, and line breaks.
9. **Test portability:** Bash-only CLI fixtures, Unix path assertions, unclosed SQLite
   fixtures, and Git line-ending conversion prevented Windows suite execution. Node
   fixtures, explicit cleanup, platform paths, and LF attributes for signed registry
   files fix these problems without relaxing signature verification.

## Verified passes

- The published signed catalog lists both team workflows with the 0.6.0 minimum.
- Team evidence review installs through Agent Hub into an isolated profile without
  needing to run a persona or consent to tenant writes.

## Remaining prerequisites

- Both remote platforms authenticated using the dedicated review key over Tailscale.
  Native checks used separate checkouts and profiles. Existing signed installations
  and their profiles were preserved. Temporary test tasks, apps, and debug tunnels
  were removed or stopped after testing.
- Signed 0.6.1 installer upgrade and live app MSAL sign-in/deployment remain unverified.
  No installer or release is produced by this review branch.

## Fix verification

- Initial presets include the advertised work order, assessment, appearance, and schedule.
  Missing workflows are retained and block saving until installed or explicitly removed.
- Built renderer served without hot reload inside the real Electron host: select Script
  Bot, rename it, review/confirm the signed PowerShell workflow, return to the draft,
  open/dismiss tenant setup. Name and selected installed workflow survive; saving without
  a tenant stays blocked. No tenant credentials were copied into the isolated profile.
- Renderer tests cover hosted consent, incomplete/renamed roles, installation failure and
  retry, tenant setup cancellation, background refresh, and editing existing assignments
  without adding an assessment or changing provider-default behavior.
- Live Lokka `/beta` reads verified all nine compliance selection fields, the next-page
  response, and invalid-field HTTP 400. Its connection had the required managed-device
  read scope. This verifies the endpoint; it does not substitute for app MSAL sign-in.
- Electron rehearsal: two evidence handoffs, bounded Chief selection of script drafting,
  skipped evidence review, source-linked answer, admin review, zero live tenant writes.
- Rehearsal has 24 personas / six visible seats, hidden-window motion suspension,
  reduced motion, high-contrast emulation, and no horizontal overflow at 200% zoom.
  Xvfb produced no usable frame timing samples, so no hardware FPS claim is made.
- Typecheck, build, full test suite, and registry QA passed. Final renderer suite:
  23 files / 106 tests. Host suite: 234 tests. QA: 182 pass / four warnings.
  QA uses the installed Microsoft Graph skill through `MSGRAPH_SKILL_DIR`.
- Source hot reload and a development launch without its renderer server caused test
  interruptions. Final native installation checks used the built renderer without hot
  reload; neither development condition is classified as a shipped-product defect.

## Windows verification details

- Windows 11 Pro, interactive desktop session, source-built Electron. Both signed
  team workflows installed into a fresh isolated profile. A renamed Script Bot draft
  retained its installed workflow after installation and tenant-setup cancellation;
  Save remained disabled without a tenant and available provider.
- Native fixture rehearsal exercised two handoffs, bounded Chief planning, source-linked
  questions, review actions, and zero live tenant writes. With 24 configured personas
  and six visible seats, a short 90-frame sample had 16.7 ms median / 16.8 ms p95 frame
  time. This is a short hardware observation, not a sustained performance guarantee.
- Full Windows test suite passed, including 23 renderer files / 106 tests. Node 26
  required `NODE_OPTIONS=--no-experimental-webstorage` for jsdom, because its experimental
  storage global otherwise shadowed browser storage. Native Electron required no such
  workaround. Dependency installation used the CI-pinned npm 11.6.2.
- Rehearsal artifacts now identify the actual platform and preserve synthetic execution
  diagnostics on timeout; older artifacts incorrectly hard-coded Linux in their metadata.

## macOS verification details

- macOS 26.6.2 on Apple Silicon. The existing 0.6.0 app passed signature verification
  and remained separate from the source-built review app. The production source build
  and full test suite passed, including 234 host tests and 106 renderer tests. Node 26
  used the same jsdom web-storage flag as Windows.
- Native keyboard interaction verified the initial Policy Watcher work order/schedule,
  signed PowerShell and evidence-review installation, a renamed draft retained through
  tenant setup cancellation, and the deployment gate without a connected tenant.
  The fresh profile discovered the installed local Ollama provider.
- Native rehearsal passed persona deployment, ordered work, two evidence handoffs,
  bounded Chief planning, source-linked questions, admin review, reduced motion,
  hidden-window suspension, and 200% zoom. With 24 personas and six visible seats,
  90 frame samples measured 16.7 ms median and 17.7 ms p95. These are short samples,
  not sustained performance guarantees.
- The development Electron app could not deliver notifications (`UNErrorDomain` 1).
  Signed-app notification delivery with OS authorization remains a validation gate.
  This does not establish a notification defect in the signed release.
- In the separate fresh-profile window, automated pointer stability waits stalled
  before delivering the click; native keyboard activation completed the flow. Manual
  pointer and assistive-technology validation remain outstanding.

## Release status

This is a review/fix branch, not a published 0.6.1 release. Package versions stay at
0.6.0 until patch-release preparation. Do not mark the three-platform audit complete
or approve release readiness until signed installer upgrades, live app sign-in/deployment,
OS notification authorization, and remaining manual accessibility checks have been
completed. Live app sign-in/deployment and real tenant writes were not performed in
the isolated profiles. Write boundaries were exercised only with fixtures.

## Visual follow-up

The [three-platform visual review](agent-team-061-visual-review.md) records native
captures, shared layout and 200% label-collision findings, and proposed teammate
naming, guided setup, and native fullscreen acceptance criteria. These proposals
are not implemented by the functional fixes above.
