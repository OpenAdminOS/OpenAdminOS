---
title: "Write confirmation"
description: "The human-in-the-loop rule for write agents."
---

# Write Confirmation

Write agents always pause before applying changes. There is no trust-this-agent bypass and no skip toggle.

Every write operation gets a confirmation step. Destructive operations require a typed phrase such as `RETIRE 47 DEVICES`.

## No-Op Runs

If a write agent produces zero actions after filters are applied, the run completes as a no-op. It is not treated as a failed confirmation.

## Generated Reference

The generated write safety matrix lists the current write-mode agents and the actions declared by their manifests.
