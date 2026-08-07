---
title: "First run"
description: "What happens the first time OpenAdminOS starts."
---

# First Run

On first launch, OpenAdminOS opens directly to Chat. You can browse the app, inspect Agents and Settings, and draft a question before connecting anything.

When you send a question or start an agent for the first time:

1. Review the exact read-only Microsoft Graph permissions.
2. Complete Microsoft sign-in in your system browser.
3. Pick or repair an LLM provider if the action needs one.
4. Review and explicitly resume the original action.

Canceling keeps a Chat draft but discards the pending action. OpenAdminOS never sends a question or starts an agent automatically after sign-in. There is no demo tenant mode, and agents cannot start without an active tenant.

## Provider Choice

Local providers (Ollama, LM Studio, Apple Foundation) keep prompts and tenant data on the device. Hosted providers (OpenAI through the Codex CLI, Anthropic through the Claude Code CLI, Azure OpenAI) send prompts off the device because the selected model is hosted. The CLI-backed providers reuse the vendor CLI's existing authentication instead of storing an API key.

The UI changes its data-residency messaging based on the active provider.
