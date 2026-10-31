---
title: "Write confirmation"
description: "The human-in-the-loop rule for write agents."
---

# Write Confirmation

Write agents always pause before applying changes. There is no trust-this-agent bypass and no skip toggle.

Every write operation gets a confirmation step. Destructive operations require a typed phrase such as `RETIRE 47 DEVICES`.

## Plan Limits

Write plans are limited to 100 actions per run unless the agent's manifest declares a different limit. A manifest can allow at most 1,000 actions and can set tighter limits for individual action kinds. The permissions preview shows the declared limit or the host default before you install or run the agent.

Plans above a limit fail before confirmation. The entire plan is checked again before applying changes, including simulated runs. Nothing is changed when a plan is refused. Narrow the selection and run the agent again; the host does not silently truncate the plan.

An agent update that raises or removes a declared limit requires trust review. Lowering a limit is shown as an informational change.

## Dry Run

Choose **Dry run** beside Run on a write agent's detail page, or on its suggestion in Chat. Review the tenant, provider, and scopes, then start the dry run. It reads the tenant and prepares the same proposed actions and diff as a normal run.

The result is labelled **Dry run: not applied** and states which tenant was left unchanged. There is no Apply button or confirmation phrase to enter. The host blocks Graph writes throughout planning, connector changes and notifications, and automatic result delivery. An agent that attempts a blocked operation receives a policy error. Tenant prompts still follow the selected provider's local or hosted data handling.

Choose **Run for real** to start a new run with the same tenant, provider, model, and saved settings. It reads current tenant data and builds a fresh plan for normal review and confirmation. A dry-run plan can never be applied directly.

Dry runs are available only for write agents started manually. Schedules and Agent Team assignments continue to use their normal run flow.

## Risk flags

Before showing a plan, OpenAdminOS checks its proposed actions locally with a
fixed set of rules. A summary appears above the diff, and affected actions carry
markers. The check flags Conditional Access and privileged role changes,
destructive managed-device actions, deletion of users, groups, applications or
service principals, and application credential changes. Requests outside an
agent's declared Graph operations are flagged when they reach review.

Warnings identify assignments targeting All users or All devices and plans with
more than three times this agent's historical median action count in the same
tenant. Without confirmed-plan history, there is no size warning. Group names
alone do not establish that an assignment targets everyone.

Danger flags require you to select **I have reviewed the flagged actions** as
well as type the exact confirmation phrase before Apply is available. Warnings
are informational. Flags remain in the run's history after approval or rejection.

If the check cannot run, the screen says **Risk check could not run** and asks
you to review every action manually. Typed confirmation remains available. A
plan without flags still needs your review; the rules do not cover every risk.

## No-Op Runs

If a write agent produces zero actions after filters are applied, the run completes as a no-op. It is not treated as a failed confirmation. An empty dry-run plan remains labelled **Dry run: not applied**.

## Reference

The write safety matrix lists the current write-mode agents and their declared actions.
