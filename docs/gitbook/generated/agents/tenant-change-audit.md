---
title: "Tenant change audit"
description: "Reviews recent directory audit entries by activity, category, result, actor, and target context to flag changes worth checking."
---


# Tenant change audit

Reviews recent directory audit entries by activity, category, result, actor, and target context to flag changes worth checking.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `tenant-change-audit` |
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
| Load recent directory audit entries | `GET /auditLogs/directoryAudits` | `AuditLog.Read.All`<br>`Directory.Read.All` |

## Graph Scopes

- `AuditLog.Read.All`
- `Directory.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Identify the noteworthy changes | temperature 0.2 · max tokens 360 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/tenant-change-audit)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/tenant-change-audit/manifest.yaml)
