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
| Security | Conditional Access, named locations, authentication and authorization policies, device compliance policies, endpoint security settings, application permissions, and admin role assignments |
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
raise the class of a public result, including results from the built-in web search tool.

Text checks recognize some patterns, such as email addresses and labeled
passwords, and can find values the app already knows about the organization.
An unfamiliar name or an opaque, unlabeled secret can evade these checks.

A background worker on this device classifies incoming Graph data, prepares
cache classifications and scans larger model requests. A model request scan
can examine up to 16 million UTF-16 code units each for the system text and
the prompt, subject to the match work limit. If the scan cannot examine all
the evidence, its local record marks coverage incomplete separately from
the credentials it found and uses Credential as the effective class. The
provider call proceeds with the original request if the scan fails or its
worker times out. The local evidence budget favors credentials and identity
values. Live runs keep registering evidence until they finish or are
cancelled. Temporary Chat observations are kept on this device
for up to four completed turns in each of eight conversations, with a
15-minute maximum lifetime. A saved turn included in a follow-up in Chat or
desktop Nova reasoning has incomplete coverage if its original observations
were dropped, expired or are otherwise unavailable. Cancelling a turn clears
its active observations. Deleting the conversation or switching organizations
also releases associated observations. Disconnect clears the organization's
classification observations, identity indexes and local classification
diagnostics when the removal is saved, even if local cleanup needs a retry.
Classification diagnostics use static Graph route labels and expire after
15 minutes.

Hosted Nova voice uses a separate request path. Its classification coverage
is planned with provider routing in Phase A3.

Classification provides information for future data policy controls. Provider
selection, prompt content and data sharing follow the existing
[provider settings](../trust/hosted-providers.md).
