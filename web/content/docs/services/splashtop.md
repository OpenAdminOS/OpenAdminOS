---
title: "Splashtop"
description: "Connect the Splashtop Open API to an organization: what it needs, where the token and data go, the read tools Chat uses, and how changes are planned and confirmed. Also the Splashtop support references that need no sign-in."
---

# Splashtop

OpenAdminOS works with Splashtop in two ways:

- **Splashtop support references**, with no sign-in: Splashtop Docs MCP and Splashtop Agentic Packr Docs MCP, built-in searches over Splashtop's public Help Centers that answer Splashtop questions from the documentation. Add them from the **Marketplace**.
- **The Splashtop Open API**, connected to one organization with an API token: Chat reads that team's computers, inventory, users, groups, sessions and logs, and you can plan changes such as reboots that apply only after your typed confirmation.

## Support references (no sign-in)

| Reference | Host | Tools | Used for |
| --- | --- | --- | --- |
| Splashtop Docs MCP | support-splashtopbusiness.splashtop.com | `search_articles`, `get_article` | Questions about setting up, using and troubleshooting Splashtop, answered from the documentation |
| Splashtop Agentic Packr Docs MCP | support-splashtopagenticpackr.splashtop.com | `search_articles`, `get_article` | Questions about Splashtop Agentic Packr: connecting Intune, Entra ID sign-in, packaging installers, deployment and user experience templates, and deploying catalog apps |

Each is a public reference source like the other Marketplace servers: off until you add it, used by Chat in every organization, and words from your question can reach the host shown. The same filter blocks known tenant names, IDs, email addresses and IP addresses before a query is sent, and results are treated as third-party reference material, never as instructions.

- **Splashtop Docs MCP** answers questions about Splashtop from its documentation. It is built into OpenAdminOS and offered to Chat like an MCP server, without a separate server in between: Chat calls the Help Center's public article search and article API directly from this device. An article id is sent only when it appeared in your question or in an earlier search result of the same answer. If the Help Center limits requests (HTTP 429), Chat says how long to wait.
- **Splashtop Agentic Packr Docs MCP** works the same way against the Agentic Packr Help Center. A question that names Agentic Packr, or Packr, asks only this reference; a question that names Splashtop without Agentic Packr asks Splashtop Docs MCP; a question that names both asks both.

Both Splashtop references show the Splashtop logo in the Marketplace and on Connections.

## Connect the Open API

### What it needs

- **Splashtop Enterprise.** The Open API is not available on other Splashtop plans.
- **An API token** created by a Team Owner or Super Admin in **my.splashtop.com > Account Settings > Web API Tokens**.
- **The region of your Splashtop account.** A token works only on its own region's host:

| Region | Host |
| --- | --- |
| Global / US | webapi.splashtop.com |
| EU | webapi.splashtop.eu |
| Oceania | webapi.splashtop.nr |

- **An organization.** On this version an organization is created by its Microsoft 365 connection; Splashtop then connects to that organization. Connect Microsoft 365 first.

### Steps

1. Make the organization active, open **Connections**, and under **Other services** choose **Connect Splashtop**. The **Splashtop** listing in the Marketplace opens the same step.
2. Choose the region and paste the token.
3. Choose **Check and connect**. OpenAdminOS calls `GET /api/open/v1/users/basic_info` at the region's host. Only when that works is the connection saved; a failed check saves nothing.

The connection shows the host, the Splashtop team and the account the token belongs to, and each part with whether the token reaches it.

### Where the token and the data go

- The token is stored in this device's secure storage (macOS Keychain, Windows DPAPI or the Linux secret service) under this organization only. It is never shown again and never sent to the app's window.
- It is sent only to the region's host, over HTTPS, as a Bearer token to paths under `/api/open/v1/`. OpenAdminOS never follows a redirect with it and no MCP server or other third party sees it.
- Splashtop data that Chat reads is organization data, like your tenant data: it stays on this device, and it goes to the model you use. With a local model it does not leave the device; with a hosted model it goes to that provider, as the status strip says. Values from Splashtop results are never put in a public reference query.

### Manage

The **Manage** menu on the Splashtop line:

- **Plan a change**, see below.
- **Test** calls `users/basic_info` again with the stored token and updates the parts it reaches.
- **Rotate token** checks a new token at the same host and replaces the old one only if it works and belongs to the same Splashtop team.
- **Disconnect** stops any Splashtop change that is applying for this organization (the run says how many actions it applied), then deletes the token from this device and stops Chat from reading Splashtop. Nothing more is sent to Splashtop; the token stays valid in my.splashtop.com until you delete it there.

Connecting, rotating and disconnecting are recorded in the audit log export with the region, host and team, never the token. Disconnecting the organization's Microsoft 365 connection also deletes its Splashtop token.

### Errors

| What you see | What it means |
| --- | --- |
| HTTP 401 | Splashtop did not accept the token. It may be revoked or expired, or it was created in another region. Check the region, or create a new token and use **Rotate token**. |
| HTTP 403 | The plan or the token's role does not allow this data or action. The Open API needs Splashtop Enterprise and a token from a Team Owner or Super Admin. |
| HTTP 429 | Splashtop is limiting requests. Wait the time shown. Inventory allows 10 requests per minute. |
| Could not be reached | The network or a proxy blocked the host named in the message. |
| Redirect | The host answered with a redirect. OpenAdminOS never follows it with the token, so nothing more was sent. |

## What Chat can read

| Part | Read tools | Examples |
| --- | --- | --- |
| Computers | `splashtop_list_computers` | Which computers have been offline for more than 30 days? |
| Inventory | `splashtop_get_inventory` | What hardware and serial number does this computer report? |
| Users and groups | `splashtop_list_users`, `splashtop_list_groups` | Which users are disabled or still invited? |
| Sessions and logs | `splashtop_list_sessions`, `splashtop_list_team_history` | Who connected to remote computers in the last 7 days? |
| Policies and vulnerabilities | `splashtop_list_policies`, `splashtop_list_vulnerabilities` | Which CISA KEV vulnerabilities affect the most computers? |

Each tool returns one page of at most 50 records and says when more exist. A part is offered only when the token's `basic_info` answer says it may reach it; policies and vulnerabilities are not named there, so a token without them gets the HTTP 403 message.

Chat only reads. It does not reboot, delete, rename, disable or end anything.

## Plan a change

**Plan a change** in the **Manage** menu prepares a change. It never applies one.

1. Choose the change: reboot computers (or restart only the Streamer), rename computers, delete computers from the team, disable users, or end active sessions.
2. Pick up to 50 targets from the list Splashtop gives now. For a rename, type each new name (at most 64 characters, none of `< > , ; : " * + = \ | ?`).
3. Choose **Prepare plan**. OpenAdminOS reads every target from Splashtop again, refuses targets that are gone, already changed or cannot be changed (for example the team owner, an already disabled user, or a session Splashtop says cannot be ended), and opens the plan in **Runs**.

The plan lists one action per target with its current name or state and the change. Nothing happens until you type the confirmation phrase, for example `REBOOT 12 COMPUTERS`, `DELETE 1 COMPUTER`, `DISABLE 3 USERS`, `END 2 SESSIONS` or `RENAME 4 COMPUTERS`. A rename is not destructive; the others cannot be undone from OpenAdminOS.

- A plan applies only in its own organization: while another organization is active, it waits.
- A plan applies only through the Splashtop connection it was prepared with. After Splashtop is connected again, to the same team or another one, prepare the change again.
- Actions run in order, through that organization's Splashtop connection only. The first error stops the rest, and the run says how many were applied.
- Each action is checked again before it is sent: only the request kinds OpenAdminOS plans, for the connected team, can go out with the token.

## Not yet

- Agents cannot read or change Splashtop yet. Agent manifests declare Microsoft 365 services only.
- An organization with Splashtop and no Microsoft 365 connection is not possible yet.
- The reach map on Connections does not show Splashtop yet; the Splashtop line names its host.
