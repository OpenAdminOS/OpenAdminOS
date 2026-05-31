---
title: "Risky user triage"
description: "Classifies recent Entra risky users by risk level, state, detail, and processing status with conservative next-step guidance."
---


# Risky user triage

Classifies recent Entra risky users by risk level, state, detail, and processing status with conservative next-step guidance.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `risky-sign-in-triage` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `policies` |
| Required Entra tier | `p2` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-28 · `8b9007b` |

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load risky users | `GET /identityProtection/riskyUsers` | `IdentityRiskyUser.Read.All` |

## Graph Scopes

- `IdentityRiskyUser.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Classify this risky user | temperature 0.1 · max tokens 150 |
| Roll up triage results | temperature 0.2 · max tokens 420 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/risky-sign-in-triage)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/risky-sign-in-triage/manifest.yaml)
