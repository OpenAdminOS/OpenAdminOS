---
title: "Connectors"
description: "How OpenAdminOS sends agent reports to external workspaces."
---

# Connectors

Connectors are outbound delivery routes for completed agent reports. They let OpenAdminOS post a run result to a place where admins already work, such as Teams, Outlook, Slack, Discord, WhatsApp, or Signal.

Connectors do not turn those services into agent control channels. OpenAdminOS does not listen for inbound messages, read channel history, process reactions, run slash commands, or ingest files through the connector surface.

## Delivery Flow

1. Configure the service on the **Connectors** page.
2. Test the connector so OpenAdminOS can verify consent, credentials, or local tooling.
3. Set a default target, such as a Teams channel, email recipients, Slack conversation, or Signal recipient.
4. Open an installed agent and enable delivery for that connector.
5. Run the agent. When the run reaches a terminal state, OpenAdminOS queues the notification locally.
6. The connector sends the report and writes the outcome to the run activity log.

Saved delivery rules are the user's approval to post the terminal report automatically. They do not bypass write-agent confirmation. Write agents still pause before any tenant-changing operation.

## No Power Automate Dependency

OpenAdminOS does not use Microsoft Power Automate, formerly Flow, for connector delivery. The app calls each connector directly:

| Connector | Delivery path |
| --- | --- |
| Teams | Microsoft Graph delegated calls |
| Outlook | Microsoft Graph `/me/sendMail` |
| WhatsApp Web | Local linked-device Web session |
| Slack | Slack Web API `chat.postMessage` |
| Discord | Discord channel webhook |
| Signal | Local `signal-cli` or local `signal-cli-rest-api` bridge |

This keeps delivery local to the desktop app until the configured connector sends the report. It also means admins do not need to maintain a separate Power Automate workflow for routine run notifications.

## Trust Boundary

Teams and Outlook reuse Microsoft sign-in and delegated Graph consent. Teams posts stay inside Microsoft 365. Outlook sends through Exchange Online, but mail can leave the tenant if recipients are external.

Slack, Discord, WhatsApp Web, and Signal are external egress routes. Message content leaves Microsoft 365 and is delivered by the configured service. The connector card and run activity label this boundary.

Secrets for external connectors are stored through the desktop app's secret store. Slack bot tokens and Discord webhook URLs are write-only from the renderer: the app can save or clear them, but it does not return the secret value to the UI.

## Local Queue

Connector delivery is queued locally after the agent result is created. Transient failures retry with bounded backoff and are processed again on app reopen or scheduler ticks.

Failures are visible in run activity. A connector that needs consent, configuration, or local tooling is reported as a connector setup problem instead of failing silently.
