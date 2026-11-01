# Security policy

OpenAdminOS runs with delegated access to Microsoft 365 tenants and can change them. We treat security reports as the highest priority work in the project.

## Reporting a vulnerability

Please do not open a public GitHub issue, and do not use the in-app "Report issue" flow, because both create public issues.

Report privately instead:

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/OpenAdminOS/OpenAdminOS/security/advisories/new)
- **Alternative:** email [support@openadminos.com](mailto:support@openadminos.com) with "Security" in the subject

Include what you found, the affected version, steps to reproduce, and the impact you expect. Use a test tenant, and never include real tenant data, tokens, or credentials in a report.

We confirm receipt, keep you updated while we investigate, and credit you in the advisory unless you prefer to stay anonymous. Please give us reasonable time to release a fix before you disclose publicly.

## Supported versions

| Version | Supported |
|---|---|
| Latest stable release | Yes |
| Latest nightly | Yes |
| Older releases | No. Update to the latest stable release |

## In scope

Reports against the trust guarantees the product makes are the most valuable:

- Applying a write without diff confirmation, or a destructive write without typed confirmation
- Tenant data, prompts, or run results leaving the device while a local provider is selected
- Running an agent without an active tenant, or against a different tenant than the one shown
- The MCP gateway applying a change instead of only proposing it
- Installing or updating a registry agent without manifest hash verification
- The renderer reaching Node or Electron main-process capabilities it should not have
- Escaping the sandbox used for script agents
- Secrets (tokens, API keys, connector credentials) readable outside the OS secret store
- Vulnerabilities in openadminos.com and its public API endpoints

## Out of scope

- Vulnerabilities in Microsoft Graph, Entra ID, or Intune themselves. Report those to the [Microsoft Security Response Center](https://msrc.microsoft.com/report).
- Vulnerabilities in third-party LLM providers or their CLIs. Report those to the vendor.
- Attacks that require an already compromised device or an already compromised admin account
- Social engineering, physical attacks, and denial of service against our hosting providers
