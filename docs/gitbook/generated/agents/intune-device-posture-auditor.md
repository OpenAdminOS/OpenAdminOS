---
title: "Intune Device Posture Auditor"
description: "Runs a read-only MXC-sandboxed audit of Intune managed-device posture, stale sync, compliance, ownership, enrollment, and duplicate-name signals."
---


# Intune Device Posture Auditor

Runs a read-only MXC-sandboxed audit of Intune managed-device posture, stale sync, compliance, ownership, enrollment, and duplicate-name signals.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `intune-device-posture-auditor` |
| Version | `0.1.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `devices` |
| Required Entra tier | `free` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.2.3` |
| Author | OpenAdminOS · verified |
| Last changed | unknown · `unknown` |

## Execution

This agent runs `agent.mjs` inside the experimental `mxc` sandbox. The Graph and LLM steps below are broker permissions, not host-interpreted pipeline steps.

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load managed device posture inputs | `GET /deviceManagement/managedDevices` | `DeviceManagementManagedDevices.Read.All` |

## Graph Scopes

- `DeviceManagementManagedDevices.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Summarize posture findings | temperature 0.2 · max tokens 420 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/intune-device-posture-auditor)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/intune-device-posture-auditor/manifest.yaml)
