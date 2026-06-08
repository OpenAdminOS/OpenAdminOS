---
title: "Compliance overview"
description: "Reviews Intune compliance by state, operating system, ownership, enrollment, and stale inventory signals."
---


# Compliance overview

Reviews Intune compliance by state, operating system, ownership, enrollment, and stale inventory signals.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `compliance-overview` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `dashboard` |
| Category | `compliance` |
| Required Entra tier | `free` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-29 · `3a69fc6` |

## Execution

This agent runs through the host-side Agent Template interpreter.

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load managed device inventory | `GET /deviceManagement/managedDevices` | `DeviceManagementManagedDevices.Read.All` |

## Graph Scopes

- `DeviceManagementManagedDevices.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Summarize compliance posture | temperature 0.2 · max tokens 360 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `staleSyncDays` | integer | `14` | Devices that have not synced for at least this many days are flagged as stale inventory. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/compliance-overview)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/compliance-overview/manifest.yaml)
