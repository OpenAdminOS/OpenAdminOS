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

There is no demo tenant mode. If no tenant is connected, OpenAdminOS keeps you in onboarding and agents cannot start.

## Provider Choice

Local providers (Ollama, LM Studio, Apple Foundation) keep prompts and tenant data on the device. Hosted providers (OpenAI through the Codex CLI, Anthropic through the Claude Code CLI, Azure OpenAI) send prompts off the device because the selected model is hosted. The CLI-backed providers reuse the vendor CLI's existing authentication instead of storing an API key.

The UI changes its data-residency messaging based on the active provider.
