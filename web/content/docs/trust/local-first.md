---
title: "Local-first guarantee"
description: "What stays on the device when OpenAdminOS runs locally."
---

# Local-First Guarantee

When a local LLM provider is selected, tenant data, prompts, agent outputs, run history, and error details stay on the user's machine.

OpenAdminOS does not send tenant-content telemetry. Registry install counts include only the agent slug, app version, and platform. The device records one attempt per agent each UTC year, even if the request fails. You can turn off counts or pause automatic app network requests in Settings > Privacy. Manual update checks, registry refreshes and documentation index installation remain available. Schedules, tenant cache refreshes, connector deliveries and model checks you set up still run.

## Public Support Reports

Use **Settings > About > Report a problem** to prepare a public GitHub issue. The form can preview the exact title and Markdown body on your device. If you include diagnostics, open the preview before submitting. Review the text for sensitive information and confirm that the issue will be public.

Diagnostics show cache row and page counts and other activity counts as ranges. Activity times are relative age ranges, and the report date is in UTC. Errors are summarized by category. Public registry agents can appear by slug. Other agents appear as local, and run identifiers are omitted. If the preview is rejected or the diagnostics are too large, update OpenAdminOS or clear **Include diagnostics** and submit again. You can also export the diagnostics JSON to a local file.

## Tenant Content in Prompts

Names, descriptions, records, connector responses, and saved evidence can contain instructions written by someone in the tenant. OpenAdminOS marks this content as untrusted data when sending it to a model. The model is told to ignore those instructions, keep the admin's task and tools, and report embedded instructions as a finding. These markers are hidden from answers and do not change the records shown in the app.

This reduces prompt-injection risk; it is not a guarantee. Write confirmation remains the control over tenant changes, including typed confirmation for destructive actions. Local providers continue to keep prompts and tenant data on this device.

## Local Storage

Run history, tenant configuration, installed agents, and app state are stored locally. Secrets are stored through the operating system keychain.

## Local Providers

Ollama, LM Studio, Lemonade, and Apple Foundation (on compatible Macs) are the local providers. Each keeps tenant prompts and responses on this device. See the LLM provider matrix for the full lineup and data-flow messaging.
