# Data policy

OpenAdminOS classifies the fields it reads from Microsoft Graph and scans the
text it prepares for model requests. Classification runs on this device using
the response that arrived. Microsoft Graph can return fields beyond the
requested selection.

In this release, classification does not block, mask or reroute anything a
provider receives.

| Class | Examples |
| --- | --- |
| Credential | Recovery keys, LAPS passwords, application secrets and their hints, tokens, product keys and private keys |
| Identity | Names, user IDs, email addresses, phone numbers, and a person's sign-in IP and location |
| Security | Conditional Access, named locations, authentication policies, security baselines, endpoint security settings, and admin role definitions and assignments |
| Device | Device names and IDs, serial numbers, IMEI, MEID, MAC addresses and private IP addresses |
| Activity | Timestamps, statuses, results and app usage without the person's identity |
| Configuration | Tenant settings without personal data |
| Public | Microsoft Learn, web search and public reference material |

The table lists the classes from highest to lowest sensitivity. If several
classes apply to a value, the most sensitive wins. An unrecognized Graph field
or resource defaults to Identity. MCP results start as Identity unless the
server is a listed public reference. The public references are Microsoft Learn,
KQL Search, IntuneAutomation, Microsoft Release Communications, WindowsForum,
Splashtop Docs, Splashtop Agentic Packr Docs and endoflife.ai. Text checks can
raise the class of a public result.

Text checks recognize some patterns, such as email addresses and labeled
passwords, and can find values the app already knows about the organization.
An unfamiliar name or an opaque, unlabeled secret can evade these checks.

Classification provides information for future data policy controls. Provider
selection, prompt content and data sharing follow the existing
[provider settings](../trust/hosted-providers.md).
