---
title: "LLM provider matrix"
description: "Provider trust and data-flow reference for OpenAdminOS."
---


# LLM Provider Matrix

| Provider | Local or hosted | Current status | Data-flow message |
| --- | --- | --- | --- |
| Ollama | Local | Available | Tenant prompts and responses stay on this device. |
| Apple Foundation | Local | Available on compatible Macs | Tenant prompts and responses stay on this device through Apple's on-device Foundation Models framework. |
| LM Studio | Local | Available | Tenant prompts and responses stay on this device through the local LM Studio server. |
| OpenAI Codex | Hosted | Available through the local Codex CLI | Tenant prompts are sent to OpenAI through the user's Codex account. OpenAdminOS does not store an OpenAI API key. |
| Anthropic | Hosted | Available through the local Claude Code CLI | Tenant prompts are sent to Anthropic through the user's Claude Code login. OpenAdminOS does not store an Anthropic API key. |
| Azure OpenAI | Hosted | Available | Tenant prompts are sent to the configured Azure OpenAI resource. OpenAdminOS stores one encrypted key locally. |
