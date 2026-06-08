---
title: "Dormant app registrations"
description: "Reviews app registrations for stale experiments, risky exposure, credentials, and cleanup candidates with evidence-backed recommendations."
---


# Dormant app registrations

Reviews app registrations for stale experiments, risky exposure, credentials, and cleanup candidates with evidence-backed recommendations.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `dormant-app-registrations` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `agent` |
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
| Load app registrations | `GET /applications` | `Application.Read.All` |

## Graph Scopes

- `Application.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Review app registration cleanup posture | temperature 0.2 · max tokens 1000 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/dormant-app-registrations)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/dormant-app-registrations/manifest.yaml)
