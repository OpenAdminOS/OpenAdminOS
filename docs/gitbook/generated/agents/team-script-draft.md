---
title: "Team PowerShell draft"
description: "Prepares a PowerShell script for review from an Agent Team task and its supplied evidence."
---


# Team PowerShell draft

Prepares a PowerShell script for review from an Agent Team task and its supplied evidence.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `team-script-draft` |
| Version | `1.0.1` |
| Mode | `read` |
| Tier | `agent` |
| Category | `devices` |
| Required Entra tier | `free` |
| Preferred model | `not pinned` |
| Minimum app version | `0.6.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-09-15 · `fd6c994` |

## Execution

This agent runs through the host-side Agent Template interpreter.

## Tenant Data Access

No Graph read calls are declared in the manifest.

## Graph Scopes

No Graph scopes are declared.

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Team PowerShell draft | temperature 0.1 · max tokens 1200 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/team-script-draft)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/team-script-draft/manifest.yaml)
