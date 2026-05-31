---
title: "Offboarding agent"
description: "Builds a conservative stale-device offboarding plan from Intune sync, Entra sign-in, ownership, compliance, and trust signals, then retires devices after typed confirmation."
---


# Offboarding agent

Builds a conservative stale-device offboarding plan from Intune sync, Entra sign-in, ownership, compliance, and trust signals, then retires devices after typed confirmation.

> This page is generated from `agents/index.json` and the agent manifest. Edit the manifest, then run `npm run docs:generate`.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `offboarding-agent` |
| Version | `1.1.0` |
| Mode | `write` |
| Tier | `agent` |
| Category | `devices` |
| Required Entra tier | `free` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-28 · `8b9007b` |

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load Intune managed devices | `GET /deviceManagement/managedDevices` | `DeviceManagementManagedDevices.Read.All` |
| Load Entra device records | `GET /devices` | `Device.Read.All` |

## Graph Scopes

- `Device.Read.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`
- `DeviceManagementManagedDevices.Read.All`

## Write Behavior

| Step | Action | Confirmation | Scopes |
| --- | --- | --- | --- |
| Build offboarding plan | `retire-managed-device` | `OFFBOARD {{ actions \| size }} DEVICES` | `DeviceManagementManagedDevices.PrivilegedOperations.All` |

Write agents always pause for confirmation in OpenAdminOS. Destructive operations require the typed confirmation phrase shown by the app.

## LLM Use

| Step | Settings |
| --- | --- |
| Explain the offboarding plan | temperature 0.2 · max tokens 420 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `staleDays` | integer | `180` | A device must exceed this many days of inactivity on the selected signal(s) to be flagged. |
| `strategy` | string | `both` | How to combine the Intune and Entra staleness signals. One of: both (stale in both), intune-only (only Intune sync matters), entra-only (only Entra sign-in matters). |
| `excludePersonalDevices` | boolean | `true` | Excludes Intune devices whose managedDeviceOwnerType is personal before the retire plan is built. |
| `instructions` | string | `` | Optional free-text guidance fed to the rationale step. Use this to encode org-specific rules (for example, exclude kiosk devices, prefer Apple BYOD, etc.). |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/offboarding-agent)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/offboarding-agent/manifest.yaml)
