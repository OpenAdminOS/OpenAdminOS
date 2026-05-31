---
title: "Stale guest cleanup"
description: "Builds a capped disable plan for enabled guest accounts with stale sign-in activity, external-state context, and per-guest rationale."
---


# Stale guest cleanup

Builds a capped disable plan for enabled guest accounts with stale sign-in activity, external-state context, and per-guest rationale.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `stale-guest-cleanup` |
| Version | `1.1.0` |
| Mode | `write` |
| Tier | `agent` |
| Category | `policies` |
| Required Entra tier | `p1` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-29 · `3a69fc6` |

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load guest accounts | `GET /users` | `User.Read.All`<br>`AuditLog.Read.All` |

## Graph Scopes

- `AuditLog.Read.All`
- `User.Read.All`
- `User.ReadWrite.All`

## Write Behavior

| Step | Action | Confirmation | Scopes |
| --- | --- | --- | --- |
| Disable each stale guest | Graph write | `DISABLE N GUESTS` | `User.ReadWrite.All` |

Write agents always pause for confirmation in OpenAdminOS. Destructive operations require the typed confirmation phrase shown by the app.

## LLM Use

| Step | Settings |
| --- | --- |
| Explain why this guest should be disabled | temperature 0.1 · max tokens 80 |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `inactiveDays` | integer | `90` | Enabled guests inactive at least this many days are considered for disable. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/stale-guest-cleanup)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/stale-guest-cleanup/manifest.yaml)
