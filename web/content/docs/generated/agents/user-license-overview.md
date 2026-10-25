---
title: "User license overview"
description: "Reviews tenant user licensing hygiene by usage location, account state, and assigned-license presence."
---


# User license overview

Reviews tenant user licensing hygiene by usage location, account state, and assigned-license presence.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `user-license-overview` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `dashboard` |
| Category | `apps` |
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
| Load tenant users | `GET /users` | `User.Read.All` |

## Graph Scopes

- `User.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Summarize licensing posture | temperature 0.2 · max tokens 360 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/user-license-overview)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/user-license-overview/manifest.yaml)
