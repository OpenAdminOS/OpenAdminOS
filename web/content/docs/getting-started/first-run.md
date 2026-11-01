---
title: "First run"
description: "What happens the first time OpenAdminOS starts: pilot mode or production."
---

# First Run

The first time OpenAdminOS starts, it offers two ways in:

- **Start in pilot mode**: explore a fictional company's tenant right away. No Microsoft sign-in and no AI setup.
- **Connect your tenant**: production. Sign in with Microsoft and approve read access once, then ask anything about your own tenant and use every agent.

If your organization blocks third-party applications, use the link under Connect to sign in with your own app registration. See [Authentication and permissions](../trust/authentication.md).

## Pilot Mode

Pilot mode is a short, guided tour of what OpenAdminOS does. It runs on built-in sample data from a fictional company and is labeled on every screen. Nothing leaves your device.

What you can do in pilot mode:

- **Chat** with prepared prompts covering devices, compliance, Conditional Access, users, apps, and security. Each answer offers follow-up prompts. Free-text questions need a connected tenant.
- **Run three agents**: Find inactive devices, Conditional Access explainer, and Stale guest cleanup. Stale guest cleanup is a write agent: it shows the full change review and typed confirmation, and confirmed changes apply only to the sample data.
- **Review runs** in run history.

Pilot answers and agent reports use prepared text built from the sample data. No AI model is used, so pilot mode works the same on every machine. Agent Team, Changes, Workspaces, Connectors, and schedules are available in production only.

When you connect your tenant, the pilot data is removed and the app switches to production. You can open pilot mode again from the tenant switcher or Settings.

## Connecting Your Tenant

When you connect, or try a tenant-backed action without an active tenant:

1. Review the read-only Microsoft Graph permissions, grouped by area.
2. Complete Microsoft sign-in in your system browser.
3. Pick or repair an LLM provider if the action needs one.
4. Review and explicitly resume the original action.

After sign-in, OpenAdminOS shows which enterprise application was added to your tenant and how many delegated permissions it holds. Canceling keeps a Chat draft but discards the pending action. OpenAdminOS never sends a question or starts an agent automatically after sign-in, and agents cannot start without an active tenant.

## Provider Choice

Local providers (Ollama, LM Studio, Apple Foundation) keep prompts and tenant data on the device. Hosted providers (OpenAI through the Codex CLI, Anthropic through the Claude Code CLI, GitHub Copilot CLI, Gemini CLI, Azure OpenAI) send prompts off the device because the selected model is hosted. The CLI-backed providers reuse the vendor CLI's existing authentication instead of storing an API key.

If you have not picked a provider, OpenAdminOS selects a ready local provider automatically. A detected hosted provider is suggested with a note about where data goes, and you choose it explicitly. The UI changes its data-residency messaging based on the active provider.
