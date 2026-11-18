# Data policy

OpenAdminOS classifies the fields it reads from Microsoft Graph and scans the
text it prepares for model requests. Classification runs on this device using
the response that arrived. Microsoft Graph can return fields beyond the
requested selection.

| Class | Examples |
| --- | --- |
| Credential | Recovery keys, LAPS passwords, application secrets and their hints, tokens, product keys and private keys |
| Identity | Names, user IDs, email addresses, phone numbers, and a person's sign-in IP and location |
| Device | Device names and IDs, serial numbers, IMEI, MEID, MAC addresses and private IP addresses |
| Activity | Timestamps, statuses, results and app usage without the person's identity |
| Configuration | Tenant settings without personal data |
| Public | Microsoft Learn, web search and public reference material |

The table lists the classes from highest to lowest sensitivity. If several
classes apply to a value, the most sensitive wins. An unrecognized Graph field
or resource defaults to Identity. Public reference results start as Public and
can be raised by the same text checks.

Text checks recognize some patterns, such as email addresses and labeled
passwords, and can find values the app already knows about the organization.
They cannot identify a name in free text that the app has never seen.

Classification provides information for future data policy controls. Provider
selection, prompt content and data sharing follow the existing
[provider settings](../trust/hosted-providers.md).
