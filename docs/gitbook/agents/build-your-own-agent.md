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

Drafting follows the active provider's data-flow rules. Ollama keeps the drafting prompt local. OpenAI Codex uses the local Codex CLI, but the prompt is sent to OpenAI because the selected model is hosted.

## Preflight

Preflight checks the provider, manifest shape, Graph scopes, Graph endpoints, connector declarations, settings, and write-confirmation requirements.

For write agents, preflight verifies the confirmation gate but does not apply Graph changes. A write agent still pauses for confirmation every time it produces a non-empty write plan.

## Local Agents

Saved builder agents are local to the device. They appear in the merged agent list without becoming public registry entries.

Existing user-authored agents can be reopened in the builder, edited, tested again, and saved while keeping install settings, schedules, delivery rules, and run history.

## Export

The builder can export an upstream-ready local bundle containing `manifest.yaml`, `README.md`, and `metadata.json`. The bundle can be reviewed privately or used as the starting point for a community submission.
