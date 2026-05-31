---
title: "LLM provider matrix"
description: "Provider trust and data-flow reference for OpenAdminOS."
---


# LLM Provider Matrix

| Provider | Local or hosted | Current status | Data-flow message |
| --- | --- | --- | --- |
| Ollama | Local | Available | Tenant prompts and responses stay on this device. |
| OpenAI Codex | Hosted | Available through the local Codex CLI | Tenant prompts are sent to OpenAI through the user's Codex account. OpenAdminOS does not store an OpenAI API key. |
| LM Studio | Local | Coming soon | Tenant prompts and responses stay on this device when implemented. |
| Anthropic | Hosted | Coming soon | Tenant prompts are sent to Anthropic when selected. |
| Azure OpenAI | Hosted | Coming soon | Tenant prompts are sent to the configured Azure OpenAI resource when selected. |
