---
title: "Local-first guarantee"
description: "What stays on the device when OpenAdminOS runs locally."
---

# Local-First Guarantee

With a local model, OpenAdminOS processes tenant data, prompts, and model responses on your computer. It stores run history and error details locally. A public reference you enable can receive words from your question, and a delivery rule or connector step you configure can send run reports.

The app sends no tenant-content, prompt, run-result, or crash-report telemetry. Registry install counts are on by default in packaged production builds and can be turned off in **Settings > Privacy**. A count sends the public agent slug, app version, and platform. See [Network calls](network-calls.md) for hosts, timing, and controls.

## Tenant Content in Prompts

Names, descriptions, records, connector responses, and saved evidence can contain instructions written by someone in the tenant. OpenAdminOS marks this content as untrusted data when sending it to a model. The model is told to ignore those instructions, keep the admin's task and tools, and report embedded instructions as a finding. These markers are hidden from answers and do not change the records shown in the app.

This reduces prompt-injection risk; it is not a guarantee. Write confirmation remains the control over tenant changes, including typed confirmation for destructive actions. Local providers continue to keep prompts and tenant data on this device.

## Local Storage

Run history, tenant configuration, installed agents, and app state are stored locally. Secrets are stored through the operating system keychain.

## Local Providers

Ollama, LM Studio, Lemonade, and Apple Foundation (on compatible Macs) are the local providers. Each processes prompts and responses on this device when you select a model that runs locally. See the LLM provider matrix for the full lineup and data-flow messaging.
