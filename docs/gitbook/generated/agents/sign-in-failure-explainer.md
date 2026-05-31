---
title: "Sign-in failure explainer"
description: "Clusters recent failed sign-ins by error, app, user, client app, Conditional Access status, and location signals."
---


# Sign-in failure explainer

Clusters recent failed sign-ins by error, app, user, client app, Conditional Access status, and location signals.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `sign-in-failure-explainer` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `policies` |
| Required Entra tier | `p1` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-28 · `8b9007b` |

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load recent failed sign-ins | `GET /auditLogs/signIns` | `AuditLog.Read.All` |

## Graph Scopes

- `AuditLog.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Cluster failures by likely root cause | temperature 0.2 · max tokens 600 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/sign-in-failure-explainer)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/sign-in-failure-explainer/manifest.yaml)
