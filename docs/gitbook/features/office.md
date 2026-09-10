# Office

Office gives recurring work a recognizable owner. Create a persona, assign installed
agents, and inspect its work in a room or compact list. Personas and briefings are
stored on your computer.

## Create a persona

1. Open **Office** in the sidebar and choose **Add persona**.
2. Give it a name, a responsibility, and a robot, cat, fox, or owl avatar.
3. Choose its connected tenant, provider, and optional model.
4. Select up to eight installed agents and arrange their execution order.
5. Choose manual runs or a schedule, set the time budget, and save.

The responsibility is a description for you. The selected agent workflows define
what happens. Configure their settings and delivery rules on their agent pages.
The Chief of Staff starting role helps you arrange a sequence of checks and collect
their results in one briefing. It does not independently invent tasks or pass one
agent's output into another agent's prompt.

For a hosted provider, saving requires approval to send the assigned tenant's
context to that provider for manual and scheduled work. A local provider keeps
model processing on your device. Saved connector delivery rules still apply.

## Run and review work

Choose **Run assignment** to start. Office runs one task at a time, in the order
you chose. It waits for each task to finish successfully before starting the next.
The assignment stays bound to its chosen tenant and provider when you switch the
app's active tenant or provider.

Select a character to see its work order, next run, last completed assignment,
provider, and time budget. **View evidence** opens the original run. If a write
needs approval, **Review proposed changes** opens the existing confirmation screen.
Every write still requires your approval, including destructive typed confirmation.

The **Office briefing** collects the latest assignments and links to individual
results, changed findings, errors, and approval requests. It retains the latest
100 assignments. Underlying agent results follow your run-history retention settings.

## Scheduling and stopping

The first scheduled assignment starts after one full interval. Background scheduling
can run with the UI closed on Windows and macOS when enabled in Settings. The computer
must be running with a signed-in user session. On Linux, keep OpenAdminOS open.
This is periodic checking, not continuous monitoring while your computer is asleep
or turned off.

**Stop & pause** cancels the current work and disables future assignments. Requests
already sent may have completed; review their run steps before retrying. Edit the
persona to enable it again. You must stop an active assignment before editing or
removing its persona.

A failure or expired time budget pauses the persona. Review the error, repair the
tenant connection or provider if needed, then edit and save to resume. Changes to
provider configuration or assigned workflows also require reviewing and saving the
persona again. Office will not silently continue with a changed assignment.

Removing a persona removes its Office briefings but preserves agent run history.
Disconnecting its tenant removes the tenant's personas and briefings as well.

Office currently runs on one user's computer. Inviting colleagues and floating
characters outside the app are not available.
