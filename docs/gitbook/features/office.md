# Agent Team

Agent Team gives recurring work an owner. Personas check their assigned tenant,
record findings, hand evidence to specialists, and bring decisions back to you.
Their office, assignments, findings, and conversations live on your computer.

## Start with a role

1. Open **Agent Team** and choose **Add persona**.
2. Choose **Policy Watcher**, **Chief of Staff**, **Research Bot**, or **Script Bot**.
3. Review the selected workflows. Install any missing ones from the Hub.
4. Choose the tenant, provider, model, and schedule, then save.

Policy Watcher uses the compliance overview and proposes an hourly check of the
noncompliant-device count. This assessment does not diagnose which policy caused
a device's status. Chief of Staff can collect compliance evidence and skip further
investigation when a scheduled result is unchanged. Research Bot reviews supplied
evidence. Script Bot drafts PowerShell for your review and never executes its draft.

Name, responsibility, color, and avatar describe the persona. **Standing instructions**
control evidence review and persona answers. They cannot grant tools or bypass approval.
You can arrange up to eight installed workflows in each work order.

A local provider keeps model processing on your device. Saving a hosted assignment
requires consent to send its tenant context, handed-over evidence, planning requests,
and questions to the selected provider. Existing connector delivery rules still apply.

## Review the briefing

The briefing at the top shows approvals, open findings, operational problems, and
completed checks from the past 24 hours. Filter it by the kind of decision you need.
A scheduled persona without a completed check is shown separately from completed work.

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

Edit a persona and choose **Watch another persona**. The source must belong to the
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

Select a persona and ask a question such as “What changed?” or “Why was this flagged?”
Its answer uses completed evidence from its own assignments and handoffs, with links
to source runs. It keeps the persona's assigned tenant and provider even when you
switch the app's active selection. An empty history is disclosed as missing evidence.

Questions cannot change schedules, standing instructions, or tenant settings. Use
**Edit** to approve configuration changes. The conversation retains the latest 100
messages for that persona.

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

Personas appear beneath **Agent Team** in the sidebar with icons, search, and attention
indicators. Select one to open its assignment. Six teammates fit on each floor, up to
24 in total. Floor alerts and search keep distant teammates reachable.

Characters walk along office aisles, sit at desks, relax in the lounge, and use the TV
game corner. Timestamped work bubbles link to actual run evidence. Idle games are
only animation. Use **Expand office**, **Assignment details**, **Zoom**, and **Fit**
to present or inspect the room. **List** provides a compact operational view.

**Pause motion** is remembered. System reduced motion is respected, and ambient motion
stops when the window is hidden. **Hide details** replaces persona names with generic
labels and conceals tenant and assignment details in the team view. Other application
windows and separately opened dialogs are outside this presentation control.

Removing a persona removes its team memory while preserving underlying run history.
Stop dependent assignments before removing their evidence source. Disconnecting a
tenant stops its team and removes its persona, finding, handoff, and conversation data.
Inviting colleagues and floating desktop companions are not available yet.
