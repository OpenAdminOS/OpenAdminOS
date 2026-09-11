# Agent Team

Agent Team gives recurring work an owner. AI teammates check their assigned tenant,
record findings, hand evidence to specialists, and bring decisions back to you.
Their office, assignments, findings, and conversations live on your computer.

## Start with a role

1. Open **Agent Team** and choose **Add teammate** (or **Add your first teammate**).
2. **Choose a role.** Pick Policy Watcher, Chief of Staff, Research Bot, Script Bot, or Custom role. Each card explains its responsibility and workflows. Give your teammate a name and avatar.
3. **Prepare workspace.** Choose its tenant and model provider. The checklist shows what is ready. Use **Connect tenant** or the provider setup guide when needed. For missing workflows, choose **Review and install**, confirm installation, then **Return to teammate**. Your draft stays open.
4. **Choose schedule.** Keep the suggested interval or choose manual runs. Review when work starts and whether the app needs to stay open. Advanced instructions, handoffs, calendar schedules and quiet hours remain available below.
5. **Review and add.** Check the tenant, model destination, ordered workflows, read/write modes and schedule. Hosted providers require your consent. **Back** lets you revise earlier choices without losing them.
6. Your new teammate is selected in the office. Choose **Run first assignment** when ready, then follow its source runs and results. Adding a teammate does not mean a check has already completed.

The action footer stays visible while the form scrolls. Workflows must be installed,
and the selected tenant and provider must be ready, before setup can continue.

Missing workflows stay in the selected work order until installed or explicitly removed.
Installation errors appear in the review dialog so you can retry. **Refresh available workflows**
reloads the catalog without closing your draft.

Policy Watcher uses the compliance overview and proposes an hourly check of the
noncompliant-device count. This assessment does not diagnose which policy caused
a device's status. Chief of Staff can collect compliance evidence and skip further
investigation when a scheduled result is unchanged. Research Bot reviews supplied
evidence. Script Bot drafts PowerShell for your review and never executes its draft.

Name, responsibility, color, and avatar describe the teammate. **Standing instructions**
control evidence review and teammate answers. They cannot grant tools or bypass approval.
You can arrange up to eight installed workflows in each work order.

A local provider keeps model processing on your device. Saving a hosted assignment
requires consent to send its tenant context, handed-over evidence, planning requests,
and questions to the selected provider. Existing connector delivery rules still apply.

## Review the briefing

The compact summary above the office shows attention and running assignments. Choose
**Review inbox** to see approvals, open findings, operational problems, and completed
checks from the past 24 hours. Filter it by the kind of decision you need.
A scheduled teammate without a completed check is shown separately from completed work.

Each finding has current and previous evidence links, freshness and coverage details,
and a review state. **Acknowledge** records that you saw it. **Snooze 1 day** removes
it from the open inbox until tomorrow. **Resolve** closes it; changed evidence can
reopen it. An unchanged result preserves your review state. Missing metrics are
reported as incomplete coverage, never as proof that everything is healthy.

Finding history and assignment search let you revisit previous work. The team keeps
the latest 100 assignments; source runs follow run-history retention. Active assignment
sources and the latest two evidence runs for unresolved findings are protected from
normal pruning. Older source links may expire under your retention policy.

## Connect specialists

Edit a teammate and choose **Watch another teammate**. The source must belong to the
same tenant. Select a new finding, changed finding, or threshold crossing, and set a
cooldown. The team reacts to completed local assessments while OpenAdminOS is running.
Quiet hours also apply to these triggers. Repeated revisions are deduplicated and
evidence older than 24 hours does not start a new investigation.

For example, let Policy Watcher run the compliance overview. Configure Research Bot
to watch its changed findings. Configure Chief of Staff to watch Research Bot and
assign Team evidence review and Team PowerShell draft as its permitted capabilities.
Choose model-assisted planning if Chief should select only the relevant assigned tasks.

The handoff records who requested the work, why, and which source runs support it.
The next specialist receives bounded evidence instead of collecting the tenant again.
Oversized results are omitted with a visible coverage note. Handoffs never cross tenants.

The Chief planner can only choose from the workflows you assigned. It makes one
bounded planning request and records its reason and skipped tasks. If its plan is
invalid or the provider cannot answer, the team visibly falls back to your approved
ordered work list. There is no unrestricted delegation loop.

## Ask about the evidence

Select a teammate and ask a question such as “What changed?” or “Why was this flagged?”
Its answer uses completed evidence from its own assignments and handoffs, with links
to source runs. It keeps the teammate's assigned tenant and provider even when you
switch the app's active selection. An empty history is disclosed as missing evidence.

Questions cannot change schedules, standing instructions, or tenant settings. Use
**Edit** to approve configuration changes. The conversation retains the latest 100
messages for that teammate.

## Schedules, limits, and approval

Choose an interval or a local calendar time, weekdays, and time zone. Calendar time
overrides the interval. Quiet hours delay scheduled starts. If the computer sleeps
through a check, the team runs one overdue check after waking outside quiet hours;
it does not replay every missed interval. A skipped daylight-saving time moves to
the next valid scheduled day, and a repeated local slot runs once.

Windows and macOS background scheduling can run with the UI closed when enabled in
Settings. The computer must be running with a signed-in session. On Linux, keep the
app open. This does not monitor a tenant while the computer is off.

One team workflow executes at a time. Queued work and human approval waiting do not
consume its execution budget. A pending approval releases the slot for other work.
Approval expires after the configured period, one day by default. Expired proposals
require a new assignment. The host rechecks a team write proposal before applying it;
changed actions stop and require a fresh review. Every write retains the normal
approval gate and destructive typed confirmation.

The assignment panel shows queue position, execution time, next and last completion,
approval expiry, and missed checks. Source runs show token use when supplied by the
provider. Monetary cost is not estimated.

**Stop & pause** cancels work and disables recurrence. Requests already dispatched
may have completed; review the run before retrying. Transient readiness failures can
retry up to three times before pausing. Execution failures pause with recovery details.
Changing an assigned provider destination or workflow requires review and save;
unrelated provider changes do not invalidate the assignment. Cosmetic edits remain
available when the assigned model is offline.

## Your team's office

AI teammates appear beneath **Agent Team** in the sidebar with icons, search, and attention
indicators. Select one to open its assignment. Six teammates fit on each floor, up to
24 in total. Floor alerts and search keep distant teammates reachable.

Characters walk along office aisles, sit at desks, relax in the lounge, and use the TV
game corner. Games are decorative. The fixed activity strip links to the run or finding
that caused the activity. Only the selected or keyboard-focused teammate is labeled
in the room; **Team roster** shows full names and statuses without crowding the scene.

Use **Expand office** to give the room more space and **Restore layout** to return.
**Assignment details** opens the selected work order. **Zoom / Fit** controls the
room scale; Fit uses both the available width and height. **List** provides a compact
operational view.

**Full screen** opens a native fullscreen office. **Exit full screen**, Escape, or
the operating system’s fullscreen control leaves it. Closing a dialog with Escape
keeps the office fullscreen. Leaving Agent Team restores the prior window mode;
if the window was already fullscreen, it stays fullscreen. The tenant and provider
boundary remain visible until you explicitly choose **Hide details**.

**Pause motion** is remembered. System reduced motion is respected, and ambient motion
stops when the window is hidden. **Hide details / Show details** is separate from
fullscreen. Hiding details replaces teammate names with generic labels and conceals
tenant and assignment details in the team view. Other application windows and
separately opened dialogs are outside this presentation control.

Removing a teammate removes its team memory while preserving underlying run history.
Stop dependent assignments before removing their evidence source. Disconnecting a
tenant stops its team and removes its teammate, finding, handoff, and conversation data.
Inviting colleagues and floating desktop companions are not available yet.
