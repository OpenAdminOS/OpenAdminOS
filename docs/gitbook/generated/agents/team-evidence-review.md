---
title: "Team evidence review"
description: "Investigates evidence handed to an Agent Team persona without collecting tenant data again."
---


# Team evidence review

Investigates evidence handed to an Agent Team persona without collecting tenant data again.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `team-evidence-review` |
| Version | `1.0.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `compliance` |
| Required Entra tier | `free` |
| Preferred model | `not pinned` |
| Minimum app version | `0.6.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-09-11 · `13dad4d` |

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
| Team evidence review | temperature 0.1 · max tokens 1800 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/team-evidence-review)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/team-evidence-review/manifest.yaml)
