---
title: "Secure Score prioritizer"
description: "Prioritizes Microsoft Secure Score control profiles by category, action type, effort signals, user impact, and max-score upside."
---


# Secure Score prioritizer

Prioritizes Microsoft Secure Score control profiles by category, action type, effort signals, user impact, and max-score upside.

> This page is generated from `agents/index.json` and the agent manifest. Edit the manifest, then run `npm run docs:generate`.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `secure-score-prioritizer` |
| Version | `1.1.0` |
| Mode | `read` |
| Tier | `agent` |
| Category | `policies` |
| Required Entra tier | `free` |
| Preferred model | `llama3.1:8b` |
| Minimum app version | `0.1.0` |
| Author | OpenAdminOS · verified |
| Last changed | 2026-05-28 · `8b9007b` |

## Tenant Data Access

| Step | Graph call | Scopes |
| --- | --- | --- |
| Load Secure Score control profiles | `GET /security/secureScoreControlProfiles` | `SecurityEvents.Read.All` |

## Graph Scopes

- `SecurityEvents.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Rank recommendations | temperature 0.2 · max tokens 700 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/secure-score-prioritizer)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/secure-score-prioritizer/manifest.yaml)
