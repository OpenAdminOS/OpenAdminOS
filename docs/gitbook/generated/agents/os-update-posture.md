---
title: "OS update posture"
description: "Reviews Intune OS version distribution, compliance, ownership, enrollment, and stale inventory signals so admins can prioritize update work."
---


# OS update posture

Reviews Intune OS version distribution, compliance, ownership, enrollment, and stale inventory signals so admins can prioritize update work.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `os-update-posture` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `dashboard` |
| Category | `updates` |
| Required Entra tier | `free` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-28 · `8b9007b` |

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
| Summarize update posture | temperature 0.2 · max tokens 420 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `staleSyncDays` | integer | `14` | Devices that have not synced for at least this many days are flagged as stale inventory. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/os-update-posture)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/os-update-posture/manifest.yaml)
