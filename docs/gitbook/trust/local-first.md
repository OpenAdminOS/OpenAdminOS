---
title: "Local-first guarantee"
description: "What stays on the device when OpenAdminOS runs locally."
---

# Local-First Guarantee

When a local LLM provider is selected, tenant data, prompts, agent outputs, run history, and error details stay on the user's machine.

OpenAdminOS does not send tenant-content telemetry. Registry install counts, when enabled, are limited to non-content metadata such as agent slug, app version, platform, and a yearly per-agent hash.

## Tenant Content in Prompts

Names, descriptions, records, connector responses, and saved evidence can contain instructions written by someone in the tenant. OpenAdminOS marks this content as untrusted data when sending it to a model. The model is told to ignore those instructions, keep the admin's task and tools, and report embedded instructions as a finding. These markers are hidden from answers and do not change the records shown in the app.

This reduces prompt-injection risk; it is not a guarantee. Write confirmation remains the control over tenant changes, including typed confirmation for destructive actions. Local providers continue to keep prompts and tenant data on this device.

## Local Storage

Run history, tenant configuration, installed agents, and app state are stored locally. Secrets are stored through the operating system keychain.

## Local Providers

Ollama, LM Studio, and Apple Foundation (on compatible Macs) are the local providers. Each keeps tenant prompts and responses on this device. See the LLM provider matrix for the full lineup and data-flow messaging.
