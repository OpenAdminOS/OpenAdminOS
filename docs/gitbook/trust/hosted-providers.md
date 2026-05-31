---
title: "Hosted providers"
description: "How OpenAdminOS handles providers where prompts leave the device."
---

# Hosted Providers

Hosted providers send prompts and relevant tenant context to the selected model provider. OpenAdminOS must say this plainly in the UI.

The current hosted path is OpenAI Codex through the locally installed Codex CLI. OpenAdminOS checks the local CLI and auth state, then invokes Codex without storing an OpenAI API key.

## Rule

If a provider is hosted, the UI must state that tenant prompts leave the device.

## Planned Providers

Anthropic, OpenAI direct, and Azure OpenAI are planned provider options. They must follow the same visible data-flow rule before they are enabled.
