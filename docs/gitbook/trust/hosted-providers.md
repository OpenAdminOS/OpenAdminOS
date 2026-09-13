---
title: "Hosted providers"
description: "How OpenAdminOS handles providers where prompts leave the device."
---

# Hosted Providers

Hosted providers send prompts and relevant tenant context to the selected model provider. OpenAdminOS must say this plainly in the UI.

## Available Hosted Providers

- **OpenAI (Codex)** runs through the locally installed Codex CLI. OpenAdminOS checks the CLI and auth state, then invokes Codex without storing an OpenAI API key.
- **Anthropic** runs through the locally installed Claude Code CLI and reuses the user's Claude Code login. OpenAdminOS does not store an Anthropic API key.
- **GitHub Copilot** runs through Copilot CLI 1.0.83 or newer. Sign in with `copilot login`, refresh providers, and use **Test** to check model access. Your account and organization must permit Copilot CLI.
- **Google Gemini** runs through Gemini CLI 0.59.0 or newer. Run `gemini` in a terminal to sign in, then use **Test** in OpenAdminOS. Discovery alone shows **Test required**, because Gemini has no authentication-status command.
- **Azure OpenAI** connects to a configured deployment. This is the one hosted provider where OpenAdminOS stores a single encrypted API key locally.

The CLI-backed providers reuse existing vendor authentication. OpenAdminOS does not ask for an additional key for them. Vendor subscriptions, quotas, organization policies, and the selected model still apply. Copilot sends supplied context through GitHub Copilot to the selected model service; Gemini sends it to Google. Vendor CLIs may retain local session history according to their own settings.

## Rule

If a provider is hosted, the UI must state that tenant prompts leave the device. See the LLM provider matrix for the per-provider data-flow messaging.

## Setup and troubleshooting

In **Settings → Providers**, refresh discovery after installing or signing in to a CLI. The provider card shows its detected executable and version. **Signed out**, **Access denied**, **Update required**, and **Request failed** have separate recovery instructions. A discovered executable does not prove that a model request will succeed; **Test** sends a small connection-check prompt without tenant data.

Copilot offers the models returned by your account's CLI catalog. Gemini uses the CLI's configured default model. After a successful test, either provider can be selected for Chat, Agent Team, scheduled runs, or Nova reasoning. Nova's microphone, transcription, and speech provider remain separate from its reasoning provider. Unattended runs need the CLI's existing sign-in and model access to remain valid.

OpenAdminOS uses these CLIs for model responses. Copilot and Gemini's own tools, hooks, extensions, and project instructions are disabled for these requests. Tenant actions still use OpenAdminOS's normal review and confirmation flow.

Official setup guides: [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) and [Gemini CLI](https://geminicli.com/docs/get-started/authentication/).
