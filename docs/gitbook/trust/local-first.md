---
title: "Local-first guarantee"
description: "What stays on the device when OpenAdminOS runs locally."
---

# Local-First Guarantee

When a local LLM provider is selected, tenant data, prompts, agent outputs, run history, and error details stay on the user's machine.

OpenAdminOS does not send tenant-content telemetry. Registry install counts, when enabled, are limited to non-content metadata such as agent slug, app version, platform, and a yearly per-agent hash.

## Local Storage

Run history, tenant configuration, installed agents, and app state are stored locally. Secrets are stored through the operating system keychain.

## Local Providers

Ollama, LM Studio, and Apple Foundation (on compatible Macs) are the local providers. Each keeps tenant prompts and responses on this device. See the LLM provider matrix for the full lineup and data-flow messaging.
