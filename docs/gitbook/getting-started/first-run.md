---
title: "First run"
description: "What happens the first time OpenAdminOS starts."
---

# First Run

On first launch, OpenAdminOS opens Chat and offers three ways in:

- **Try with sample data**: opens a fictional Contoso tenant immediately. No Microsoft sign-in is needed.
- **Connect your tenant**: signs in with the OpenAdminOS application after you review its read-only permissions.
- **Use your organization's app registration**: for tenants that block third-party applications. See [Authentication and permissions](../trust/authentication.md).

You can close the choice and browse the app, inspect Agents and Settings, and draft a question before connecting anything.

## Sample Tenant

The sample tenant is built into the app and holds fictional devices, users, policies, apps, and sign-ins with realistic problems to find. Chat, read agents, run history, and Changes work against it the same way they work against a real tenant.

It is always labeled "Sample data": on the tenant chip, in the tenant switcher, above the Chat composer, and in every answer and export. Write agents still show their full change review and typed confirmation, and confirmed changes apply only to an in-memory copy of the sample data. Schedules, Agent Team personas, Workspaces, and connector deliveries need a real tenant.

Without an LLM provider, Chat on the sample tenant answers the suggested questions with computed results: an exact count and the most relevant rows. Pick a provider to ask your own questions and get explained answers. Agent schedules follow the active tenant, so they pause while the sample tenant is active. Remove the sample tenant at any time from the tenant switcher or Settings.

## Connecting A Real Tenant

When you send a question or start an agent without an active tenant:

1. Review the exact read-only Microsoft Graph permissions.
2. Complete Microsoft sign-in in your system browser.
3. Pick or repair an LLM provider if the action needs one.
4. Review and explicitly resume the original action.

After sign-in, OpenAdminOS shows which enterprise application was added to your tenant and how many delegated permissions it holds. Canceling keeps a Chat draft but discards the pending action. OpenAdminOS never sends a question or starts an agent automatically after sign-in, and agents cannot start without an active tenant.

## Provider Choice

Local providers (Ollama, LM Studio, Apple Foundation) keep prompts and tenant data on the device. Hosted providers (OpenAI through the Codex CLI, Anthropic through the Claude Code CLI, GitHub Copilot CLI, Gemini CLI, Azure OpenAI) send prompts off the device because the selected model is hosted. The CLI-backed providers reuse the vendor CLI's existing authentication instead of storing an API key.

The UI changes its data-residency messaging based on the active provider.
