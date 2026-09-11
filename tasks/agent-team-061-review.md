# Agent Team 0.6.1 independent review

Review the released 0.6.0 behavior before applying fixes. Work on
`fix/0.6.1-agent-team`; a patch release requires a separate publication decision.

## Coverage

| Flow | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Fresh profile and setup recovery | Native Electron + renderer regression passed | SSH setup pending | SSH setup pending |
| Role presets and persona deployment | Presets passed; deployment passed with fixtures | Pending | Pending |
| Signed team workflow installation | Evidence review through Hub; PowerShell through editor, both signed installs | Pending | Pending |
| Customization, editing, pause, removal | Renderer and host tests passed | Pending | Pending |
| Manual runs, schedules, restart recovery | Host tests + Electron fixture rehearsal passed | Pending | Pending |
| Evidence handoffs, questions, review inbox | Electron fixture rehearsal passed | Pending | Pending |
| Provider unavailable, missing workflows, permissions | Regression tests; live Ollama + read-only Lokka checks passed | Pending | Pending |
| Keyboard, scaling, motion, background behavior | Xvfb rehearsal passed; native assistive technology/hardware pending | Pending | Pending |

The Linux fresh-profile test uses the real Electron host, renderer, registry,
and installed local providers. No tenant credentials are copied. Fixture-backed
execution checks are recorded separately from live tenant checks. Tailscale SSH
connectivity and native desktop interaction must be proven before either remote
platform is marked tested. No private host addresses or account details belong
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
   the Electron executable through its package. Linux rehearsal passes; Windows must
   still be exercised on the target machine.

## Verified passes

- The published signed catalog lists both team workflows with the 0.6.0 minimum.
- Team evidence review installs through Agent Hub into an isolated profile without
  needing to run a persona or consent to tenant writes.

## Remaining prerequisites

- Remote macOS/Windows SSH services and key authentication are not yet reachable.
- Native installer launch, display interaction, and hardware motion/performance
  checks remain unverified until remote access is established.

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
  23 files / 106 tests. Host suite: 231 tests. QA: 181 pass / five existing warnings.
  QA uses the installed Microsoft Graph skill through `MSGRAPH_SKILL_DIR`.
- Source hot reload and a development launch without its renderer server caused test
  interruptions. Final native installation checks used the built renderer without hot
  reload; neither development condition is classified as a shipped-product defect.

## Release status

This is a review/fix branch, not a published 0.6.1 release. Package versions stay at
0.6.0 until patch-release preparation. Do not mark the three-platform audit complete
or approve release readiness until macOS and Windows installation, sign-in, persona
execution, and desktop behavior have been tested on the supplied machines. Live app
sign-in/deployment and real tenant writes were not performed in the isolated Linux
profile. Write boundaries were exercised only with fixtures.
