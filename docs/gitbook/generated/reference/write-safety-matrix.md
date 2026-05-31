---
title: "Write safety matrix"
description: "Write-operation reference for OpenAdminOS agents."
---


# Write Safety Matrix

OpenAdminOS write agents always pause for human confirmation. This reference lists the current write-mode agents, their declared write actions, and the required confirmation text.

| Agent | Action | Confirmation | Scopes |
| --- | --- | --- | --- |
| [Offboarding agent](../agents/offboarding-agent.md) | Retire Managed Device | `OFFBOARD N DEVICES` | `DeviceManagementManagedDevices.PrivilegedOperations.All` |
| [Stale guest cleanup](../agents/stale-guest-cleanup.md) | Graph write | `DISABLE N GUESTS` | `User.ReadWrite.All` |
