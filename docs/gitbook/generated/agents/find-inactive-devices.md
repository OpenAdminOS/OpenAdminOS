---
title: "Find inactive devices"
description: "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance."
---


# Find inactive devices

Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `find-inactive-devices` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `devices` |
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
| Summarize findings with local LLM | temperature 0.2 · max tokens 420 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `warnDays` | integer | `30` | Devices inactive at least this many days enter the warn band. |
| `staleDays` | integer | `90` | Devices inactive at least this many days enter the stale band. |
| `retireDays` | integer | `180` | Devices inactive at least this many days are flagged for retirement. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/find-inactive-devices)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/find-inactive-devices/manifest.yaml)
