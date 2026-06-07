---
title: "Connector setup reference"
description: "Setup requirements for Teams, Outlook, WhatsApp Web, Slack, Discord, and Signal."
---

# Connector Setup Reference

The Connectors page keeps the in-app setup compact. This reference lists the external steps that may be required before a connector can test successfully.

## Microsoft Teams

Teams uses Microsoft Graph delegated permissions and posts as the signed-in admin.

Setup:

1. Connect a Microsoft 365 tenant in OpenAdminOS.
2. Open **Connectors** and test Microsoft Teams.
3. Approve the incremental Graph consent if the tenant has not granted the Teams scopes yet.
4. Pick a default team and channel.
5. Enable Teams delivery on the relevant agent detail pages.

Teams requires the Graph scopes used to list joined teams, list channels, and post channel or chat messages. OpenAdminOS does not read Teams message history through the notification connector.

## Outlook

Outlook uses Microsoft Graph delegated `Mail.Send` and sends as the signed-in admin.

Setup:

1. Connect a Microsoft 365 tenant in OpenAdminOS.
2. Open **Connectors** and enter default recipients.
3. Optionally set a subject prefix, such as `[OpenAdminOS]`.
4. Test Outlook and approve `Mail.Send` if Microsoft prompts for consent.
5. Enable Outlook delivery on the relevant agent detail pages.

OpenAdminOS does not request `Mail.Read`, does not watch mailboxes, and does not ingest email content. Mail is sent through Exchange Online. If recipients are external, the report leaves the tenant.

## WhatsApp Web

WhatsApp Web uses a local linked-device session. OpenAdminOS does not use the WhatsApp Business API or a hosted relay for this connector.

Setup:

1. Open **Connectors** and start WhatsApp Web setup.
2. Scan the QR code from the WhatsApp mobile app.
3. Wait for the linked session to show as connected.
4. Pick a default target: yourself, a group, or a manual number/JID.
5. Send a test message.
6. Enable WhatsApp delivery on the relevant agent detail pages.

The connector sends outbound run notifications only. It does not read incoming messages, monitor chats, download media, or auto-reply.

## Slack

Slack uses a Slack app bot token and the Slack Web API.

Setup:

1. Create or reuse a Slack app for the target workspace.
2. Add the bot token scope `chat:write`.
3. Install the app to the workspace.
4. Copy the bot user OAuth token. It normally starts with `xoxb-`.
5. Invite the app to the target private channel when needed.
6. In OpenAdminOS, save the bot token and set the default channel, user, or conversation ID.
7. Test Slack.
8. Enable Slack delivery on the relevant agent detail pages.

The current connector posts with `chat.postMessage` and verifies the token with Slack `auth.test`. It does not create a Slack app automatically, subscribe to events, read channel history, or process slash commands.

## Discord

Discord uses a channel webhook URL. It does not require a Discord bot for the current notification-only connector.

Setup:

1. In Discord, open the target server and channel settings.
2. Create a channel webhook or copy an existing webhook URL.
3. In OpenAdminOS, save the webhook URL.
4. Optionally set a target label, webhook username override, or thread ID.
5. Test Discord.
6. Enable Discord delivery on the relevant agent detail pages.

OpenAdminOS posts through the webhook and disables mention parsing by default. It does not connect to the Discord Gateway, read guild history, or process interactions.

## Signal

Signal uses local tooling. OpenAdminOS does not bundle `signal-cli`.

Setup with `signal-cli`:

1. Install and configure `signal-cli` on the local machine.
2. Register or link the Signal sender account outside OpenAdminOS.
3. Confirm `signal-cli --version` works from the configured path.
4. In OpenAdminOS, set the sender account in E.164 format.
5. Set a default recipient and optional recipient label.
6. If needed, set a custom `signal-cli` path or config directory.
7. Test Signal.
8. Enable Signal delivery on the relevant agent detail pages.

Setup with `signal-cli-rest-api`:

1. Run a local `signal-cli-rest-api` bridge.
2. Confirm the local bridge responds on `/v1/about`.
3. In OpenAdminOS, set the REST bridge URL, sender account, and default recipient.
4. Test Signal.
5. Enable Signal delivery on the relevant agent detail pages.

Signal messages are delivered by Signal and leave Microsoft 365. The connector only sends outbound run reports.
