---
title: "Conditional Access explainer"
description: "Reviews Conditional Access policies for coverage, exclusions, report-only controls, overlaps, and common Zero Trust gaps."
---


# Conditional Access explainer

Reviews Conditional Access policies for coverage, exclusions, report-only controls, overlaps, and common Zero Trust gaps.

> This page is generated from `agents/index.json` and the agent manifest. Edit the manifest, then run `npm run docs:generate`.

## Classification

| Field | Value |
| --- | --- |
| Agent ID | `conditional-access-explainer` |
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
| Load all Conditional Access policies | `GET /identity/conditionalAccess/policies` | `Policy.Read.All` |

## Graph Scopes

- `Policy.Read.All`

## Write Behavior

This is a read-only agent. It does not declare write operations.

## LLM Use

| Step | Settings |
| --- | --- |
| Review Conditional Access posture | temperature 0.2 · max tokens 1100 |

## Settings

No user-configurable settings are declared.

## Source

- [Agent source](https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/conditional-access-explainer)
- [Manifest](https://github.com/OpenAdminOS/OpenAdminOS/blob/main/agents/conditional-access-explainer/manifest.yaml)
