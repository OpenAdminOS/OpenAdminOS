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

## No-Op Runs

If a write agent produces zero actions after filters are applied, the run completes as a no-op. It is not treated as a failed confirmation.

## Reference

The write safety matrix lists the current write-mode agents and their declared actions.
