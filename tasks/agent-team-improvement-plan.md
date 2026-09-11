# Agent Team: significant improvement plan

Status: approved for implementation on 2026-09-11. Implementation and verification tracked below.
Reviewed 2026-09-11 against PR #81, commit `b1213ac696bcc9bececa6ff9cd60557df1e1b168`.

## Assessment

The strongest direction is persistent ownership of useful work: an admin assigns a responsibility, the team investigates relevant changes, and the admin returns to decisions with evidence. The office makes that activity recognizable. The next substantial improvement should complete this cycle while making the characters inhabit the room convincingly.

The current feature has real persistence, scheduling, execution, approvals, cancellation, and evidence links. Its limits are specific: coordination is a fixed sequence, starting roles are descriptive presets, results are not passed between agents, and the briefing is a recent-run feed. Existing green CI does not cover all of the behaviors below.

## Confirmed findings

| Finding | Evidence and consequence |
| --- | --- |
| Scheduled comparisons can cross tenant boundaries | `runs.ts:923` finds a previous completed scheduled run by agent slug without tenant filtering. A local reproduction supplied tenant B's result as the only previous result for tenant A; A was marked `unchanged` rather than `new`. This is a comparison correctness issue, not evidence that a Graph request ran in the wrong tenant. It can affect change-only notification decisions. |
| Approval blocks unrelated Office work | `office.ts:397` treats any active Office child, including one awaiting confirmation, as occupying the global slot. A reproduction confirmed a second persona started no child while the first waited for approval. |
| A queued assignment can expire without running | `office.ts:300` starts the deadline when the mission is created; `office.ts:375` expires it even with no child runs. The reproduction gave the second persona five minutes, advanced six minutes, and observed a failed mission with zero children. Approval waiting consumes this same deadline. |
| Provider consent invalidation is too broad | `state.ts:1365` hashes the complete provider configuration collection; `office.ts:131` incorporates that digest. Inspection shows an unrelated provider edit can invalidate a persona's trust key. This finding was established by code inspection, not an end-to-end provider-edit test. |
| A role name does not add a capability | `Office.tsx:618` changes name and responsibility only. `office.ts:405` passes scope and correlation into the next installed workflow, without a goal, task input, or previous result. |
| The office cannot communicate much about the work | `OfficeScene.tsx:443` maps coarse labels to positions; all idle motion uses one 18-second phase at line 537. CSS translates characters directly between coordinates. There are no furniture-aware paths, directional poses, or depth ordering between the SVG furniture and HTML characters. |
| Useful outcomes are visually secondary | The reviewed 1440px screenshot puts the Team briefing below the room and long assignment panel. `Office.tsx:408` renders only the latest 12 missions, without a finding inbox or review lifecycle. |

Reproductions used a temporary synthetic harness against the actual OfficeService and scheduled-comparison method. They did not alter production code or tenant data. The reviewed screenshot is `docs/screenshots/office/office-1440.png`.

## Prioritized improvements

Size is relative implementation complexity, not a delivery estimate. S: contained; M: several related surfaces; L: runtime contracts and multiple surfaces.

### 1. Correct tenant-scoped comparison and notification baselines — P0, M

Compare against the same tenant and assessment definition. Give differing persona configurations separate assessment identities. Version the comparison schema, normalize unordered evidence, and avoid using fluctuating prose or timestamps as the primary change signal.

Acceptance: tenant A's first run remains new even if tenant B has identical output; distinct configurations do not share a baseline; reordered equivalent rows remain unchanged; a meaningful entity change produces one new finding. Add a regression through persisted run completion and change-only delivery, beyond the isolated method reproduction.

### 2. Separate execution, queueing, and human review — P0, L

Introduce explicit queued, executing, awaiting review, completed, failed, and cancelled mission states. Track queue time, actual execution budget, and approval age independently. Suspend an assignment awaiting a human while allowing unrelated permitted work to advance. Start with one compute slot that can be released during human review; add bounded read concurrency only after resource and write-conflict rules are established.

Acceptance: a persona cannot exhaust its execution allowance before its first task starts; one pending approval does not freeze other independent read assignments; dependent tasks still wait; stale proposals are revalidated before apply; restart and stop remain safe and do not duplicate work. Approval expiry must be a visible policy with a recovery action.

### 3. Make readiness, consent changes, and recovery precise — P0, M

Hash only the assigned provider configuration and the workflows relevant to that assignment. Show exactly what changed and why review is required. Distinguish disconnected tenant, unavailable local model, missing workflow, approval needed, and transient failure. Permit harmless persona edits while execution prerequisites are unavailable. Use bounded backoff for classified retryable reads; do not blindly replay writes or connector sends.

Acceptance: editing provider B leaves provider A's assignments intact; changing the assigned destination requires review; an offline model has a specific recovery action; exhausted retries remain visible and paused.

### 4. Provide starter roles that do useful work — P1, M

A starting role should select a supported workflow, required capabilities, expected output, and a clear schedule proposal. Missing capabilities should be explained before activation. Let the admin configure a concrete responsibility such as which assessment to watch and when to notify. Keep personality and avatar settings separate from execution instructions.

Acceptance: creating the first useful persona does not require understanding eight agent manifests. A template can preview its work order and complete a first read-only assessment. Research and Script Bot names must not imply tools that are absent.

### 5. Give the team structured findings and memory — P1, L

Add a tenant-scoped finding record with assessment identity, affected entities, severity, first/last seen, evidence references, source freshness, current owner, and review state. Support acknowledge, snooze, resolve, and reopen. Store approved standing instructions separately from retrieved logs and model-generated suggestions. Reuse workspace evidence and run references rather than duplicating raw results into another memory store.

Acceptance: an unchanged issue is not announced on every run; a snoozed issue resurfaces only under the chosen policy; a recurrence reopens the finding with its history; disconnected-tenant cleanup covers new records; untrusted source text cannot modify standing instructions.

### 6. Make proactive execution respond to meaningful changes — P1, L

Support conditions such as a new finding, a changed finding, or a threshold crossed after an existing collection or assessment completes. Keep periodic checks as a supported trigger. Add debounce, cooldown, deduplication, and freshness checks. Start from local assessment events; broader remote subscriptions require separate endpoint and permission validation.

Acceptance: one changed assessment creates one investigation; repeated identical events create no duplicate assignments; stale or incomplete evidence produces an explicit coverage warning rather than a clean result. Dependencies: 1, 2, and 5.

### 7. Add explicit handoffs between specialists — P1, L

Define validated task inputs and output artifacts. A handoff carries tenant, finding IDs, bounded evidence references, the question to answer, and permitted next actions. The receiver reads the relevant evidence through the host. A durable handoff record connects parent mission and child task.

Acceptance: a second specialist can investigate the first specialist's actual finding without re-reading the whole tenant; mismatched tenant evidence is rejected; oversized inputs are bounded; restart resumes without duplicating completed children. No automatic sharing with another provider without the applicable reviewed data-flow policy. Dependencies: 2 and 5.

### 8. Give Chief of Staff bounded planning capability — P1, L

Allow it to select from installed, explicitly assigned capabilities; propose a task plan; delegate; inspect outcomes; and stop when evidence is sufficient. Start with deterministic routing for known findings. Add model-assisted plan selection behind validated schemas and fixed limits for tasks, depth, iterations, time, and cost where measurable. Show the reason for each delegation and what remains uncertain.

Acceptance: irrelevant specialists are skipped; unknown capabilities and out-of-scope actions are rejected; invalid plans fail visibly; local-model failure has a defined fallback; every task has an accountable parent; write approval remains mandatory. Dependency: 7. This is a major capability project, not a small adjustment to the existing loop.

### 9. Let admins question a persona about its work — P1, L

Add a conversation tied to the selected persona and investigation, with evidence and current scope visible. Support questions such as “Why did you flag this?” and “What changed since the last check?” Reuse the existing bounded chat investigation path where its contracts fit. Suggestions to change a schedule or responsibility require explicit saved configuration changes.

Acceptance: answers link to actual evidence, disclose freshness and gaps, and preserve the persona's tenant/provider scope when the app's active tenant changes. A conversation cannot silently rewrite standing instructions. Dependencies: 5 and 7.

### 10. Put decisions and a daily briefing above the fold — P1, M

Create an action inbox with separate views for approvals, new findings, and operational failures. Summarize what changed, why it matters, what was checked, what was skipped, and what needs a decision. Make every card open its supporting evidence or existing approval screen. Add history search and filters beyond the latest 12 assignments. Keep the office available as a complementary overview.

Acceptance: an admin can find the most urgent pending decision without scrolling through the room or run logs; resolving it updates the inbox and persona indicator; no-change work is compact; scheduled-but-not-run and checked-with-no-issues are visibly different. Dependency: 5 for finding actions; approval/error aggregation can ship earlier.

### 11. Make schedules and resource use operationally clear — P1, M–L

Add local-time daily/weekly schedules, timezone and daylight-saving behavior, quiet hours, next/last execution, and an explicit missed-run policy after sleep. Show provider readiness, queue position, last successful check, and coverage age. Display execution time, tool-call usage, and cost only where the provider supplies sufficient data; otherwise say unavailable. Bound local-model concurrency according to available capacity.

Acceptance: wake-up does not produce a burst of duplicate work; an admin can distinguish an asleep computer from a healthy completed check; the UI explains schedule drift and missed checks; resource limits do not silently discard jobs. Dependency: 2.

### 12. Make characters inhabit the furniture — P2, M–L

Use named navigation anchors and paths around furniture, with separate back-wall, furniture-back, character, and furniture-front layers. Add directional walking, turn, sit, type, stand, and controller poses. Give idle personas independent timing instead of moving the whole group on a shared phase. Preserve recognizable robot and animal identities and original assets.

Acceptance: characters walk around desks, sit into chairs and sofas, and disappear behind foreground furniture correctly; task changes interrupt walking; no overlapping seat reservations; selection works during motion; reduced motion remains complete. Prototype within the current renderer first; choose a rendering dependency only if measured complexity or performance justifies it.

### 13. Make office activity explain real events — P2, M

Show short event-driven speech bubbles such as reading evidence, investigating a finding, waiting for approval, or assignment complete. Represent a real handoff with a brief interaction near a shared desk or meeting spot. Use subdued idle behavior and a clearer selected persona. Avoid fabricated thought narration, progress percentages, or meetings without corresponding tasks.

Acceptance: every work-related bubble or interaction maps to a real event with a timestamp and source link; repeats are limited; idle games never imply background investigation. Dependency: 7 for handoff scenes.

### 14. Improve office focus and navigation at larger team sizes — P2, M

Offer an expanded office with an optional detail drawer, zoom and fit controls, persistent motion preference, and a compact operational view. Add persona search, collapsed groups, and floor-level attention indicators. Route directly to a persona with pending work on another floor.

Acceptance: 1, 6, 12, and 24 personas remain selectable with keyboard and pointer; long names fit; important alerts are visible from every floor; labels remain readable at presentation distance and at supported app zoom levels.

### 15. Build a repeatable conference story and visual quality gate — P2, M

Use the existing synthetic development harness to demonstrate one complete investigation, clearly identified as rehearsal data: a watched assessment changes, a specialist investigates, Chief of Staff collects the evidence, and an admin reviews the proposed next step. Add deterministic timeline fixtures for animation captures, screenshots at all scene states, and a recorded demo. For live presentations, provide explicit controls to conceal tenant and user identifiers.

Acceptance: the rehearsal completes without live tenant writes, the room state agrees with run evidence, and the path is repeatable offline where fixtures permit. Test a busy 24-persona scene, minimized-window idle behavior, prolonged use, reduced motion, keyboard access, high contrast, and 200% zoom. Establish frame-time and memory measurements on representative admin hardware before choosing numeric performance thresholds.

## Delivery sequence

1. **Foundation and first-use value:** 1–3, then 4–5, the initial inbox from 10, and schedule clarity from 11. Fix incorrect comparisons and queue behavior before positioning the feature as reliable unattended oversight.
2. **One complete proactive investigation:** 6–9 and the full briefing from 10. Target a supported assessment; prove detect → investigate → handoff → review before expanding the role catalog.
3. **Conference-quality office:** 12–15. Poses and paths can be developed alongside the capability work; meaningful handoff animation depends on actual handoff events.

Suggested flagship scenario: a scheduled device assessment identifies a newly changed compliance finding. Its persona records the finding and evidence; an investigation task examines the supported evidence; Chief of Staff produces a concise briefing with the proposed next step. If remediation is supported, the existing write-confirmation flow remains the final gate. Do not promise policy-cause attribution or automatic remediation without validating those specific data sources and workflows.

## Reuse and boundaries

- Reuse Office persistence and mission/run correlation; evolve contracts with migrations.
- Reuse the run engine, existing approval surface, and connector consent/delivery rules.
- Reuse scheduled change classification after fixing its tenant and assessment identity.
- Reuse the bounded chat investigation mechanism (`intune-chat/agentic-loop.ts`) and tenant-scoped workspace evidence contracts where appropriate.
- Keep invitations, shared credentials, cloud synchronization, floating desktop companions, and a room-decoration marketplace for later. They do not close the present investigation and decision gaps.

## External reference and verification limits

[Star Office UI's English README](https://github.com/ringhyacinth/Star-Office-UI/blob/master/README.en.md) documents state-specific areas, animated sprites and speech bubbles, daily notes, and invited-agent presence. These are useful presentation references; presence alone does not establish task delegation or a shared execution model. Continue using original artwork: the repository distinguishes MIT code from non-commercial art assets.

A read-only Lokka beta check on 2026-09-11 verified the representative managed-device selection (`id`, `operatingSystem`, `complianceState`), a returned next-page link, and the expected 400 response to an unknown selected property. This supports only the basic device-assessment example. It does not validate policy-conflict diagnosis, Defender investigations, all required permissions across installations, or a live proactive workflow. No live data or identifiers are recorded here.

This review used current branch source, focused local reproductions, existing Electron screenshots, and the upstream README. It did not repeat a full cross-platform UI test or implement the proposed fixes. The original investigation established the backlog. The implementation now adds targeted regression and Electron rehearsal coverage; the previous PR checks alone are not evidence for the new behavior.


## Implementation record (2026-09-11)

All fifteen areas now have implementation in this branch. The specification above remains
the acceptance reference; current architecture and limits are recorded in SPEC.md.

| Plan items | Implementation and evidence |
| --- | --- |
| 1–3 | Tenant/configuration baselines, normalized evidence, separate compute/review budgets, approval revalidation, scoped consent and bounded readiness retries. Host regressions cover comparison, approval, independent work, renewal, and recovery. |
| 4–5 | Functional role presets, two signed evidence-only registry workflows, persistent findings and review lifecycle with bounded memory. |
| 6–8 | Local watch conditions, cooldown/freshness/deduplication, atomic same-tenant evidence handoffs, deterministic routing and a validated one-call Chief planner. |
| 9–11 | Scoped persona conversations, action inbox and 24-hour briefing, searchable history, calendar/quiet-hour controls, DST/missed-check policy and resource visibility. |
| 12–14 | Aisle paths, independent idle timing, poses and foreground furniture, real event bubbles, search, floor alerts, zoom/fit, expanded office and persistent motion preferences. |
| 15 | Repeatable Electron rehearsal with recorded frames, responsive/state screenshots, 24-persona navigation, keyboard focus, reduced motion, high-contrast emulation, 200% zoom and hidden-window checks. |

Representative admin-hardware frame/memory thresholds, native Windows High Contrast,
macOS/Windows assistive-technology sessions, and an extended live-tenant deployment
remain release validation. Linux Xvfb measurements are explicitly labeled; no claims
of those external validations are made by the automated rehearsal.
