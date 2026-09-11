# Agent Team verification evidence

These captures come from the actual Electron renderer and isolated local Graph/model
fixtures. All tenant names, devices, users, and runs shown are rehearsal data.

- `office-1440.png`, `office-1100.png`, `office-900.png`: responsive desktop views.
- `office-list.png`, `office-editor.png`: operational list and scrollable editor.
- `rehearsal-*.png`: assessment baseline, investigation, delegation, and review.
- `office-24.png`: four-floor team with 24 persisted personas.
- `office-presentation.png`: tenant/details concealed and persona names anonymized.
- `office-zoom-200.png`: 200% application zoom, with no page overflow.
- `office-high-contrast.png`: Chromium forced-colors and reduced-motion emulation.
- `agent-team-rehearsal.webm`: silent recording of the investigation, 5 captured frames/second.
- JSON files record assertions, scope, handoffs, and the measurement environment.

The recording shows Policy Watcher establish a compliance baseline and collect a
changed count. Research Bot receives the current and previous evidence. Chief of
Staff skips a redundant review and delegates a PowerShell draft. A persona question
uses the resulting source references, and the admin acknowledges the findings.
The draft is never executed. The full sequence uses real persistence, IPC, scheduling,
run execution, template rendering, and finding-review paths.

## Repeat the rehearsal

From the repository root, after installing dependencies:

```sh
npm run build:packages -w @openadminos/desktop
npm run build:electron -w @openadminos/desktop
OPENADMINOS_OFFICE_SMOKE_OUT=/tmp/team-rehearsal xvfb-run -a node scripts/smoke-office.mjs
node scripts/render-office-rehearsal.mjs /tmp/team-rehearsal
```

The last command requires FFmpeg on PATH, or `FFMPEG_PATH` pointing to its executable.
The capture uses a temporary app profile and cleans it up. It cannot use a packaged
app's capture flags. On a normal desktop, omit `xvfb-run -a` where appropriate.
The native runtime and renderer builds must finish before starting the capture;
building shared packages while Vite is capturing can trigger a development reload.

## Native fullscreen and guided setup review

The `review-061-after` folders contain the updated setup steps, normal office,
native fullscreen, concealment and 200% captures from Linux, macOS and Windows.
See [the visual review](../../../tasks/agent-team-061-visual-review.md) for platform
provenance and limits. Older captures above are historical references.

To include native window lifecycle checks on an interactive desktop:

```sh
npm run build
OPENADMINOS_OFFICE_BUILT_RENDERER=1 OPENADMINOS_OFFICE_NATIVE_VISUALS=1 OPENADMINOS_OFFICE_SMOKE_OUT=/tmp/team-review node scripts/smoke-office.mjs
```

Use the equivalent environment-variable syntax in PowerShell on Windows.
`OPENADMINOS_OFFICE_BUILT_RENDERER=1` serves the completed renderer build to avoid hot
reload during capture. Native checks exercise entry, Escape, dialog precedence,
OS exit, route restoration and room fit at 200%. They require a window manager;
bare Xvfb runs the regular fixture rehearsal without those native transitions.
Capture tooling temporarily disables background throttling to obtain current frames,
then restores production visibility behavior for the hidden-window motion assertion.

## Validation limits

The host tests cover tenant/configuration baselines, normalized evidence, queue and
approval budgets, independent work, proposal revalidation, consent renewal, findings,
watch conditions, handoff deduplication, planner bounds, conversations, retries, and
calendar/DST behavior. Renderer tests include a simulated hour of idle operation,
24-persona reachability, reduced motion, and preserved edits during refresh.

The Electron capture verifies the full investigation, source references, scoped
questions, review actions, floor navigation, focusable roster, responsive layouts,
200% zoom, high-contrast emulation, and hidden-window motion suspension.

`office-performance.json` records one renderer JavaScript heap snapshot. This is not
total application, native, or GPU memory. The headless compositor supplied no usable
animation-frame callbacks during sampling, so frame time is recorded as null rather
than reporting a fabricated FPS result. Native Windows/macOS performance and extended
live-tenant operation, Windows High Contrast, and screen-reader sessions remain
release validation on representative admin hardware. No numeric performance target
is claimed from Xvfb captures.
