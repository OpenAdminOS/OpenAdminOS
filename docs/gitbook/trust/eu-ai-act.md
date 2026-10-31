---
title: "EU AI Act"
description: "How OpenAdminOS relates to the EU AI Act, and what stays with the organisation that uses it."
---

# EU AI Act

This page sets out how the OpenAdminOS project reads the EU AI Act (Regulation (EU) 2024/1689) for the desktop app, the public agent registry, and the OpenAdmin models. It is the project's own assessment, not legal advice, and not a certification. OpenAdminOS does not claim to be "AI Act compliant" because the Act has no such label for systems of this kind.

## Intended purpose

OpenAdminOS is a desktop app that helps IT administrators inspect and manage their own Microsoft 365 tenants: devices, apps, policies, identities, licences, and configuration. Agents read tenant data through Microsoft Graph, summarise it with the model the administrator selects, and propose changes. Every write pauses for human review.

OpenAdminOS is not intended to make, or prepare, decisions about people as workers. That includes hiring, promotion, termination, task allocation based on personal traits, and monitoring or scoring an employee's performance or behaviour. It is not a safety component of critical infrastructure.

## How the Act applies

| Part | Assessment |
|---|---|
| Desktop app | An AI system released under the MIT licence. Article 2(12) excludes free and open-source AI systems from the Act unless they are high-risk, fall under the prohibited practices in Article 5, or fall under the transparency duties in Article 50. |
| High-risk (Annex III) | Not high-risk for its intended purpose. IT administration of a Microsoft 365 tenant is not an Annex III use. The nearest category is employment (Annex III, point 4), which the registry rules below keep out of scope. |
| Prohibited practices (Article 5) | Not applicable. Agents that perform emotion recognition at work, biometric categorisation, or social scoring are not accepted into the registry. |
| Transparency (Article 50) | Applies. Administrators always see that they are working with an AI model, which model and provider produced an answer, and where prompts go. |
| Hosted models | Anthropic, OpenAI, GitHub Copilot, Google, and Microsoft (Azure OpenAI) are the providers of the general-purpose models behind hosted options. Their model obligations stay with them. |
| OpenAdmin models | Fine-tunes of openly licensed base models. Under the Commission's guidelines for general-purpose AI model providers, a fine-tune makes the modifier a model provider only when the modification uses more than a third of the original training compute. OpenAdmin training runs are far below that. The models are still published with model cards and a public training dataset. |

## What the product does

These features exist for their own reasons. They also line up with what the Act asks of AI systems in general.

| Topic | In OpenAdminOS |
|---|---|
| Human oversight | Write agents always stop at a diff confirmation. Destructive actions need a typed phrase. There is no bypass. See [Write confirmation](write-confirmation.md). |
| Disclosure of AI use | The top bar always shows the current tenant, provider, and data boundary: no model, a local model, or the hosted provider and model that prompts go to. See [Hosted providers](hosted-providers.md). |
| Records | Run history is stored locally. **Copy report** on a run result includes the status, start time, provider, model, tenant, steps, and logs. |
| Data location | With a local provider, prompts and tenant data stay on the device. With a hosted provider, the UI names where they go. See [Local-first guarantee](local-first.md). |
| Documentation | Every registry agent declares its Graph scopes, read or write mode, and write actions in its manifest. The [Graph scope matrix](../generated/reference/graph-scope-matrix.md) and [Write safety matrix](../generated/reference/write-safety-matrix.md) are generated from those manifests. |

## Registry rules

The public registry does not accept agents whose purpose is to:

- Score, rank, or evaluate individual employees' performance, productivity, or behaviour, or to prepare hiring, promotion, termination, or task-allocation decisions about them.
- Infer emotions, or categorise people by biometric data.
- Produce social scores or other assessments of people beyond the security and configuration state of their accounts and devices.

Security work on accounts stays in scope. An agent that triages Entra risky users so an administrator can reset a password or revoke sessions looks at account compromise, not at the person's work. Maintainers apply these rules during [registry review](registry-trust.md).

## What stays with your organisation

If your organisation is subject to the Act as a deployer, its obligations remain its own. In practice:

- Make sure the administrators who use OpenAdminOS understand what the models can and cannot do (AI literacy, Article 4).
- Assess your own use. Agents from a custom registry fork, or agents you write yourself, are outside the public registry rules.
- Keep run reports where your audit process needs them.
- Choose a local provider when prompts and tenant data must not leave the device.

## When this assessment changes

The project reviews this page when the Act or its guidance changes, when OpenAdminOS is distributed on different terms, when the registry accepts a new category of agent, or when OpenAdmin model training changes materially.
