---
title: "Build your own Agent"
description: "Create and validate a local OpenAdminOS agent from inside the desktop app."
---

# Build Your Own Agent

Build your own Agent creates local user-authored agents from inside the desktop app. It is for admins who know the outcome they want but do not want to hand-write a full manifest first.

## Flow

1. Describe the target area, read or write intent, expected output, schedule intent, and whether Teams delivery is useful.
2. OpenAdminOS asks the active LLM provider to draft an agent manifest.
3. The draft is validated against the agent schema and Microsoft Graph checks.
4. If validation fails, OpenAdminOS attempts a repair pass using the exact validation errors.
5. The manifest opens in an editable YAML review pane.
6. Test draft runs a preflight check before Save and install is enabled.

Drafting follows the active provider's data-flow rules. Local providers such as Ollama, LM Studio, and Apple Foundation keep the drafting prompt on the device. Hosted providers such as OpenAI Codex, Anthropic through Claude Code, and Azure OpenAI send the prompt off the device because the selected model is hosted. See the LLM provider matrix for the full lineup.

## Preflight

Preflight checks the provider, manifest shape, Graph scopes, Graph endpoints, connector declarations, settings, and write-confirmation requirements.

## Services And Scopes

Every agent declares the Microsoft 365 services it needs in `descriptor.services`: `intune`, `entra` or `defender`. Each Graph scope the agent declares must belong to one of those services; the [Permissions by service](../generated/reference/permissions-by-service.md) reference shows where each scope belongs. An agent cannot run while one of its services is not connected for the tenant, and the Agents list and Marketplace show which services each agent needs.

```yaml
descriptor:
  id: stale-guest-cleanup
  # ...
  services:
    - entra
  mode: write
```

Use the least-privileged scopes that cover the agent's Graph operations:

- Prefer scopes that a service part already requests, such as `User.Read.All` or `Policy.Read.All`. A tenant that connected the service then needs no extra consent.
- Do not declare `Directory.Read.All` when a narrower read scope works. It is not part of any service and is requested only when the agent runs.
- Declare write scopes only on `write` steps. They are requested when the agent runs, and every write still pauses for diff confirmation.

Registry agents must declare `services`; the registry QA check `services-cover-scopes` fails without it, or when a scope is not covered. A local agent without `services` gets them derived from its scopes, but declaring them keeps the agent ready for a community submission.

For write agents, preflight verifies the confirmation gate but does not apply Graph changes. A write agent still pauses for confirmation every time it produces a non-empty write plan.

A write manifest can declare `descriptor.writeLimits.maxActions` and optional `maxActionsPerOperation` values keyed by action kind, such as `graph-write` or `retire-managed-device`. Each value must be a positive integer up to 1,000. The total defaults to 100 actions when no limits are declared. Read agents cannot declare write limits. Limits appear in the permissions preview and cannot be bypassed by approving a plan.

## Local Agents

Saved builder agents are local to the device. They appear in the merged agent list without becoming public registry entries.

Existing user-authored agents can be reopened in the builder, edited, tested again, and saved while keeping install settings, schedules, delivery rules, and run history.

## Export

The builder can export an upstream-ready local bundle containing `manifest.yaml`, `README.md`, and `metadata.json`. The bundle can be reviewed privately or used as the starting point for a community submission.
