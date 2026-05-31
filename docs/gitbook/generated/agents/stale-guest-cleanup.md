---
title: "Stale guest cleanup"
description: "Builds a capped disable plan for enabled guest accounts with stale sign-in activity, external-state context, and per-guest rationale."
---


# Stale guest cleanup

Builds a capped disable plan for enabled guest accounts with stale sign-in activity, external-state context, and per-guest rationale.

> This page is generated from `agents/index.json` and the agent manifest. Edit the manifest, then run `npm run docs:generate`.

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
| Last changed | 2026-05-28 · `8b9007b` |

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
| Disable each stale guest | `graph-write` | `DISABLE {{ oldest_stale.output \| size }} GUESTS` | `User.ReadWrite.All` |

Write agents always pause for confirmation in OpenAdminOS. Destructive operations require the typed confirmation phrase shown by the app.

## LLM Use

No LLM step is declared. This should fail agent QA because OpenAdminOS agents are expected to use the configured model.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `inactiveDays` | integer | `90` | Enabled guests inactive at least this many days are considered for disable. |

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/stale-guest-cleanup)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/stale-guest-cleanup/manifest.yaml)
