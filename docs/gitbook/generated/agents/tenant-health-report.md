---
title: "Tenant health report"
description: "Summarizes Intune tenant health from compliance, OS, ownership, and stale inventory signals for scheduled or manual review."
---


# Tenant health report

Summarizes Intune tenant health from compliance, OS, ownership, and stale inventory signals for scheduled or manual review.

> This page is generated from `agents/index.json` and the agent manifest. Edit the manifest, then run `npm run docs:generate`.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `tenant-health-report` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `dashboard` |
| Category | `compliance` |
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
| Summarize tenant health | temperature 0.2 · max tokens 360 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `staleSyncDays` | integer | `14` | Devices that have not synced for at least this many days are flagged as stale inventory. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/tenant-health-report)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/tenant-health-report/manifest.yaml)
