---
title: "Delivery rules"
description: "How per-agent connector delivery rules work in OpenAdminOS."
---

# Delivery Rules

Connector setup is global. Delivery rules are per agent.

Use the **Connectors** page to connect services and set fallback targets. Use an agent's detail page to decide when that agent posts reports and where those reports go.

## What A Rule Controls

A delivery rule can control:

- Whether the connector is enabled for the agent.
- Whether manual runs, scheduled runs, or both should post.
- Whether successful runs, failed runs, or both should post.
- Whether scheduled reports should post only when findings change.
- Whether the agent uses the connector default target or a target override.

The rule is saved locally with the installed agent. Starting a run waits for any in-flight delivery save so the run uses the latest rule.

## What Gets Sent

OpenAdminOS sends the terminal run report for the agent. That report can include the agent's findings, status, and result text. It does not send hidden prompts, tenant cache contents, unrelated run history, or connector secrets.

Admins should still treat connector delivery as egress. If the report itself contains tenant findings, those findings go to the configured target.

## Multiple Targets

An agent can deliver to more than one connector. For example, a scheduled posture report can post to Teams for the admin team and send an Outlook email to a shared mailbox.

Each connector gets its own activity step. If Slack fails and Outlook succeeds, the run activity shows those outcomes separately.

## Failure Handling

Transient connector failures are queued locally and retried. Configuration failures require user action:

| Failure | Recovery |
| --- | --- |
| Missing Microsoft scope | Re-consent through Microsoft sign-in |
| Missing Slack token | Save a bot token on the Connectors page |
| Missing Discord webhook | Save a channel webhook URL |
| Signal CLI unavailable | Install or configure `signal-cli`, or point to a local REST bridge |
| WhatsApp session expired | Relink the local WhatsApp Web session |

Failed connector delivery does not erase the agent result. The result remains in local run history, and the failed delivery step stays visible in activity.
