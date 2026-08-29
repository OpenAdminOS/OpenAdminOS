# Changelog

All notable changes to OpenAdminOS are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- A fresh install now starts guided: launching with zero connected tenants opens tenant setup automatically (permissions review, Microsoft sign-in, then provider selection when none is connected). The dialog is dismissible, appears at most once per launch, and setup stays contextual once a tenant exists.
- Baseline rollback: drifted objects can be rolled back to their pinned baseline state through the standard write confirmation gate. The host builds a deterministic plan (restore modified values, delete drifted additions, recreate deleted objects where Graph supports it), requires the exact typed phrase such as ROLLBACK 4 OBJECTS, applies actions strictly in order, and stops at the first failure with an exact count of what was applied. Changes that cannot be safely automated (directory roles, app credentials, domains, and anything Graph does not document a write for) are listed for manual review instead of being guessed.
- Named drift baselines: pin a tenant's current tracked configuration as a named baseline, then see added, removed, and modified drift against it with field-level diffs. One active baseline per tenant; retiring keeps history; retention pruning never deletes configuration versions an active baseline pins. The Changes view gains a Baselines section with create, rename, and retire flows, per-resource drift counts, and expandable field diffs.
- Opt-in install and usage telemetry: off by default, counts and versions only (bucketed tenant/agent/run counts, app version, OS, and whether the provider is local or hosted), never tenant content, prompts, or results. The exact JSON payload the Privacy preview shows is byte-for-byte what a ping sends, and nothing is sent unless the user opts in and the build has a collector configured.
- Local documentation retrieval engine: the desktop app can rank a locally installed documentation index (Intune, Entra, Defender) against a question using a loopback embedding server, with source-file provenance on every result and an honest "not documentation-grounded" state when the index is absent. Query embedding refuses any non-loopback endpoint so retrieval stays on the device.
- Baseline export and import: export a baseline as a portable local JSON bundle (tenant-specific fields stripped, no third-party content ever bundled), and compare any tenant against an imported bundle for the golden-tenant workflow.
- Fleet view: for installs with two or more tenants, a Fleet section shows every tenant's active baseline, drift counts, and last capture time, filterable by tenant group, with recent multi-tenant runs. The nav item is hidden for single-tenant installs.
- Governed MCP write-gateway: external AI clients (Claude Code, Codex, and other MCP clients) can connect to a local, loopback-only, token-authenticated gateway bound to one tenant. Reads use the same allowlist as Chat; the only write capability is proposing a plan, which queues inside OpenAdminOS for the standard typed confirmation and can never self-apply. Off by default.
- Gateway settings now manage tenant binding, pairing tokens, connected clients, and listener state, while pending external proposals are visible from the status strip and labeled by client and required scopes in run review.
- Configuration compare in the Changes view: diff a tenant against itself between two dates (with an explicit warning when retention limits the window), or diff two tenants side by side. Cross-tenant matching uses unique display names, never guesses on duplicates, and excludes tenant-specific fields and, by default, assignments.
- The drift timeline now tracks Entra configuration surfaces: named locations, authentication methods, authorization, and cross-tenant access policies, directory roles, administrative units, app registrations, service principals, and domains.
- Chat now reads Entra and Defender data as first-class cached resources: named locations, authentication methods policy, authorization policy, cross-tenant access policy, directory roles, administrative units, app registrations and service principals (including credential expiry), domains, Defender alerts and incidents, and Secure Score history and controls. Tenant consent gains "Identity and access" and extended "Security and sign-ins" groups, and a tenant consented before this release gets a clear reconnect path instead of a raw Graph 403 when refreshing the new resources.

- Tagged releases now build, sign, and publish a Windows x64 NSIS installer, plus `latest.yml` so electron-updater can auto-update Windows installs. The installer is per-user, so installing and updating never require local administrator rights.
- Release publishing verifies the Windows Authenticode signature and signer common name before uploading, and fails with the actual certificate subject when it does not match the configured publisher.

### Changed

- Renamed remaining user-facing "Intune Chat" copy to "Chat" and broadened chat prompts across devices, users, apps, policies, sign-ins, and identity.

- Windows code signing runs through Azure Artifact Signing (formerly Trusted Signing): the certificate is short-lived and rotated by Microsoft, the key never leaves Microsoft's HSM, CI holds only a revocable service principal credential, and SmartScreen reputation is established faster than with the previous OV certificate.
- `appx` is no longer the default Windows build target. Microsoft Store packaging validation remains available as an opt-in manual workflow job and is still never published.
- Documented Windows installation, including how to verify the publisher and what to expect from SmartScreen while the organization-validated certificate accrues download reputation.

### Removed

### Fixed

### Security

- The Windows release gate fails closed when DigiCert KeyLocker credentials are missing, and the signing hook refuses to emit an unsigned build unless packaging validation opts in explicitly.
- Windows signing is pinned to SHA-256 only. electron-builder's default also performs a SHA-1 pass, which spends an extra KeyLocker signature per file and fails against a modern certificate.

## [0.4.3] - 2026-08-07

### Added

- Added a shared contextual tenant-activation dialog with grouped Graph permission review, cancellable browser sign-in, provider readiness, safe pending-action restoration, and explicit resume controls.

### Changed

- Fresh installs now open the real Chat-first app shell. Suggested questions fill an editable local draft, and tenant setup starts only when a tenant-backed action is attempted.
- Updated the README product screenshot to the current Chat-first desktop interface with sourced findings and a matching-agent recommendation.

### Removed

- Removed the blocking multi-step onboarding page; the legacy `/onboarding` route now redirects to Chat.

### Fixed

- Made Chat cancellation reliable when Stop is pressed before the host has finished registering the new stream.

### Security

## [0.4.2] - 2026-08-07

### Added

### Changed

### Removed

### Fixed

- Kept the apt repository passphrase optional for the existing unencrypted signing key while still requiring the private signing key for tagged Linux releases.

### Security

## [0.4.1] - 2026-08-07

### Added

### Changed

### Removed

### Fixed

- Delayed automatic version tagging until the exact main-branch commit passes CI, allowing post-merge generated documentation to reconcile before release packaging starts.
- Pinned Electron smoke launches to their first test route so renderer startup navigation cannot race the onboarding or support-flow assertion.

### Security

## [0.4.0] - 2026-08-07

### Added
- Added release compatibility gates for stable macOS updater and Linux package identities, aligned workspace versions, release notes, and preservation of legacy JSON and SQLite data during additive migration.
- Added a standalone interactive HTML review of the implemented v0.4 desktop navigation, Chat history drawer, primary routes, and persistent trust status.
- Added the implemented v0.4 quality pass: typed UX/trust/error copy, shared native and renderer shortcuts, accessible overlay and command-palette behavior, Chat send-state/retry/draft handling, searchable Settings deep links, contrast and motion invariants, and a 42-artifact responsive screenshot matrix including write confirmation.
- Added restorable conversation and Settings routes, including explicit recovery for deleted or unknown local conversation links.
- Added a Claude Code Fable-informed v0.4 quality gap-closure companion plan with measurable UX-writing, interaction-polish, and accessibility targets.
- Added and refined with Claude Code Fable an interactive v0.4 UX concept mockup centered on the composer, with a Chat-first front door, single contextual rail, progressive context controls, searchable Settings, and outcome-first agent cards.
- Added an implementation-ready v0.4 UX simplification round-two plan focused on a Chat-first surface, stable navigation, progressive disclosure, and a moderated usability gate.
- Added deterministic local related-agent hints in Chat, with conservative keyword/synonym matching against installed agents and a dismissible transcript card.

### Changed
- Tagged releases now build and publish only macOS Apple Silicon and Linux x64 packages; Windows AppX packaging validation is manual-only until its signing path is ready.
- Centered the Chat empty-state guidance and suggested questions directly above the composer in both the desktop UI and interactive v0.4 review.
- Refined the desktop color system: warm near-black sidebar token, an explicit on-accent foreground token replacing hardcoded ink literals, split placeholder and decorative faint text tokens, semantic foreground/background pairs with a more distinguishable danger red, and reduced copper allocation (neutral Chat user bubble with a copper edge, info-toned activity meters and pulses, neutral pins), with `_design.css` and the v0.4 review mockup aligned to the same warm palette.
- Hosted multi-tenant consent audit records now describe the one-response acknowledgement truthfully instead of recording an unavailable remembered-consent choice.
- Aligned the design-system specification with the warm stone and amber tokens already used by the desktop app and v0.4 concept.
- Stabilized the v0.4 rail with Chat, Agents, Changes, and Settings grouped directly below the active tenant, while route-specific context stays inside the active workspace.
- Collapsed the desktop sidebar into Chat, Agents, Changes, and Settings, with Agent Hub and Schedules moved under Agents tabs.
- Chat history now closes completely at constrained widths and opens as a readable full-text drawer instead of leaving a numbered mini-rail.
- Refreshed GitBook docs for the 0.3.0 surface: corrected the LLM provider lineup (Anthropic, LM Studio, Azure OpenAI, Apple Foundation now shipped), fixed stale v0.2.1 version pins, published a Features section for Intune Chat/Workspaces/Changes with new Intune Chat and drift pages, and aligned nav references with the collapsed sidebar.

### Removed
- Removed platform-specific screen-reader release gates and evidence requirements; general keyboard, focus, semantic, contrast, and reduced-motion accessibility remains in scope.
- Removed the redundant Home destination and its duplicate checklist/dashboard; `/` now redirects to Chat. Removed the permanent sidebar issue-report card because issue reporting remains available in Settings → About and contextual recovery.
- Removed inert `openadminos://` copy-link actions until the desktop app registers and handles that protocol.

### Fixed
- Removed a provider-fixture cleanup race that could make Linux CI fail after all assertions passed.
- Fixed the local Graph QA setup helper so its documented `eval` invocation exports the resolved reference-data path to child processes.
- Made the Electron Intune Chat smoke fixture inject deterministic provider readiness instead of depending on Ollama being installed on the CI host.
- Made CI and release-source documentation gates fetch full Git history so path-specific generated metadata stays deterministic on GitHub runners.
- Fixed Linux release packaging with an explicit executable and desktop identity, aligned the packaged Electron runtime with the audited lockfile, refreshed desktop and website dependencies to zero known audit findings, preflighted Electron before parallel host tests, and made smoke/capture runners resolve hoisted tooling reliably.
- Made tagged macOS and Linux releases fail closed before publication when signing or notarization secrets are missing, while preserving unsigned manual packaging validation.
- Completed the v0.4 functional hardening pass: full beta Graph pagination, non-idempotent retry safety, Autopilot projection compatibility, server-side Changes search, capped-cache drift correctness, schedule activation anchoring, tenant-data purge on disconnect, connector permission/confirmation fixes, updater error recovery, and a missing-route recovery state.
- Closed the independent Opus 5 review findings: Graph `$top` remains a page-size hint while all continuation pages are read, Changes search is debounced, disconnect/MSAL failures are visible and stop deletion, retry delays are bounded, schedule re-enables get a fresh anchor, Chat recovers from failed cancellation, and Electron test modules are excluded from release packages.
- Made remote agent installs and updates verify the signed official registry plus per-manifest SHA-256 digests, persist with rollback-safe atomic writes, and remove downloaded manifests on uninstall.
- Enforced OS secure storage for provider and connector credentials on Linux, owner-only local data file modes, and collision-safe atomic state writes.
- Added release-source gates for typechecking, tests, Graph/registry QA, generated documentation, builds, and Electron smoke flows, and aligned OpenAdminOS-owned package metadata to 0.4.0.
- Fixed a Chat cancellation race where a late stream-start event after Stop could violate the send-state transition model, and made Electron smoke/screenshot runners ignore an inherited `ELECTRON_RUN_AS_NODE` shell setting.
- Sanitized user-visible Chat, Settings, and write-confirmation error details, completed command-palette focus trapping and zoom controls, and made the remaining scheduled-section scroll respect reduced motion.
- Kept conversation-rail search and tenant refreshes from switching the URL-owned open transcript as a side effect.

### Security
- Added detached Ed25519 verification and monotonic replay protection for the official agent index, manifest digest pinning, stronger typed destructive-confirmation phrases, and fail-closed connector capability dispatch.

## [0.3.0] - 2026-07-05

### Added

- Added the tenant drift timeline with versioned configuration snapshots, field-level diffs, audit attribution, a Changes page, the read-only `query_drift` chat tool, and local retention controls.
- Marketing landing page rework: new hero ("AI agents for your Microsoft 365 tenant. Run locally, approved by you."), pre-rendered Remotion hero demo video with reduced-motion poster fallback, traction strip with live GitHub stars and real agent/install stats, three-step "How it works" section replacing four overlapping sections, top-5 real registry agents with install counts, and a trimmed FAQ; plus a new top-level `remotion/` video project.
- Added single-tenant Intune Chat investigative mode with bounded read-only tool calls, streamed tool progress, persisted "What ran" traces, deterministic fallback, and a Settings mode control.
- Added a Vitest and Testing Library renderer test baseline for write confirmation, hosted-provider consent, and provider settings.
- Added Anthropic via the local Claude Code CLI and LM Studio via its local OpenAI-compatible server as runnable LLM providers.
- Added Azure OpenAI provider configuration in Settings with endpoint, deployment, API version, write-only encrypted key storage, and renderer coverage for key replacement.
- Added `docs/agent-sdk.md`, a practical author guide for manifest fields, step kinds, write confirmation, local QA, and community submission.
- Added a marketing examples gallery with copyable Build your own Agent prompts for read, write, and connector-backed agents.
- Added configurable run-history retention in Settings with 500-run/180-day defaults, never-prune support, startup/scheduler/manual pruning, workspace/live/confirmation exclusions, last-prune reporting, IPC coverage, and focused host/renderer tests.
- Added explicit local JSON/CSV audit log export with retained run history, write-confirmation events, connector delivery audit entries, recorded hosted-provider consent events, retention metadata, and a SHA-256 hash chain.
- Added `docs/mockups/09-registry.html` and `docs/mockups/10-empty-states.html` design references and swept implemented screens against the empty-state patterns.
- Added reusable output pane components shared by chat answer artifacts, run results, and the investigation tool trace.
- Added write-plan and run-confirmation invariant tests covering typed-phrase enforcement, plan/apply mismatch rejection, and tenant pinning.
- Added a dev-only `npm run screenshots` harness that captures Agent Hub detail PNGs for every registry entry plus app-shell hero shots under `docs/screenshots/`.

### Changed

- Extracted Electron state module-level helpers into focused desktop helper modules without changing runtime behavior.
- Extracted the Electron Intune Chat domain from `state.ts` into a dedicated service without changing the public store API.
- Extracted the Electron post-run connector delivery domain from `state.ts` into a dedicated service without changing the public store API.
- Extracted the Electron run lifecycle domain from `state.ts` into a dedicated service without changing the public store API.
- Updated README and operating docs to reflect the v0.2.5 shipped surface and the `web/` marketing site path.

### Removed

- Removed the stale desktop renderer `types.ts` in favor of a narrow display-agent type.

### Fixed

- Tightened renderer accessibility basics across v0.3 Intune Chat, Settings, Run Result, output panes, and clear existing control-label/card interaction offenders.
- Fixed write-intent detection to match imperative verbs as whole words so read questions about assignment or enablement state ("apps assigned but not installed") are answered instead of refused.

### Security

## [0.2.5] - 2026-07-04

### Added

- Added v0.2.5 multi-tenant Intune Chat for explicit read-only tenant scope review, local tenant groups, saved queries, readiness preflight, hosted-provider batch confirmation, deterministic Windows compliance aggregation, result filters, local exports, and split-to-workspaces evidence import.
- Added single-tenant Workspaces as a top-level `/workspaces` surface with local SQLite-backed workspace CRUD, pinned evidence, notes, linked chats, linked runs, local instructions storage, Markdown dossier export, and deletion boundaries that leave chats, runs, tenants, and Graph cache intact.
- Added multi-tenant chat and Workspaces contracts, validated Electron IPC/preload APIs, mockups `11-multi-tenant-chat.html` and `12-workspaces.html`, GitBook documentation, and focused host tests for partial tenant failures and workspace deletion/split-result boundaries.
- Added streamed multi-tenant chat progress IPC, tenant-pinned cross-tenant agent batch records, chat-answer pinning to Workspaces, explicit workspace context attachment in Intune Chat, and hosted-provider confirmation for attached workspace context.

### Changed

- Bumped app, workspace package, and UI-displayed version metadata to 0.2.5 for the v0.2.5 roadmap.

### Removed

### Fixed

- Added visible keyboard focus states to the v0.2.5 Workspaces and Intune Chat custom controls and tightened the new mockups' narrow-width layout during the UI/UX verification pass.

### Security

## [0.2.4] - 2026-06-13

### Added

- Added outbound-only Outlook, Slack, Discord, and Signal connectors with connector setup UI, encrypted write-only Slack/Discord secrets, per-agent delivery toggles, queued post-run notification delivery, and focused connector/runtime tests.
- Added GitBook connector documentation covering setup flow, delivery rules, and setup requirements for Teams, Outlook, WhatsApp Web, Slack, Discord, and Signal.

### Changed

### Removed

### Fixed

- Fixed packaged Linux startup on VM/no-3D systems by disabling Chromium GPU/VAAPI acceleration and adding a main-window reveal fallback when `ready-to-show` never fires.
- Fixed release prep so v0.2.4 release PRs bump the new Outlook, Slack, Discord, and Signal connector package versions.

### Security

- Added desktop-side and server-side secret redaction for support issue text before upload and public GitHub issue creation.

## [0.2.3] - 2026-06-10

### Added

- Added Plausible Analytics to the marketing website, with privacy and spec copy clarifying that analytics is limited to public website pages.
- Added the first macOS menu bar companion implementation: Electron Tray lifecycle, `#/companion` popover route, shared companion snapshot IPC, read-only Intune Chat prompting through the existing stream path, upcoming schedules, recent activity, and due read-schedule quick actions.
- Added macOS menu bar companion launch controls in Settings and the tray context menu, backed by shared companion launch IPC, release diagnostics, and Electron's Login Item API.
- Added a generated macOS `OpenAdminOS Menu Bar Helper.app` login item bundle to the desktop build, copied into `Contents/Library/LoginItems` and verified in the release workflow.
- Added a root `vision.md` product vision for a macOS-only OpenAdminOS menu bar companion with shared Intune Chat, schedule, cache, and runtime architecture.
- Added the Intune Device Posture Auditor as the first built-in MXC-backed script agent, with a strict `execution.kind: script` manifest contract, brokered Graph/LLM access, and generated Agent Hub docs.
- Added a host-mediated MXC sandbox broker that validates Graph, LLM, connector, write-plan, and log requests over brokered stdio/file IPC without passing tenant tokens or secrets into sandboxed code.
- Added an experimental MXC sandbox runner/probe behind `OPENADMINOS_EXPERIMENTAL_MXC=1`, with sandbox diagnostics in Settings -> About and shared broker protocol types for future host-mediated agent execution.
- Added a Settings -> General toggle for experimental sandboxed code, persisted off by default and limited to built-in MXC-backed preview agents.

### Changed

- Strengthened marketing homepage Google site-name signals with explicit OpenAdminOS hero copy, canonical homepage schema URLs, and no evergreen homepage `dateModified`.
- Auto-tag release automation now detects the `release: vX.Y.Z` marker from the full merge commit message, so normal release PR merges can cut tags as well as squash merges.
- Simplified the macOS menu bar companion into an Ask-first popover with compact cache/schedule actions, activity shown only when useful, a smaller idle window, the OpenAdminOS app icon as the status item, and route-level renderer code splitting to remove the large initial chunk warning.
- Stopped reporting passive run, cache, provider, and scheduler issues inside the macOS menu bar companion popover; detailed remediation stays in the full desktop app.
- MXC sandbox diagnostics now include SDK-reported backend methods, Windows isolation tier, and probe warnings when available, with remediation copy aligned to the current `wxc-host-prep` subcommands.

### Removed

### Fixed

- Fixed the v0.2.3 GitHub Release notes to use the full sectioned changelog instead of GitHub's generated PR summary.
- Fixed macOS menu bar companion startup when a hidden background scheduler instance already owns the single-instance lock before the user opens the app.
- Packaged macOS builds now include the MXC SDK executor and point the sandbox runner at it so the Intune Device Posture Auditor can start without requiring a separately installed `mxc-exec-mac`.
- Release publishing now explicitly overwrites existing release assets so v0.2.3 backfills can replace the signed installers and updater metadata.
- Aligned v0.2.3 version metadata across the WhatsApp Web connector, desktop/runtime dependencies, marketing package metadata, renderer fallback state, and release-prep automation.
- Linux tenant sign-in now refuses unprotected secure-storage fallbacks and shows Debian/KWallet keyring recovery copy instead of the raw Electron safeStorage failure.
- Apt repository generation now indexes Electron Builder `.deb` filenames after validating package architecture from control metadata.
- MXC sandbox runs now set `config.process.cwd`, require that cwd to be covered by the filesystem policy, and only pass the SDK `experimental` spawn flag for MXC backends that require it.
- MXC script agents now broker over per-run file IPC, with the Intune Device Posture Auditor verified on macOS Seatbelt using both Node and Electron-as-Node.

### Security

- Documented that future sandboxed code must use the OpenAdminOS host broker for Graph, LLM, connector, and write-plan operations; MXC is optional public-preview isolation and not the sole trust boundary.
- Documented Microsoft's current MXC preview warning that SDK-generated policies may still be overly permissive, so OpenAdminOS keeps broker validation and tenant safeguards as independent boundaries.

## [0.2.2] - 2026-06-05

### Added

- Added a local retry queue for post-run Teams and WhatsApp Web delivery, with connector audit metadata and focused tests for delivery success, skipped rules, retries, and disconnect cleanup.
- Added a WhatsApp Web connector with QR linking, automatic QR refresh, phone-side setup guidance, default/test target selection for My WhatsApp, groups, and manual recipients, Baileys reconnect handling, redacted recipient logging, and per-agent outbound run notifications.
- v0.2.2 planning now scopes Intune Chat as a first-class tenant interaction surface, with Graph cache, agent-as-skill routing, and optional approved local self-training.
- Intune Chat now has a SQLite-backed read-only tenant chat surface with Graph cache refresh, compact answer packs, agent-as-skill suggestions, and optional approved local self-training overlays.
- Intune Chat Graph cache refresh now supports per-tenant scheduled refresh intervals, local next-run/failure state, OS scheduler integration, and compact Microsoft Graph audit-log selects validated through the Microsoft Graph MCP.
- Intune Chat host tests now cover Graph cache refresh, answer-pack generation, local persistence, agent suggestions, and pending self-training suggestions.
- Added `npm run smoke:intune-chat`, an Electron smoke test that exercises the tenant-connected chat UI through the real preload/IPC path with a local tenant fixture and a 10-prompt chat pass.
- Added a researched 150-question Intune Chat bank covering common admin investigations, with tests that require every question to map to known local Graph cache resources.
- Intune Chat planner tests now validate cache endpoints, delegated permissions, and selected fields against the bundled Graph PM indexes.
- Added a v0.2.2 app review covering Intune Chat UX, Graph cache reliability, Electron security hardening, LLM provider trust, and live Graph spot-check results.
- Added Apple Foundation as a macOS-only local LLM provider backed by Apple's on-device Foundation Models framework, with helper packaging, context-window budgeting, token usage, and compact Intune Chat answer packs.
- Added a sidebar Report issue flow that creates a public GitHub issue only after explicit confirmation, sends sanitized diagnostics through the server-side support endpoint without exposing a GitHub token to the desktop app, still supports local diagnostics export, and ships with a focused Electron smoke test.

### Changed

- Marketing navbar now keeps only Blog, Documentation, GitHub, and the Download button as primary links.
- Published five Markdown-backed Microsoft 365 admin blog posts and refreshed the blog index/article reading experience.
- Blog content path resolution now works from both the website root and repository root, and the Vercel build mirror exposes traced Markdown files and missing website packages for deployment finalization.
- Blog articles now have post-specific social preview images wired into Open Graph, Twitter metadata, schema, article headers, and blog cards.
- Blog posts now use shorter SEO titles where needed, visible editorial bylines, and added mini-case sections for stronger SEO/GEO depth.
- Marketing navbar now links to a new server-rendered blog with Microsoft 365 admin SEO/GEO articles while keeping the Intune use-case page indexable.
- Marketing landing page macOS helper text now links to the macOS package options on the downloads page.
- Marketing and GitBook macOS PKG copy now names Intune alongside Jamf and Munki for managed rollout.
- GitBook docs now cover v0.2.1 builder, community sharing, registry trust, and the exact macOS/Linux download posture.
- GitBook installation docs now include the `repo.openadminos.com` apt repository commands for Ubuntu and other Debian-family installs.
- Release CI now publishes the apt repository under the `repo.openadminos.com` custom GitHub Pages domain.
- Release tags now publish the Linux `.deb` into a signed GitHub Pages-backed apt repository, generated automatically from the release artifact.
- Redesigned the Connectors page around an operational summary, clearer live connector panels, and a quieter connector backlog.
- Simplified the Connectors page connected-state flow by moving permissions, capability, routing-rule, trust-boundary, and backlog details into compact disclosures while keeping setup and notification targets visible.
- Connector delivery now appears as post-run activity steps for Teams and WhatsApp Web, including sent, failed, and rule-skipped outcomes.
- Updated the spec, roadmap, and operating instructions to mark OpenAdminOS as public preview.
- Marketing downloads page now uses compact platform rows with separate macOS DMG and PKG links while the landing CTA remains the DMG.
- Release tags now publish a macOS `.pkg` alongside the DMG/ZIP outputs, with marketing and docs exposing it as the managed deployment package.
- A one-off `v0.2.1` macOS PKG backfill workflow now builds the missing signed/notarized installer package and refreshes release checksums.
- The temporary `v0.2.1` macOS PKG backfill workflow was removed after the successful release update.
- Release docs now include the CLI CSR path for generating the Developer ID Installer certificate used by macOS PKG signing.
- Release tags now publish Linux x64 AppImage, `.deb`, and `.rpm` artifacts with SHA-256 checksums while keeping Windows build-only.
- The v0.2.1 release was backfilled with Linux x64 AppImage, `.deb`, and `.rpm` artifacts built from the v0.2.1 tag.
- Marketing download surfaces now expose Linux AppImage, `.deb`, and `.rpm` package links with SHA-256 verification while leaving Windows pending signing.
- Marketing download page now renders Linux package SHA-256 hashes inline while retaining the full `SHA256SUMS.txt` link.
- Marketing hero download buttons now use equal-width platform controls with aligned notes for macOS, Linux, and Windows.
- Marketing landing page now aligns software schema, Windows availability copy, mobile comparison tables, and skip-link accessibility with the current release state.
- Marketing headers now use a compact mobile stack menu aligned with the logo row instead of a separate row of top buttons.
- Marketing privacy, terms, footer, schema, sitemap, and `llms.txt` now use `support@openadminos.com` and link a new `/legal-notice` provider-identification page for OpenAdminOS and managing director Ugur Koc, with `/impressum` kept as an alias.
- Marketing FAQ items are now accessible native accordions, with the primary product definition expanded by default for SEO/GEO visibility.
- Marketing landing page now folds the OpenAdminOS definition into the visible FAQ instead of a separate definition card.
- Marketing search appearance now uses a crawlable 48px PNG favicon, 180px Apple touch icon, clearer secondary page titles, `WebSite.alternateName` schema, and explicit AI-search crawler access in robots.txt.
- Marketing Vercel builds now mirror the Next build output and link root dependencies during Vercel builds so Git Integration finalization can deploy root-directory `web/` projects.
- Marketing landing page now includes answer-first product copy, operating-mode comparison, Microsoft Graph permission context, and visible common questions for SEO/GEO coverage.
- Marketing site SEO now uses canonical `www` URLs, route-level metadata, structured data, stable sitemap dates, `llms.txt`, and compressed social preview images.
- SEO audit artifacts now use an ignored `.seo-cache/` workspace cache.
- macOS release packaging now builds the Apple Foundation helper on macOS 26, signs it inside the Electron app bundle, and verifies it is present before uploading DMG artifacts.
- Marketing hero and README copy now frame OpenAdminOS around local-first AI agents for Microsoft 365 admins, including local model cost and approval-gate benefits.
- Marketing landing page sections now lead with admin outcomes, local model cost control, open agent runtime, and review-gated tenant changes.
- Marketing navbar now links to the public documentation site.
- Marketing header now shows Docs and GitHub actions on mobile.
- Intune Chat now uses a minimal two-pane layout with chat history on the left and the conversation/composer in the center; cache and self-training controls moved to Settings.
- Intune Chat now streams assistant output over Electron IPC and persists only the final completed or failed assistant message.
- Intune Chat streaming now keeps preload listeners alive until terminal stream events so fast local-model responses do not strand assistant drafts.
- Intune Chat answer packs now include bounded row-compaction metadata (`selectedRows`, `includedSampleRows`, and `omittedCachedRows`) so large tenants stay within local-model context limits.
- Intune Chat Graph planning now covers apps, detected apps, MAM/app configuration, Autopilot/enrollment, remediations/scripts, Windows updates, endpoint security, assignment filters, scope tags, encryption, troubleshooting, audit, and Conditional Access resources.
- Intune Chat now sends on Enter, keeps Shift+Enter for newlines, removes the duplicate composer focus border, offers collapsible chat history and copy prompt/response actions, and shows cache/model work as a progress checklist inside the active assistant response slot.
- Intune Chat agent suggestions now use inline Details disclosures instead of generic "Ask first" follow-up prompts, and write-agent actions are labeled Review.
- Intune Chat agent suggestions now suppress write agents for read-only investigation prompts, keeping actions like guest cleanup out of stale device sync questions unless the admin asks for a write.
- Intune Chat agent suggestions now show matched prompt terms, routing evidence, and planned Graph sources, and write-agent routing rejects category-mismatched write suggestions.
- Intune Chat answer packs now include a generation timestamp so time-bounded admin questions do not require the model to infer the current date.
- Intune Chat Graph cache refresh now follows Graph pagination with page/cap metadata, and stale managed-device sync questions are filtered deterministically from SQLite before model generation.
- Intune Chat now caches Autopilot events as a fallback source for enrollment/ESP questions when Windows Autopilot device identity reads fail service-side.
- Intune Chat completed answers now expose source details with Graph path, selected fields, query parameters, row/page counts, cap state, freshness, cache/live status, and stored source errors.
- Intune Chat now requires explicit first-send confirmation before a hosted provider receives tenant context, with a per-tenant/provider remember option stored on the device.
- Intune Chat hosted-provider confirmation is now enforced by Electron main before chat persistence, Graph refresh, or hosted LLM prompt construction, and chat/cache IPC payloads now receive runtime validation.
- Intune Chat new-conversation sends now show the prompt and progress checklist immediately, keep streaming reloads from wiping the progress bubble, and show the active draft in the chat history rail.
- Intune Chat conversations can now be searched, pinned, renamed, and deleted locally through validated Electron IPC and product modals, with pinned conversations grouped in a collapsible sidebar section and right-click delete available on conversation rows.
- Settings -> Intune Chat now shows local SQLite size, chat/cache/self-training counts, and explicit local-deletion modals for clearing all chat history or the active tenant's Graph cache.
- Intune Chat now keeps a transient in-flight draft visible during new-conversation sends, exposes prompt edit/resend from user messages, and can export local Markdown transcripts with source metadata.
- Intune Chat now exposes Stop during streaming responses, aborts cancellable provider work through the host stream controller, and persists a cancelled assistant entry without saving generated tail output.
- Intune Chat assistant messages now expose Regenerate, which resubmits the preceding prompt through the normal chat pipeline with consent, cache refresh, progress, and Stop behavior intact.
- Intune Chat no longer shows a global Refresh button in the chat header; prompt-scoped refresh runs during send, while manual and scheduled cache controls stay in Settings.
- Desktop copy actions now use a shared clipboard helper backed by the bounded Electron main clipboard bridge, and local destructive actions such as tenant disconnect and agent uninstall use product modals instead of native browser confirmation dialogs.
- The Intune Chat smoke now verifies first-run onboarding's connected-tenant path, workspace choice screen, Chat entry action, Stop, Regenerate, and the 10-prompt chat pass.
- First-run onboarding now ends with a workspace choice: open Intune Chat as the recommended first action, browse Agent Hub for repeatable workflows, or optionally install a starter agent.
- Desktop renderer security now runs with Electron sandboxing, a sandbox-compatible preload bridge, no remote font loads, system font stacks, and a restrictive Content Security Policy.
- Renderer-only browser tabs now show a designed desktop-bridge-unavailable state instead of logging noisy no-tenant onboarding redirects.
- LLM provider trust now sanitizes Codex CLI subprocess environments and treats non-loopback Ollama endpoints as external instead of local-only.
- Registry source changes now validate and normalize source URLs, require confirmation for custom registries, bind cached indexes to their source URL, and expose a Settings Privacy modal for reviewing or changing the active source.
- Privileged Electron IPC handlers now validate trusted sender frames and narrow connector, agent, run, tenant, draft, community submission, external URL, and save-file payloads before reaching host state.
- Installed write-agent cards now route to the existing Agent Detail run preflight instead of an undefined confirmation route.
- Tenant connection now requests the Graph PM-audited read scopes needed by the full Intune Chat cache surface, and the chat planner now uses the documented scopes for scripts, troubleshooting events, group reads, and encryption-state resources.

### Fixed

- Fixed connector notification settings so Teams and WhatsApp Web delivery rules/default targets autosave and runs use newly enabled delivery without a separate save button.
- Fixed WhatsApp Web disconnect cleanup so stale default targets, per-agent custom targets, and queued WhatsApp deliveries are cleared when the linked session is removed.
- Fixed WhatsApp Web session restore so saved linked-device auth reconnects automatically after reopening the app instead of waiting for a manual send/test action.
- Fixed WhatsApp target mode switching so internal group JIDs are not carried into manual Number/JID fields.
- Fixed provider selection/trust messaging so selecting a model under an inactive provider activates it, overview surfaces show the active provider's selected default model, and run surfaces show the run-pinned provider/model context.

### Security

- WhatsApp Web QR setup now keeps the raw pairing token out of renderer-facing connector status.

## [0.2.1] - 2026-05-29

### Added

- GitBook documentation source under `docs/gitbook`, deterministic generated agent/reference docs, and a GitHub Action that opens docs update PRs after relevant commits to `main`.
- v0.2.1 candidate backlog covering Build your own Agent reliability, community sharing through GitHub PRs, and registry trust hardening.
- Build your own Agent now has guided prompt context fields, an LLM repair pass for invalid YAML, editable manifest validation, and a capability review before Save & install.
- Build your own Agent drafting now knows about schema v2 patterns, avoids reserved slugs, defaults new user-authored agents to `0.1.0`, validates connector declarations, and suggests alternate slugs on collision.
- Build your own Agent now supports local preflight before save, in-place editing for user-authored agents, upstream-ready local folder export, version editing, and builder-focused tests.
- User-authored agents can now start a guided Share with community flow with metadata collection, local QA gate, generated submission package, builder success entry point, submitted-review state, and public GitHub issue creation through the rate-limited web API.
- Registry updates now record installed-agent provenance and require an explicit trust review before applying updates that add Graph scopes, change write actions, add connector egress, or raise `minAppVersion`.
- Registry QA now checks duplicate slugs, semver, README presence, index coverage, and content safety for secrets, tenant identifiers, personal data, and unsupported guarantee language.
- Public agents now declare `minAppVersion`, and Agent Hub/Agent Detail show "Update OpenAdminOS" instead of allowing install, run, or update flows for agents that require a newer app.
- CODEOWNERS now requests maintainer review for public agents, registry QA/schema/generation, SDK/runtime trust boundaries, desktop registry/update code, workflows, and community submission intake.

### Changed

- Public GitBook docs now hide generator implementation details, show admin-readable confirmation phrases, and correctly document nested LLM steps in agent pages.
- v0.2.1 community sharing scope is public-only: private registry forks and internal/private share flows are deferred.

### Removed

### Fixed

- Graph QA no longer emits warnings for bundled valid Graph endpoints, select-property checks, curated sample backing, or AJV `date-time` / `uri` schema formats.
- Build your own Agent flow now has clearer guided options, a working version editor, an edit-cancel path that closes cleanly, a less duplicated review surface, honest preflight warning copy, Settings recovery for unavailable providers, and Open agent as the primary post-save action.
- Build your own Agent now rejects path-like or otherwise invalid local agent slugs before writing to the user-agents directory, and write-agent community submission copy now describes typed-confirmation write actions.
- Corrupt or undecryptable MSAL token cache files are now cleared so scheduled runs ask the admin to reconnect the tenant instead of showing Electron's raw safeStorage ciphertext error.
- macOS background scheduler launches now use accessory activation before startup so OpenAdminOS does not briefly flash in the Dock for scheduled runs.

### Security

- Registry updates now perform trust-boundary review before writing the manifest override, so an unconfirmed update cannot shadow the installed agent on disk.
- Community submission intake now parses and validates submitted manifests server-side, rebuilds the GitHub issue body on the server, updates duplicate open submissions with the latest manifest digest, and no longer trusts the desktop-provided QA body as authority.

## [0.2.0] - 2026-05-28

### Added

- Desktop sidebar now has an Agents → Schedules submenu with a schedules overview page for active per-agent schedules, run-now actions, disable controls, and command-palette navigation.
- OS scheduler registration for macOS/Windows: after tenant sign-in, OpenAdminOS can install a per-user LaunchAgent or Task Scheduler task so due agent schedules run through the signed app while the UI is closed.
- OpenAI Codex LLM provider backed by the locally installed `codex` CLI. The adapter probes CLI install/auth state, populates the model picker from Codex's local model cache, and runs agent LLM steps through `codex exec --ephemeral --skip-git-repo-check -s read-only` without storing OpenAI API keys.
- LLM provider smoke tests in Settings. Connected Ollama/OpenAI Codex rows now have a Test action that runs a tiny completion and reports model + response time.
- Run detail now shows a compact execution context strip with tenant, provider, model, and queued/finished time so livestream viewers can see exactly what was used.
- Schedules page now has Run due and Run all actions for demoing scheduled agents without waiting for the next interval.
- Agent reports now stream into the run page while LLM steps generate. Ollama uses native chat streaming; OpenAI Codex uses `codex exec --json` message events with a final-message fallback.
- Ollama LLM runs now wait up to 3 minutes by default, with a specific timeout remediation for slower local models.

### Changed

- Privacy, terms, README, and marketing copy now disclose production registry install counts where needed, remove stale email-capture references, and keep the no-tenant-telemetry guarantee precise.
- Settings → Privacy now has a Registry install counts toggle; when enabled, public agent installs report only slug, app version, platform, and a yearly per-agent hash.
- Marketing landing page now uses a fuller product narrative with trust/provider proof, registry preview, write-confirmation showcase, open-source proof, and a final download CTA.
- Marketing release badge and macOS download CTA now resolve from the latest GitHub release instead of requiring a manual version bump.
- Marketing footer now keeps the OpenAdminOS wordmark as plain text and links to the company LinkedIn page with an icon.
- Marketing and legal pages now pass mobile-width overflow checks, and reduced-motion users see the diff confirmation content without animation.
- Marketing and legal page headers now show the OpenAdminOS app icon next to the wordmark.
- Marketing footer and terms now include Microsoft trademark and non-affiliation language.
- README now matches the current desktop app behavior: tenant connection is mandatory before running agents, Agent Hub uses the GitHub-hosted registry with local cache/fallback, and the shipped-version table reflects v0.2.0.
- Conditional Access explainer now reviews report-only/disabled policies, broad exclusions, grant/session controls, client app types, risk conditions, stale policies, and Zero Trust coverage as manifest v1.1.0.
- Dormant app registrations agent now reads credential, permission, redirect URI, app role, publisher-domain, and age signals, reports a stricter review-first cleanup posture, and ships as manifest v1.1.0.
- Onboarding and provider settings now describe Ollama and OpenAI Codex as available providers, with hosted-provider trust messaging for Codex.
- Onboarding provider copy now uses the OpenAdminOS name, removes stale "Coming in 0.2" badges, and shows detected model counts/defaults for connected providers.
- Settings model counts now say "available" for hosted providers and "installed" for local providers.
- Run result layout now leads with the agent report, moves tenant/provider/model into a compact run-context side rail, and keeps telemetry below the report instead of letting metadata dominate the first viewport.
- Run result report markdown now renders numbered report sections as compact headings with calmer body typography, so generated agent output reads like a report instead of oversized raw markdown.
- Run result pages no longer show the raw structured result panel by default, keeping the page focused on the agent report, pipeline, logs, and telemetry.
- Agent detail pages now keep the Schedule card in the visible right sidebar instead of burying it below the manifest preview.
- Schedule cards now support custom numeric intervals in minutes or hours in addition to the preset chips.
- Scheduled runs are now stamped as scheduler-triggered, always produce a completion/failure OS notification, and automatically unregister the per-user OS scheduler when the last enabled schedule is removed.
- Schedules page countdowns now update live by second under one minute, switch to a spinner while a scheduled run is queued/running, and briefly show a green completion check after the run finishes.
- macOS run notifications now keep native notification references alive and log native `show`/`failed` events so unsigned dev-build notification failures are visible.
- Schedules now include a health panel, recent schedule activity timeline, per-agent notification preferences, changed/no-change finding badges, and failed scheduled-run records when background preflight fails.
- Activity now has manual, scheduled, failed, and needs-confirmation filters so scheduled automation is easy to audit.
- Agent detail pages now expose Schedule as a header action, and run result pages add a compact Main finding / Risk / Next action brief above the run telemetry.
- OpenAI Codex provider settings now show Codex auth, default model, available model count, and smoke-test feedback in one place.
- Desktop runtime now uses Electron 42.3.0 for the v0.2 signed build.
- Scheduler health now shows short actionable Graph failure text, clears stale errors after a later successful scheduled run, and no longer displays the macOS signed-build notification caveat.
- Agent Hub now uses a simplified store-style browse layout with one catalog, no Agents/Dashboards split, dynamic category filters, scope-aware search, install/open actions, and no oversized featured or registry-metric cards.
- Agent Hub details now hide raw manifests behind an explicit review action, onboarding uses catalog-style first-agent cards, agent runs open a tenant/provider/model preflight review before queueing, and Schedules hides internal health diagnostics unless attention is needed.
- Agent runs now block preflight without an active tenant, warn on hosted providers and likely incremental consent, Agent Hub installs require explicit permission confirmation, Schedules exposes latest outcome plus notification preferences, Settings includes a 0.2 readiness panel, and workspace/app versions now read 0.2.0.
- Run provider menus and Settings now label unfinished provider/options as "Coming soon" instead of tying them to the v0.2 release.
- Agent detail pages now include per-agent Microsoft Teams delivery rules for terminal run reports, with default/custom channel targets and manual/scheduled success/failure filters.
- Find inactive devices now reviews sync age alongside compliance, OS, ownership, enrollment, and oldest-device evidence, and ships as manifest v1.1.0 with review-first cleanup guidance.
- Offboarding agent now enriches retire plans with compliance, OS, ownership, enrollment, trust, account, and inactivity-day evidence, excludes personal devices by default, and ships as manifest v1.1.0.
- OS update posture now reviews OS version distribution alongside compliance, ownership, enrollment, and stale inventory evidence, and ships as manifest v1.1.0 with conservative lifecycle wording.
- Risky sign-in triage is now honest about reading Entra risky users, requires Entra ID P2, adds risk-level/state/detail/processing breakdowns, and ships as manifest v1.1.0.
- Secure Score prioritizer, sign-in failure explainer, stale guest cleanup, tenant change audit, tenant health report, user license overview, and compliance overview now ship as manifest v1.1.0 with richer deterministic evidence and more conservative report prompts.
- Tenant health report no longer hard-requires Teams posting; scheduled/report delivery is handled by installed-agent delivery settings.

### Removed

- Windows AppX packages are no longer uploaded as workflow artifacts or attached to GitHub Releases while the Windows signing path is pending; CI still builds the AppX for packaging validation.

### Fixed

- Write agents now complete as no-op runs when their filters produce zero actions instead of failing before confirmation.

### Security

## [0.1.9] - 2026-05-22

### Added

- **Per-agent over-the-air updates.** Each installed agent now compares its persisted version against the registry version on every `getAppState()` and surfaces an `updateAvailable` chip on the agent card plus a full "Update available" callout on the agent detail page. Clicking **Update** fetches the new `manifest.yaml` from the registry's raw GitHub URL, validates it against the agent-template schema, persists it to `<userData>/agent-updates/<slug>/manifest.yaml`, and refreshes the installed entry's registry-derived fields. User settings, schedule, and `installedAt` are preserved across the update; settings keys that no longer exist in the new manifest are dropped silently. Failures (network, schema, slug mismatch) throw with an actionable message and leave the installed manifest untouched. New IPC `openadminos:update-agent`, new bridge method `api.updateAgent(slug)`, new SDK type `AgentUpdateInfo`, new runtime exports `compareSemver` / `setAgentUpdatesDir` / `getAgentUpdatesDir`. Detection rides the existing registry refresh — no background polling, no auto-update.
- **Offboarding agent** (`agents/offboarding-agent`) — open-source replacement for Microsoft's retired Intune Device Offboarding Agent. Reads `/deviceManagement/managedDevices` (Intune) and `/devices` (Entra), correlates by `azureADDeviceId` ↔ `deviceId`, and flags candidates that are stale by both signals (configurable: `both` | `intune-only` | `entra-only`). Excludes devices already in flight (`retirePending`, `retireIssued`, `wipePending`, `deletePending`). New free-text `instructions` setting feeds admin-supplied guidance into the LLM rationale step. Confirmation phrase: `OFFBOARD N DEVICES`. Unlike the Microsoft agent, this one actually executes the Intune retire — it is not a suggestion list. Requires the new scope `Device.Read.All` alongside the existing managed-device read + privileged-operations scopes.
- `correlate-stale-devices` transform kind in the agent-template runtime — joins two device arrays by `azureADDeviceId`/`deviceId`, applies a per-strategy staleness filter, and skips in-flight management states. Documented and validated alongside the existing `filter-by-age` / `group-by-age` family.

### Changed

- `TODO(uli)` markers and CLAUDE.md guidance now use `TODO(ugur)` to match the maintainer's actual name.

### Removed

- **Breaking: `retire-inactive-devices` agent removed.** Replaced wholesale by `offboarding-agent`. On first launch of 0.1.9 the persisted entry for the old slug is filtered out of `installedAgents[]` — no migration of settings, no card-rename. Users reinstall `offboarding-agent` fresh from the registry, which now ships in the app bundle. Historical CHANGELOG entries that mention the old slug are left intact for traceability.

### Fixed

### Security

## [0.1.8] - 2026-05-21

Patch release cleaning up two cosmetic regressions from the v0.1.7 rebrand. **First release built and published as a public repo** — the auto-update target now works for v0.1.7 installs on macOS.

### Fixed

- **DMG install background no longer shows "Open Agents".** The top-strip section label (`OPEN AGENTS` -> `OPENADMINOS`) and the install headline (`Drag Open Agents to Applications` -> `Drag OpenAdminOS to Applications`) were still rasterized with the old wording inside `background.tiff`. The bulk text rename in v0.1.7 only touched source code; pre-rendered images had to be regenerated separately. Source SVG in `apps/desktop/build/dmg-background.svg`, regen steps in `apps/desktop/build/README.md`.
- **Version pill in the desktop UI is now correct.** Sidebar, status strip, Settings -> About, and the onboarding step indicator all showed `v0.1.5` because the strings were hardcoded in four places. They now read from `apps/desktop/package.json` at build time via a `__APP_VERSION__` constant injected by `vite.config.ts`. `prepare-release.mjs` is the only place the version is ever touched, end to end.

### Removed

- `web/.env.example` — orphan from the earlier email capture flow (deleted in v0.1.7). The marketing site has no build-time required env vars anymore; every remaining env var is optional and only consumed at request time by the stats routes.

### Auto-update

If you have v0.1.7 installed on macOS, your app will detect this release on next launch and prompt to install. This is the first cross-version test of the auto-update channel under the new `OpenAdminOS/OpenAdminOS` repo and `com.openadminos.desktop` bundle ID.

### Downloads

- **macOS** -- `OpenAdminOS-0.1.8-arm64.dmg` (signed with Developer ID, notarized by Apple)
- Hashes published alongside the DMG in `latest-mac.yml`.

### Security

## [0.1.7] - 2026-05-21

### Changed

- **Project renamed: Open Agents -> OpenAdminOS.** Repo moved to `OpenAdminOS/OpenAdminOS`. Affects the display name across the desktop app and marketing site, the Electron `productName` and `appId` (`com.openadminos.desktop`), all workspace npm packages (`@openagents/*` -> `@openadminos/*`), every internal IPC channel (`openagents:*` -> `openadminos:*`), the `window.openAgents` preload bridge (-> `window.openAdminOS`), the `OpenAgentsApi` SDK type, the custom URL scheme (`openagents://` -> `openadminos://`), and every README/SPEC reference. The parent-brand attribution was dropped and the marketing domain switched from `openagents.sh` to `openadminos.com`. **Existing macOS installs will land on a fresh user-data-dir** (`~/Library/Application Support/OpenAdminOS` instead of `Open Agents`) — tenant connections, run history, and settings do not migrate. Code signing identity and auto-update channel need to be reconfigured under the new bundle ID.

### Added

- onboarding: in-app pre-consent scope review on the Connect tenant step itself. Single screen — "Connect a Microsoft 365 tenant" with the sign-in framing at top, the scope list inline, and a sticky footer that pins **Back** and **Approve and continue to Microsoft** so the CTA is always visible regardless of scroll position. (Earlier iteration of this work had a redundant intro card with a "Review permissions" button — that was friction; collapsed into one view.) The scope list comes from a new `getRequestedScopes()` IPC backed by `DEFAULT_SCOPE_METADATA` in `@openadminos/runtime`, so the renderer never drifts from what the main process actually requests at sign-in. Additional read scopes (Directory, Policy, AuditLog) are explicitly called out as incremental — requested only when an agent needs them. MSAL's reserved scopes (`openid`, `profile`, `offline_access`) are noted as a footnote so admins aren't surprised to see them on Microsoft's consent screen.
- onboarding: data-residency `TrustBanner` on the Pick LLM step. Green "Local-only mode active" variant when a local provider is selected; amber "Hosted provider selected" variant when a hosted provider is selected. Reusable component lives at `apps/desktop/src/components/TrustBanner.tsx`.
- ui: Settings → Tenants card now shows the detected Entra ID tier as a small uppercase chip next to the active state, matching the StatusStrip footer. Same probe data, surfaced where admins manage tenants.
- runtime: `probeSubscribedSkus` extracts both the Entra ID tier *and* a filtered list of admin-relevant SKUs from one `/subscribedSkus` call. The "relevant" set covers Microsoft 365 Business Basic / Standard / Premium, Microsoft 365 Apps, Office 365 E1/E3/E5, Microsoft 365 E3/E5/F1/F3, EMS E3/E5, and standalone Azure AD Premium P1/P2. Unknown SKUs are filtered out to keep the panel readable.
- runtime: `TenantRecord.relevantLicenses` persists `{ skuPartNumber, displayName, enabledUnits, consumedUnits }` for surfaced SKUs. Probe re-runs when this field is missing, so tenants connected before the licenses panel auto-populate on next launch.
- ui: Settings → Tenants gains a compact "Licenses" section below the tenant id when the tenant has relevant SKUs. Each row shows the friendly name and `consumed/enabled` seat counts (e.g. `Microsoft 365 E5  234/250`). Hidden when no relevant licenses are detected.
- runtime: `probeAllTenants()` fires a probe for every persisted tenant on app launch (called from main.ts after registry init). Silent on per-tenant failure; existing tenants from before this commit get their tier + license panel populated without a disconnect/reconnect dance.
- agents: declarative `requiresEntraTier` (`free` / `p1` / `p2`) on every manifest. Tags the six P1-requiring agents (`tenant-change-audit`, `sign-in-failure-explainer`, `risky-sign-in-triage`, `conditional-access-explainer`, `stale-guest-cleanup`) honestly so admins know upfront which agents need Azure AD Premium. Schema, runtime parser, registry index, and SDK contract are all aware of the field.
- runtime: `/subscribedSkus` probe runs in the background on tenant connection (and on a 24h re-probe cadence), classifies the tenant as `free` / `p1` / `p2` based on `AAD_PREMIUM` and `AAD_PREMIUM_P2` service plans, and persists the result on `TenantRecord.entraTier`. Probe failures are silent — `unknown` is treated as informational, not blocking.
- runtime: `tenantSatisfiesRequirement` compares a tenant's detected tier against an agent's required tier. Pre-flight in `startRun` blocks the run with a clear remediation message ("X requires Entra ID P1. Active tenant is on Entra ID Free. Microsoft 365 Business Premium includes Entra ID P1…") when the tenant tier is known and falls short. Unknown tiers proceed; the actual Graph call still surfaces the real failure if it doesn't work.
- ui: Agent Hub renders a `Requires Entra ID P1/P2` pill next to the read/write and category pills. Tone is `warning` when the active tenant doesn't satisfy the requirement (with a tooltip explaining the gap), muted otherwise. Status strip's tenant chip now shows the detected tier ("tenant: openadminos.com  Entra P2").
- registry: background refresh on a 6h interval and on window-focus (gated to >1h since the last attempt). Successful fetches push `openadminos:registry-refreshed` to the renderer which silently swaps in the new state — no toast, no popup, the "refreshed N ago" indicator in Agent Hub updates naturally. Background failures are silent; only manual refresh surfaces fetch errors.
- registry: dual-source resolution — the runtime prefers a live HTTP fetch from the configured registry source, falls back to the on-disk cache, and finally falls back to the bundled `agents/` directory shipped with the binary. This is the "works today, transparently switches to remote tomorrow" approach: during the private-repo phase the bundled fallback carries the app; the moment the repo flips public the remote source takes over without any code change. Agent Hub subtitle says `remote · refreshed <time>` when HTTP succeeded and `bundled · remote registry unreachable` when the fallback is in use.
- agents: seven new bundled agents covering investigator, advisor, and cleanup tiers — `tenant-change-audit`, `conditional-access-explainer`, `secure-score-prioritizer`, `sign-in-failure-explainer`, `risky-sign-in-triage`, `stale-guest-cleanup` (write, supersedes the deleted `disable-inactive-guests`), `dormant-app-registrations`.
- runtime: new `format: map` step kind that iterates a source array and runs an inner sub-pipeline per item. Enables per-item LLM reasoning (used by `risky-sign-in-triage`). Schema, parser, executor, scope/operation walkers, and QA `uses-llm` check are all map-aware.
- schemas: `graphSkill.settings` now formally allows `query` and `headers` objects, matching the TypeScript contract that has supported them since v0.1.
- qa-graph: well-known scope and endpoint allow-lists for entries the merill/msgraph FTS index doesn't surface (e.g. `Directory.Read.All`, `User.ReadWrite.All`, `GET /users`). Documented as tool-gap workarounds, not as license to use scopes loosely.
- docs: SPEC.md §5b — the bundled-agent philosophy (investigator / advisor / cleanup-with-judgment tiers; dashboards as a separate tier; the DSL pieces that make investigators expressible).
- live-run: Graph adapter now emits structured logs at every request boundary. Each call produces a `debug`-level `→ GET /users?$select=…` start line and an `info`-level `GET /users — 200 · 47 items · 1.2s` completion line; failures land at `warn` with the HTTP status and a truncated error body. The completion entry carries `metadata.graphCall` with method, path, parsed query, status, durationMs, attempts (only shown when >1), response bytes, item count, a top-level shape preview (e.g. `{ id, displayName, userPrincipalName, … }`), and a raw response sample capped at the first 3 items / 4 KB to bound SQLite growth on large tenants. The Logs tab grows an expandable details panel per row that renders the structured metadata — coloured HTTP-method chip, status chip, query table, shape block, syntax-highlighted JSON sample with a `showing N of M` indicator when truncated. Wiring: `ExecuteRunInput.graph: RunGraphApi` becomes `createGraph: (log) => RunGraphApi` so the runtime can pass its per-step logger into the adapter; the host's `state.ts#buildGraph` returns the factory and `createGraphAdapter` accepts a new optional `log` callback (silent by default — preserves existing test behaviour). Retries collapse into the single completion log via the `attempts` counter, so a 429-with-backoff cycle still produces one row, not three.

### Changed

- runtime: `DEFAULT_SCOPES` now bundles every read scope used by any currently-bundled read-only agent (9 scopes total: `DeviceManagementManagedDevices.Read.All`, `Organization.Read.All`, `Directory.Read.All`, `User.Read.All`, `Policy.Read.All`, `Application.Read.All`, `AuditLog.Read.All`, `IdentityRiskyUser.Read.All`, `SecurityEvents.Read.All`). Before this audit the only scope requested at sign-in was `DeviceManagementManagedDevices.Read.All`, which meant the Entra-tier probe immediately triggered a second MSAL consent prompt for `Organization.Read.All`, and every other read-only agent (Conditional access explainer, Dormant app registrations, Risky sign-in triage, Secure score prioritizer, Sign-in failure explainer, Tenant change audit, User license overview) opened its own consent tab the first time it ran. Now the admin sees one Microsoft consent screen at sign-in and every bundled read-only agent runs without further prompts. Write scopes are deliberately excluded — write-mode agents (Retire inactive devices, Stale guest cleanup) still trigger their own consent at install/run time per project policy. Scope set cross-checked against each agent's declared scopes and the actual `/endpoint` permission docs via the Microsoft Graph endpoint index.
- onboarding: step order reordered to `Welcome → Connect tenant → Pick LLM → First agent` (was `Welcome → Pick LLM → Connect tenant → First agent`) so admins see the tenant connection — the asset they came to manage — before being asked to install a multi-GB local LLM. Provider polling now pre-warms during the tenant step so Pick LLM lands with fresh Ollama status.
- onboarding: Pick LLM provider-not-ready card no longer renders in warning yellow on first contact. When the provider is `not-installed` and the user has not yet rechecked, the card renders in neutral instructional treatment ("Let's install Ollama"). Warning treatment kicks in only after a failed recheck or when the provider reports `error`.
- onboarding: copy tweaks aimed at the non-engineer manager persona — "CLI piggyback" pill replaced with per-provider login text ("Uses your Claude Code login" / "Uses your Codex login" / "Uses your Azure CLI login"); Welcome card "No API keys" body explains what the trade-off actually means; "Takes about a minute" caveat now acknowledges the Ollama download; Pick LLM subhead leads with the trust statement before the v0.2 roadmap caveat; Microsoft Graph Command Line Tools callout adds "uses Microsoft's public Graph CLI app registration, so nothing needs to be registered in your tenant."
- runtime: default Graph endpoint switched from `v1.0` to `beta`. v1.0 routinely returns timeouts on `/auditLogs/signIns` and `/auditLogs/directoryAudits` with `$filter+$orderby`; beta handles the same queries in seconds and exposes the richer payloads several investigator agents lean on (sign-in risk detail, conditional-access policy interactions, secure-score control profiles). Trade-off: beta endpoints can change without notice — acceptable for v0.2 preview; revisit when Microsoft promotes the relevant resources to v1.0 with full query parity.
- runtime: Graph request timeout raised from 30s to 60s. Real-tenant audit-log queries on large tenants legitimately take 30-45s; the 30s default was producing false "timed out" failures that masked normal Graph latency. Agents needing tighter bounds can pass `timeoutMs` explicitly to `createGraphAdapter`.
- docs: SPEC.md §2 Registry model rewritten — the OpenAdminOS repo is now the registry. App binary ships with zero agents and fetches `/agents/index.json` from the repo at runtime; cache-on-first-fetch lifecycle; per-agent `minAppVersion` gate; forkable registry source for enterprises.
- docs: tasks/todo.md gains a v0.2 block — repo-as-registry plumbing, DSL extensions (parallel/named graph steps, multi-input LLM, `map`), new synthetic fixtures, and the bundled agent overhaul (investigator / advisor / cleanup tiers; existing read-only agents demoted to a new "Dashboards" tier).

### Removed

### Fixed

- live-run: cancelling a run now stops the active step's spinner and the "streaming" reasoning indicator. Previously `cancelRun` only flipped `run.status` to `cancelled`, leaving the in-flight step at `status: "running"` and any `thinking.streaming: true` flag untouched — so the half-circle spinner kept rotating and the reasoning block still showed the "streaming" pulse next to a "Cancelled by user." header. Adds a `"cancelled"` value to `RunStepStatus`, transitions the active step + clears streaming flags in `cancelRun`, and renders the cancelled step with a muted dash icon and muted label.
- live-run: LLM-authored run summaries and reasoning blocks now render their markdown instead of displaying raw asterisk-bold markers, backticks, and bullet syntax. `RunResult.OutcomeCard` and `ActivityFeed.ThinkingBlock` route through the existing `MarkdownPreview` component (shared with the Teams-connector preview), which converts the constrained markdown subset (headings, lists, bold/italic, inline code, fenced code, links) into React nodes — pure JSX output, so no injection surface for LLM-emitted content. ThinkingBlock keeps the raw-text-plus-blinking-caret view while `thinking.streaming` is true (mid-stream partial markdown like `**Clus` would render half-formatted), then swaps to the markdown view the moment streaming ends. Activity feed list rows and the AgentDetail recent-runs list use a new `stripMarkdownToPlainText` helper that flattens the same syntax to a single line so truncated cells don't display literal markers.

### Security

## [0.1.6] - 2026-05-20

### Added

- **AppX tile assets — fix for Microsoft Store policy 10.1.1.11.** Custom `StoreLogo.png`, `Square44x44Logo.png`, `Square71x71Logo.png`, `Square150x150Logo.png`, `Square310x310Logo.png`, `Wide310x150Logo.png`, and `SplashScreen.png` rendered from the brand `icon-source.svg` and placed in `apps/desktop/build/`. `electron-builder` auto-discovers them by filename when building the AppX. Replaces the default Electron placeholder tiles that Microsoft rejected ("Tile icons must uniquely represent product"). Sources for the wide tile and splash live alongside as `*.source.svg` so they're regeneratable. `apps/desktop/build/README.md` documents the rasterize commands. `build.appx.showNameOnTiles` enabled in `apps/desktop/package.json` so the app name renders under the tile.
- runtime: agent-template graph steps can now call any Microsoft Graph GET endpoint via the new `RunGraphApi.request()` adapter — paths beyond `/deviceManagement/managedDevices` are dispatched generically with `$select`, `$filter`, etc.
- runtime: generic write action kind `graph-write` — agents can declare any POST/PATCH/PUT/DELETE Graph endpoint with a templated body. The runtime renders one Graph request per source item, lists them all in the `WritePlan`, and only fires after the user types the confirmation phrase. The legacy `retire-managed-device` kind keeps working unchanged.
- runtime: two new transforms — `group-by-field` and `sort-by` — so agents working over arbitrary Graph collections have somewhere to go besides device-age math. Transforms (filter-by-age, group-by-age, group-by-field, count-by-field, sort-by) now read nested dot-paths like `signInActivity.lastSignInDateTime`.
- electron: vendored merill/msgraph endpoint catalogue (~28k endpoints, ~6.4k with permission scopes). The drafter pre-searches it for candidate endpoints, and the install path validates that every declared graph or graph-write step targets a real endpoint.
- run UI: write actions now show the HTTP method as a coloured badge and expose an expandable "Request preview" with the rendered method/path/body so admins audit the exact Graph call before approving.
- agents: sample `user-license-overview` (read) and `disable-inactive-guests` (graph-write) agents demonstrating the new shapes end-to-end.

### Changed

- new-agent: review step now shows the drafted agent's name, description, mode, category, and version; modal subtitle switches to a review-mode caption; pipeline card opens by default so the proposed steps are visible without an extra click.
- new-agent: drafter prompt no longer hardcodes a single endpoint; candidate read endpoints relevant to the user's prompt are injected at draft time, and when the prompt looks write-y (disable / delete / revoke / …) candidate POST/PATCH/DELETE endpoints are injected alongside them. Drafter examples cover both read and `graph-write` shapes.
- runtime: `tokenProvider` for agent runs now goes through `tenantSession.acquireTokenForScopes(agent.scopes)`, so MSAL prompts for incremental consent the first time an installed agent needs new scopes.
- runtime: retry policy for `RunGraphApi.request()` splits on idempotency — POST/PATCH retry only on 429, while GET/PUT/DELETE keep the existing 429+5xx retry behaviour.

### Removed

### Fixed

### Security

## [0.1.5] - 2026-05-19

### Added

- **Privacy policy page at `/privacy`.** Honest, plain-language policy covering MSAL token storage in OS keychain, Microsoft Graph data handling on-device, local-vs-hosted LLM provider behavior, and the no-tenant-telemetry stance. Maintainer contact is `support@openadminos.com`. Linked from the homepage footer. Required for Microsoft Store submission and for the desktop app's eventual in-app About link.
- **Terms of use page at `/terms`.** One-page terms covering MIT-license as-is/no-warranty disclaimer, user responsibility for tenant authorization and write-agent diff approval, third-party services (Microsoft Graph + the user's LLM provider) being governed by their own terms, acceptable use, and a pointer back to the privacy policy. Linked from the homepage footer.
- **Sitemap and robots.txt for the marketing site.** New `web/src/app/sitemap.ts` and `web/src/app/robots.ts` using Next.js App Router metadata routes. Sitemap lists `/`, `/privacy`, and `/terms`; robots allows everything except `/api/` and points crawlers at the sitemap. Makes the legal pages discoverable to search engines and to Microsoft's Store-submission crawlers.
- **Microsoft Teams connector (first connector).** End-to-end implementation across the monorepo:
  - **`packages/connector-teams`** — new package implementing `TeamsConnectorCapabilities` (`listTeams`, `listChannels`, `postChannelMessage`, `postChatMessage`) against Microsoft Graph. Includes a small Markdown→Teams HTML renderer (bold, italic, code, links, headings, lists) so agent output renders correctly in Teams chat. Registers itself onto `ConnectorRegistry` via TypeScript declaration merging.
  - **Runtime wiring (`packages/runtime/src/connectors.ts`)** — static connector registry, preflight (build + healthcheck + dispose lifecycle), capability invocation wrapper that injects runtime-supplied idempotency keys, emits `ConnectorAuditEntry`, gates `notify`/`mutating`/`destructive` calls through a `confirmInvocation` callback, and maps typed `ConnectorError` failures to retry/reauth/reconfigure/fatal recovery actions. `ctx.connectors` is now injected into every `RunContext` when an agent declares connector requirements.
  - **MSAL `createTenantSession()`** with per-capability incremental consent — silent token acquisition first, interactive MSAL re-consent for any scope set the cache cannot satisfy. Wired into desktop runs via `buildGraph()` in `state.ts`.
  - **Connectors page** at `/connectors` (new sidebar entry between Agent Hub and Activity). Lists every registered connector with status pill (`connected` / `needs setup` / `needs consent` / `error` / `untested`), capability list with kind tags, declared Graph scopes, and a `Test connection` button that runs `healthCheck` against the active tenant.
  - **Preview-and-send confirmation modal** at AppShell level — fires whenever a `notify`+ capability is about to execute, shows the connector + capability + egress target + rendered body preview, with Cancel and Send buttons. Cross-process IPC bridge (`connector-confirm-bridge.ts`) correlates main-process capability calls with renderer-side modal responses.
  - **YAML pipeline support for `format: connector`** in `packages/runtime/src/agent-template.ts` — agents declare `descriptor.connectors[]` and use `format: connector` skills with `connector`, `capability`, `version`, and templated `args`. The runtime resolves the connector via `ctx.connectors`, maps kebab-case capability ids to camelCase methods, and invokes them through the capability wrapper so confirmation and audit fire automatically.
  - **Sample agent `tenant-health-report`** — reads Intune managed devices, tallies by compliance state, LLM-summarizes, and posts the summary to a Teams channel. First end-to-end exercise of the connector abstraction. User configures `teamId` + `channelId` per install; the post fires only after the preview-and-send modal is approved.
- **Connector abstraction (contract).** New `### Connector abstraction` section in `docs/SPEC.md` §2 plus the type contract in `packages/agent-sdk/src/index.ts`. Production-grade design: SemVer-major-versioned capabilities addressed as `id@major`, four capability kinds (`read` / `notify` / `mutating` / `destructive`) mapped to four confirmation tiers (none / preview-and-send / diff / typed-phrase), three auth-source classes (`graph-delegated` / `graph-application` / `external`), typed error contract with `recovery` semantics (`retry` / `reauth` / `reconfigure` / `fatal`), runtime-supplied idempotency keys, per-package plugin distribution, and type-safe `ctx.connectors` via TypeScript declaration merging on the empty `ConnectorRegistry` interface. `AgentContract.connectors?` and `RunContext.connectors?` extended (optional, runtime-injection lands in v0.2). The Teams connector ships first as the abstraction validator (graph-delegated, delegated permissions, scopes folded into MSAL consent, `post-*-message` as `kind: notify` with preview-and-send confirmation). ServiceNow positioned as the canonical second connector under "Designed before launch" (`external` auth, instance URL, keychain credentials). Added to §5 as a v1.0 blocker; v0.1 defers connector runtime to v0.2 alongside real MSAL.
- **Branded macOS DMG install window.** The `.dmg` now opens to a dark, on-brand OpenAdminOS install screen (660×440) with the app icon on the left, an arrow, and an `Applications` shortcut on the right. Background source is `apps/desktop/build/dmg-background.svg`, rendered to a Retina TIFF at `apps/desktop/build/background.tiff`. See `apps/desktop/build/README.md` for regeneration steps.
- **Onboarding routing gate.** With zero tenants connected, every URL redirects to `/onboarding`. Disconnecting the last tenant routes the user back to onboarding. Adding tenant #2+ uses the existing `Connect tenant` buttons in TenantSwitcher / Settings → Tenants and triggers MSAL sign-in directly — no onboarding rerun.

### Changed

- **Graph writes are real by default once a tenant is connected.** Removed the `Enable real Graph writes` toggle from Settings → Privacy and dropped the corresponding global flag from state, IPC, and the status strip. The typed-phrase diff confirmation on every write run is the only authorization gate — there is no separate global switch to forget.
- **Onboarding step 3 is mandatory.** Removed the global Skip button and the "Continue without a tenant" card. Users connect a Microsoft 365 tenant before reaching the app shell.
- **Settings → Tenants copy** rewritten to reflect the new gate: no more mentions of a fallback synthetic fixture.

### Removed

- `setRealWritesEnabled` IPC + preload binding + AppState field. State files written by older 0.1.x releases are read transparently (the field is ignored).
- Real-writes cell from the bottom status strip — it duplicated information already conveyed by the tenant cell.
- **Synthetic mode entirely.** `packages/runtime/src/graph-fixtures.ts` deleted; `createSyntheticGraph` no longer exported. `RunDataSource` type and `RunRecord.dataSource` field dropped from `@openadminos/agent-sdk`. The Activity "Synthetic" filter chip, AgentsHome "No tenant — synthetic mode" banner, ResultPanel synthetic callout, and RunResult dataSource pill are all gone. Runs without a connected tenant now fail preflight with a clear error instead of falling back to a fixture.
- Sidebar bottom-left user/provider card. Settings is now a regular nav row alongside Agents / Agent Hub / Activity. Provider info already lives in the bottom status strip.

### Fixed

### Security

## [0.1.4] - 2026-05-17

A cleanup pass on the v0.1 surface plus a structural redesign of the run-detail page. Stays on 0.1.x; no schema or storage migrations.

### Added

**Agent contract — LLM is load-bearing.** Every agent template must include at least one `format: llm` step. The runtime hard-fails any LLM step reached without a connected provider (replacing the previous silent skip on `when: ctx.llm.available`). `npm run qa` enforces it via a new `uses-llm` check. NL2Agent's prompt and validators reject drafts that omit the step. Bundled agents (`find-inactive-devices`, `compliance-overview`, `os-update-posture`) now use the LLM step's output as the `result.summary` headline rather than burying it in `data.llmSummary`. The write agent `retire-inactive-devices` gained an `explain_plan` LLM step whose output becomes the diff-confirmation headline.

**Run detail page redesign.**
- **Live telemetry strip** under the header: Elapsed (live-ticking) · Steps N/M · Tokens (prompt · out) · Model · Cost.
- **Token telemetry**: Ollama provider parses `prompt_eval_count` + `eval_count`; runtime accumulates into `RunRecord.tokens`.
- **Pipeline timeline** replaces the flat step list — connected status indicators (done ✓ / running spinner / pending hollow / failed ✕) with per-step durations.
- **Tabbed activity feed**: Pipeline · Logs · Reasoning. Logs tab has per-level filter chips (debug/info/warn/error) and per-line hover-to-copy. Reasoning tab isolates LLM thinking blocks.
- **Structured Result panel**: arrays-of-records render as tables; bucketed maps render as grouped sections; JSON-stringified values inside the data block are re-hydrated; `Show raw` toggle exposes the original JSON.
- **Failure remediation card** on failed runs with pattern-matched suggestions for common errors.
- **Outcome card** replaces the duplicated summary card; data-residency moved into a side panel.

**Per-run controls.**
- **Run cancellation** via `cancelRun(runId)` IPC + danger-styled Cancel button + `Esc` shortcut. Marks the run terminal and drops subsequent progress; background work finishes silently.
- **Per-run provider + model override** via a new `RunWithMenu` split button on Agent Detail. `StartRunOptions` gained `providerId` and `model` fields. Run-again preserves the original run's tenant, provider, and model.
- **"Run in background"** button during live runs navigates back to Agents; runs continue in flight.
- **Run-start preflight** throws synchronously ("Ollama isn't reachable. Start it with `ollama serve`, then try again.") instead of queueing a run that fails seconds later.

**Per-install agent management.**
- **Uninstall** via `uninstallAgent(slug)` IPC + UI on Agent Detail. User-authored agents are deleted from disk; bundled agents stay on disk and remain installable from the Hub.
- **Schedules**: `AgentSchedule { enabled, intervalSeconds }` per installed agent. A 60-second main-process tick fires any due schedule (skipping in-flight runs). New `AgentScheduleCard` with preset intervals (15m / 1h / 4h / 12h / 24h) and a live countdown. Schedules only fire while the app is open — surfaced honestly in the card copy.
- **Per-provider active model**: Settings → LLM Providers now renders each installed model as a clickable chip. Persists as `activeModelByProviderId` in state.
- **Resolution priority** for the model stamped on each run: explicit `options.model` → agent manifest `preferredModel` (if pulled) → user's `activeModelByProviderId` → provider's first reported model. Each layer validates the model is actually installed.

**App shell + system integration.**
- **Bottom status strip** across every page: active tenant · provider · model · real-writes · in-flight count.
- **Sidebar in-flight badge** on the Activity nav item with pulsing warning tone.
- **Auto-update in-app banner**: main-process updater broadcasts state to the renderer; `UpdateBanner` shows "downloading" / "ready" with a `Restart now` button alongside the existing native dialog.
- **OS-level run-completion notifications** when the app isn't focused; clicking focuses the app and navigates to the run.
- **Native application menu** with View accelerators (`Cmd+1`/`2`/`3`/`,`) and Help shortcuts (Open app data folder, Open logs folder, OpenAdminOS on GitHub).
- **Inline tenant disconnect** on each row of the sidebar TenantSwitcher (hover-revealed ×).
- **Synthetic-mode banner** on Agents home when no tenant is connected.

**Run reporting.**
- **Copy report** (plaintext clipboard), **Export** (save-dialog JSON), **Share** menu (deep link + Export as Markdown). New IPC bridge for `openExternal` and `saveTextFile`.
- **Copy run ID** affordance in the run detail subtitle.
- **Activity text search** alongside the filter chips.
- **Manifest preview Pipeline card** is collapsible by default to shorten the Agent Detail body.
- **Hub filter empty state** with a `Clear filters` action when search/category returns no agents.

### Changed
- ShareMenu accepts per-action callbacks; renders only items with handlers supplied. Slack item removed.
- TenantDriftNote elevated from info to warning tone with a `Re-run against current tenant` CTA.
- Settings → General + Privacy rewritten with honest copy: real toggleable rows where wired, "Not collected" / "Coming in 0.2" labels everywhere else (no more fake "Off" badges).
- Settings → LLM Providers `Install guide` button opens vendor docs via `openExternal`.
- NL2Agent provider-unavailable warning includes provider-specific guidance (`ollama serve` for Ollama, "open Settings → LLM Providers" for hosted).
- Status pills render the new `cancelled` RunStatus with neutral tone.
- Cancelled runs stamp `summary: "Cancelled by user."` (was: stale "is running" text).
- Activity provider column shows the display name (e.g. `Ollama`), not the canonical id.
- All UI references to the GitHub repo corrected from `OpenAdminOS/OpenAdminOS` to `OpenAdminOS/OpenAdminOS`.
- Agent Hub eyebrow "Community" → "Built-in"; fake `INSTALLS` / `Top installed in May` / hardcoded "From the author" quote removed in favour of real Category + Graph scopes panels.
- Onboarding "Use synthetic data" card retitled "Continue without a tenant" with honest empty-inventory copy.
- README + CONTRIBUTING updated to reflect the LLM-required contract and the actual shipped surface.

### Removed
- The 22-record `contoso.com` synthetic device fixture. Synthetic mode now returns zero devices; agents run end-to-end but produce empty results.
- Placeholder `$0.00 / External` cost cells from the agents-home stats strip, Activity table, Run Result summary, and Agent Detail right rail.
- "Time saved" tile from the agents-home stats strip.
- Stubbed Slack share entry, stubbed `Configure` button on provider rows, stubbed `INSTALLS` stat, the hardcoded "Top installed in May" pill, and the fake author quote on the featured Hub card.
- Agent rating field across the SDK, runtime, and UI (`rating?` removed from `RegistryAgentSummary`).
- Dead export `getSyntheticInventorySize()` from `@openadminos/runtime/graph-fixtures.ts`.

### Fixed
- Ollama reasoning models (qwen3, deepseek-r1, gpt-oss) were producing empty `message.content` because they burned the full token budget inside `<think>` blocks. The Ollama provider now sends `think: false` to disable reasoning mode, captures `message.thinking` separately, and falls back to reasoning content if `message.content` is empty. `cleanLlmText` strips `<think>…</think>` from the visible answer.
- Default tenant scope in Settings → General now reflects the actual connected tenant instead of always showing "Not connected".
- Agent Detail Model card now resolves the *actual* model that will be used at run time (mirroring the runtime's resolution chain) instead of statically showing the manifest's `preferredModel` regardless of whether it's installed.
- Steps telemetry caption no longer reads `4/4 · of 4`; reports state ("all complete" / "in progress" / "N failed" / "incomplete" / "no steps yet").
- Agents home subtitle no longer duplicates the tenant name across the trust pill and a trailing span.

### Security

## [0.1.3] - 2026-05-16

### Added

### Changed

### Removed

### Fixed
- macOS DMG launched to a blank window because Vite's default `base: "/"` emitted absolute asset URLs (`<script src="/assets/…">`) that Electron's `file://` loader resolved to the filesystem root instead of the html file's directory. Neither JS nor CSS loaded, React never mounted, and the user saw only the BrowserWindow's configured background color. Fixed by setting `base: "./"` in `apps/desktop/vite.config.ts`, which emits `./assets/…` paths that resolve correctly under `file://`. Dev mode (`npm run dev`) was unaffected because Vite serves over `http` where absolute paths resolve to the dev server root. Bug was latent in v0.1.0 / v0.1.1 / v0.1.2; only surfaced now that someone actually launched the signed DMG.

### Security

## [0.1.2] - 2026-05-16

### Added
- Release-prep automation: a `workflow_dispatch` workflow that bumps every workspace `package.json`, rolls `CHANGELOG.md` so `[Unreleased]` becomes a dated `[X.Y.Z]` section, regenerates `package-lock.json`, and opens a release PR via `gh`. Pairs with a new `auto-tag` workflow that pushes the matching `vX.Y.Z` tag when a `release: v*` commit lands on `main`, which then triggers `release.yml` for the signed build. Net result: cutting a release is two clicks (Run workflow → review PR → merge). Defaults to `patch` bump so the v0.1.x line discipline is preserved by default.
- All four GitHub Actions workflows now opt into Node 24 via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, ahead of GitHub's June 2026 forced cutover. Silences the runner's Node-20-EOL warnings.

### Changed

### Removed

### Fixed
- macOS Keychain prompt on first run no longer references the raw npm package id (`@openadminos/desktop`). `app.setName("OpenAdminOS")` is now pinned at the top of `main.ts`, before any `safeStorage` access, so dev and signed builds both produce a single user-facing `OpenAdminOS Safe Storage` Keychain entry. Existing dev-install users may need to delete a stale `@openadminos/desktop Safe Storage` entry once (`security delete-generic-password -l "@openadminos/desktop Safe Storage"`); fresh installs see no prompt at all.

### Security

## [0.1.1] - 2026-05-16

Signed-binaries follow-up to v0.1.0. The platform is unchanged; this release adds the distribution pipeline so we can ship trustable installers from CI on every tag push. End-to-end verified by a `workflow_dispatch` dry run on `main` — Windows MSIX built clean in 1m45s, macOS DMG signed + notarized in 3m23s (Apple's notarytool round-trip under 2 min on the day).

### Added
- Release pipeline. Tag-push of `v*.*.*` (or workflow_dispatch) cuts a two-channel build via `.github/workflows/release.yml`: an unsigned Windows MSIX for Microsoft Store submission (Store re-signs after upload, giving the binary Microsoft's SmartScreen reputation from day one) and a notarized + signed macOS DMG/ZIP for direct download via GitHub Releases (auto-updated by electron-updater). Build artifacts land on a draft release for review before publishing. macOS notarization uses the modern App Store Connect API key flow (`APPLE_API_KEY` / `_KEY_ID` / `_ISSUER`) rather than the legacy Apple-ID + app-specific-password path. Per-platform secrets list and the full runbook live in `docs/RELEASING.md`.
- `electron-updater` wired in `apps/desktop/electron/updates.ts`: 15-second startup delay, 4-hour poll, native dialog when an update is downloaded ("Restart now" / "Later"). Auto-skipped in dev and on Windows when the running build is a Microsoft Store-installed AppX (so the Store and electron-updater never race over the same install).

### Changed
- `apps/desktop/package.json` `build` block: Windows target switched from NSIS to AppX/MSIX with the Partner Center identity (`OpenAdminOS.OpenAdminOS.OpenAdminOS`, `CN=E5B1EEE1-…`, publisher `OpenAdminOS`); macOS target tightened to Apple Silicon DMG + ZIP with `hardenedRuntime: true`; GitHub publish provider added so electron-updater knows which release feed to read.

### Removed

### Fixed

### Security

## [0.1.0] - 2026-05-16

First public release. Public preview foundation. Tenant-data-local-by-default desktop platform for Microsoft 365 admins. Four bundled reference agents, two authoring paths (YAML by hand or NL2Agent draft), full transparency UI over both, gated real Graph writes, static schema + Graph QA gate.

Versioned packages: root `0.1.0`, `@openadminos/agent-sdk@0.1.0`, `@openadminos/runtime@0.1.0`, `@openadminos/qa-graph@0.1.0`, `@openadminos/desktop@0.1.0`.

### Added
- `agents/os-update-posture/` — third canonical Agent Template in the `updates` category. Reads `managedDevices` once and tallies the fleet twice with `count-by-field` (once on `operatingSystem`, once on `osVersion`) so end-of-life builds (Windows 10.21H2, 10.22H2) surface distinctly from current builds (11.23H2). Optional LLM step calls out the biggest update risk. YAML-only, no companion TypeScript. Smoke-verified against the synthetic fixture: 13 Windows / 5 macOS / 3 iOS / 1 Android, 12 distinct OS builds; 6 of 13 Windows devices on Windows 10 lines. Doubles as the reference shape NL2Agent should be able to draft from a plain-English prompt.
- NL2Agent renderer: the New agent button on the hub used to be dead chrome — it now opens a two-pane flow. Pane one is a prompt textarea with a quick capability cheat-sheet and a clear callout when the LLM provider isn't reachable. Pane two is a full Manifest Preview of the generated YAML (the same component used on AgentDetail) plus inline validation errors when the LLM produced a schema-incompliant draft. Save & install wires through to `saveAgentDraft` + `installAgent` and routes the user straight to the new agent's detail page so they can run it.
- NL2Agent backend: `draftAgentManifest(prompt)` + `saveAgentDraft(yaml)` IPC + runtime support for a second, user-writable agents root under `userData/agents/`. `draftAgentManifest` sends a structured prompt (system message + JSON Schema reference + worked example) to the active LLM provider, strips any markdown fences, parses + schema-validates the YAML, and returns either the parsed manifest or a list of validation errors. `saveAgentDraft` writes `manifest.yaml` + a projected `manifest.json` under `userData/agents/<slug>/` and refuses to shadow a bundled slug. The runtime's `listAllRegistryAgents(userRoot?)` merges both roots into a single de-duplicated registry; user-authored agents stamp their absolute path on `registryPath` so the dir resolver picks them up without colliding with the bundled tree.
- `agents/compliance-overview/` — the second canonical Agent Template. Read-mode agent in the `compliance` category that counts managed devices by `complianceState` (compliant / noncompliant / unknown) and optionally polishes the result with a local LLM summary. Ships as YAML only (no companion TypeScript), proving the YAML-only authoring path works end-to-end. Adds a new `count-by-field` transform kind to the runtime (one function, accepts an optional pinned bucket list so the result shape stays stable across tenants). Schema enum updated to allow it; new agent validates against `schemas/agent-template.schema.json` on first try. Smoke-verified against the synthetic graph fixture: 7 of 22 noncompliant, 3 unknown — summary string renders correctly.
- JSON Schema for Agent Template manifests at `schemas/agent-template.schema.json`. Mirrors the SDK types and is the authoritative shape for every `agents/<slug>/manifest.yaml`. The YAML Language Server directive at the top of each manifest gives editors live autocomplete and validation as authors type. `npm run qa` now adds a schema-validation pass over every YAML manifest (alongside the existing Graph QA + fixture checks); malformed manifests fail CI with a structured diff against the schema. Schema authoring guidance lives in `schemas/README.md`.
- Install-time settings for Agent Templates. AgentDetail's "Configure" button now opens a modal that renders one input per declared `definition.settings[]` entry (integer / string / boolean). Values are validated client-side and re-validated on the host (type-coercion plus unknown-key dropping) before persisting onto `AgentSummary.settings`. At run time the interpreter merges the persisted overrides on top of YAML defaults via `ctx.settings`. Manifest Preview's "Configurable settings" card surfaces both `default:` and `current:` chips for transparency. Smoke-verified end-to-end: overriding retire-inactive-devices' `retireDays` from 180 → 90 grows the plan from 4 to 8 devices and re-renders the confirmation phrase as `RETIRE 8 DEVICES`.
- `write` step format in Agent Templates. Write-mode agents now declare a `write` skill with `kind`, `source`, `confirmationPhrase`, and `actionTemplate` (rendered once per source item). The interpreter pauses on plan, builds a `WritePlan`, and dispatches each approved action to a registered handler (`retire-managed-device` for v0.1). `retire-inactive-devices` migrated from TypeScript to `manifest.yaml`; behaviour against synthetic Graph fixtures is identical (4 candidates, phrase `RETIRE 4 DEVICES`, per-device retire calls on apply). Manifest preview UI renders the write step with its kind, source, confirmation phrase, action template, and required scopes — every promise of transparency now applies uniformly across read and write agents.
- Initial project handoff: SPEC.md, CLAUDE.md, design mockups, contributor docs.
- v0.1 public-preview foundation scope locked in SPEC.md §5a with phased plan in `tasks/todo.md`.
- Onboarding now installs a built-in registry agent through Electron IPC and routes into a live `/runs/:id`.
- `/runs/:id` shows a streaming/live state (pulsing indicator, running-step pulse, live elapsed) while a run is queued or running.
- Agent execution contract in `@openadminos/agent-sdk`: `RunContext`, `AgentModule`, `ManagedDeviceRecord`, `RunGraphApi`. Each built-in agent now lives as a TS workspace package under `agents/<slug>/`.
- Synthetic Graph fixture and `executeRun` driver in `@openadminos/runtime`. Agents emit their own steps, logs, and result; runtime streams every snapshot via `onProgress` and captures throws as `failed`.
- `agents/find-inactive-devices/` is the first real agent: computes inactivity buckets from the synthetic fixture instead of returning a hardcoded result.
- Two-phase write agent contract (`plan` + `apply`) and a real diff confirmation flow: `RunStatus` adds `awaiting-confirmation` / `rejected`, `RunRecord` carries the persisted `WritePlan`, IPC adds `confirmRun(runId, phrase)` / `rejectRun(runId)`. `/runs/:id` renders the diff confirmation inline; the standalone DiffConfirm route is gone.
- `agents/retire-inactive-devices/` is the first write agent: reads the synthetic Graph, plans one destructive `retire-device` action per device inactive ≥180 days, and applies after typed phrase confirmation.
- Static Graph QA gate (`npm run qa`). Each agent manifest now declares a `graphOperations` contract; `@openadminos/qa-graph` validates declared scopes, endpoint existence, scope coverage, select fields, and curated sample backing against the local Microsoft Graph index — offline, no auth. Synthetic `ManagedDeviceRecord` fixture is cross-checked against the real `managedDevice` schema.
- Real local LLM streaming via `ctx.llm`. New SDK types (`LlmOptions`, `LlmCompletion`, `LlmStreamChunk`, `RunLlmApi`, `RunStepThinking`) plus an Ollama provider in `@openadminos/runtime` that streams chunks from `http://127.0.0.1:11434`. `find-inactive-devices` gets an optional summary-polish step gated on `ctx.llm.available`; the deterministic path still works when Ollama is offline. `/runs/:id` shows a streaming "Reasoning" panel under each step (model name, pulsing dot, blinking cursor).
- CI workflow (`.github/workflows/ci.yml`) enforcing `typecheck` + `qa` + `build` on push to `main` and all pull requests. `scripts/setup-qa.sh` clones the public `merill/msgraph` skill with sparse checkout so CI runners get the QA index without a local Claude install.
- MSAL interactive authorization-code + PKCE flow (read path) via `@azure/msal-node` `acquireTokenInteractive` against the public Microsoft Graph CLI client id. Opens the system browser to login.microsoftonline.com and uses a loopback redirect (registered against the CLI client) so the user only ever signs in on the real Microsoft login page in their own browser. Token cache encrypted via Electron `safeStorage` and persisted to `tokens.bin`. New Settings → Tenants surface (connect / set-active / disconnect) and a `RunGraphApi` adapter against `https://graph.microsoft.com/v1.0` with `@odata.nextLink` paging and 429 / 5xx retry. Runs are stamped with `dataSource: "graph" | "synthetic"`; the synthetic fixture remains the default when no tenant is connected. Write-path remains synthetic — `POST /retire` calls deferred to a future slice.

### Changed
- Desktop framework: Tauri → Electron. Reasoning recorded in SPEC.md §2 ("Why Electron, not Tauri"). Trade: larger binaries (~80–150MB) and higher idle memory accepted in exchange for developer velocity, contributor accessibility, UI fidelity, and direct support for the chosen runtime model.
- Renderer: Next.js 14 App Router → Vite + React + React Router for the Electron renderer. Next.js retained only for `apps/marketing/`.
- Distribution surface narrowed: dropped the `npx openadminos` CLI. Desktop app is the only end-user surface.

### Removed
- `apps/cli/` from the planned monorepo layout.
- Mock `LiveRunModal` surface and the `hubAgents` / `data/runs.ts` / `data/providers.ts` / `data/stats.ts` renderer fixtures, replaced by real registry-backed install-and-run.
- Hardcoded simulated run lifecycle (`createSimulatedRun` / `getSimulatedRunRunning` / `getSimulatedRunCompletion`) in `@openadminos/runtime`. Runs now come from the agent's own code.
- Standalone `DiffConfirm` page, `data/results.ts` mock, and the `/agents/:slug/confirm` route. Diff confirmation now happens in-place on `/runs/:id` from the persisted plan.

### Fixed

### Security
