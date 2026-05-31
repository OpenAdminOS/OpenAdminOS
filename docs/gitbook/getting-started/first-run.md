---
title: "First run"
description: "What happens the first time OpenAdminOS starts."
---

# First Run

On first launch, OpenAdminOS guides you through the minimum setup required before an agent can run.

1. Review the local-first trust model.
2. Connect a Microsoft 365 tenant.
3. Pick an LLM provider.
4. Install and run a first agent.

There is no synthetic tenant mode. If no tenant is connected, OpenAdminOS keeps you in onboarding and agents cannot start.

## Provider Choice

Ollama keeps prompts and tenant data on the device. OpenAI Codex uses the locally installed Codex CLI and the user's existing Codex authentication, but prompts are sent to OpenAI because the selected model is hosted.

The UI changes its data-residency messaging based on the active provider.
