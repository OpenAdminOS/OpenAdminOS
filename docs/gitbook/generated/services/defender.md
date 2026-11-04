---
title: "Defender"
description: "What the Defender service covers in OpenAdminOS, its permissions, roles and licences."
---


# Defender

Microsoft Defender alerts and incidents, and Secure Score.

Connecting Defender requests 3 delegated Microsoft Graph read scopes on top of the four sign-in scopes. Choose all of its parts or only some of them in the connect dialog, and add the rest later in Settings, Tenants. A part is on only when every one of its scopes is granted. With your own app registration, OpenAdminOS reads the granted permissions from the token and switches on each part that is fully granted; see [Own app registration](../../getting-started/own-app-registration.md).

## Parts And Permissions

### Alerts and incidents

Microsoft Defender alerts and incidents.

| Scope | Reason | Consent |
| --- | --- | --- |
| `SecurityAlert.Read.All` | Reads Microsoft Defender alerts so Chat can summarize open alerts by severity and service. Triage actions are never taken. | Admin |
| `SecurityIncident.Read.All` | Reads Microsoft Defender incidents so Chat can report incident status, classification and assignment. Incidents are never changed. | Admin |

Chat questions this part answers:

- Which high severity incidents are still open?

### Secure Score

Microsoft Secure Score history and improvement actions.

| Scope | Reason | Consent |
| --- | --- | --- |
| `SecurityEvents.Read.All` | Reads Microsoft Secure Score and its controls so the Secure score prioritizer can rank improvement actions by impact. | Admin |

Chat questions this part answers:

- Which Secure Score actions would raise the score most?

## Planned Parts

These parts are documented only. OpenAdminOS never requests their scopes today.

- **Advanced hunting**: Advanced hunting queries across Defender data. Needs `ThreatHunting.Read.All`.

## Run-Time Scopes

Agents may declare these. They are never requested when a tenant is connected, only when an agent that declares them runs. Writes always pause for diff confirmation.

| Scope | Reason |
| --- | --- |
| `SecurityEvents.ReadWrite.All` | Changes Secure Score control states. Requested only when a write agent that declares it runs. |

## Roles

Delegated permissions never add rights: OpenAdminOS can only read what the signed-in account can read. These roles let the account read this service without permission to change it, or with the narrowest permission that covers it. See [Roles](../../guides/roles.md) for who can grant admin consent.

| Role | Why |
| --- | --- |
| Security Reader | Reads Defender alerts, incidents and Secure Score without permission to change them. |
| Global Reader | Reads Defender alerts and incidents without permission to change them. Use Security Reader for Secure Score. |

## Licences

- Alerts and incidents need a Microsoft Defender product, for example Defender for Endpoint, Defender for Office 365 or Microsoft 365 E5.
- Secure Score is available in Microsoft 365 tenants without an extra licence.

## Agents

Agents in the registry that declare this service. An agent cannot run while a service it declares is not connected.

| Agent | Mode | Scopes |
| --- | --- | --- |
| [Secure Score prioritizer](../agents/secure-score-prioritizer.md) | `read` | `SecurityEvents.Read.All` |

See also [Permissions by service](../reference/permissions-by-service.md).
