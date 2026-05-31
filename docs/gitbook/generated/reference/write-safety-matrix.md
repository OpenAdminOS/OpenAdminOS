---
title: "Write safety matrix"
description: "Generated write-operation reference for OpenAdminOS agents."
---


# Write Safety Matrix

OpenAdminOS write agents always pause for human confirmation. This generated page lists the write-mode agents and the write actions declared in their manifests.

| Agent | Action | Confirmation | Scopes |
| --- | --- | --- | --- |
| [Offboarding agent](../agents/offboarding-agent.md) | `retire-managed-device` | `OFFBOARD {{ actions \| size }} DEVICES` | `DeviceManagementManagedDevices.PrivilegedOperations.All` |
| [Stale guest cleanup](../agents/stale-guest-cleanup.md) | `graph-write` | `DISABLE {{ oldest_stale.output \| size }} GUESTS` | `User.ReadWrite.All` |
