---
title: "Hosted providers"
description: "How OpenAdminOS handles providers where prompts leave the device."
---

# Hosted Providers

Hosted providers send prompts and relevant tenant context to the selected model provider. OpenAdminOS must say this plainly in the UI.

## Available Hosted Providers

- **OpenAI (Codex)** runs through the locally installed Codex CLI. OpenAdminOS checks the CLI and auth state, then invokes Codex without storing an OpenAI API key.
- **Anthropic** runs through the locally installed Claude Code CLI and reuses the user's Claude Code login. OpenAdminOS does not store an Anthropic API key.
- **Azure OpenAI** connects to a configured deployment. This is the one hosted provider where OpenAdminOS stores a single encrypted API key locally.

The CLI-backed providers avoid stored API keys by inheriting the vendor CLI's existing authentication.

## Rule

If a provider is hosted, the UI must state that tenant prompts leave the device. See the LLM provider matrix for the per-provider data-flow messaging.
