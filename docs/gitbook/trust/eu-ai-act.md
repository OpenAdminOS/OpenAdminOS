---
title: "EU AI Act"
description: "How OpenAdminOS relates to the EU AI Act, and what stays with the organisation that uses it."
---

# EU AI Act

This page sets out how the OpenAdminOS project reads the EU AI Act (Regulation (EU) 2024/1689) for the desktop app, the public agent registry, and the OpenAdmin models. It is the project's own assessment, not legal advice, and not a certification. OpenAdminOS does not claim to be "AI Act compliant" because the Act has no such label for systems of this kind.

## Intended purpose

OpenAdminOS is a desktop app that helps IT administrators inspect and manage their own Microsoft 365 tenants: devices, apps, policies, identities, licences, and configuration. Agents read tenant data through Microsoft Graph, summarise it with the model the administrator selects, and propose changes. Every write pauses for human review.

OpenAdminOS is not intended to make, or prepare, decisions about people as workers. That includes recruitment, promotion, termination, task allocation based on individual behaviour or personal traits, and monitoring or evaluating the performance or behaviour of people in work-related relationships. It is not a safety component of critical infrastructure.

## How the Act applies

| Part | Assessment |
|---|---|
| Desktop app | An AI system released under the MIT licence. Article 2(12) excludes free and open-source AI systems from the Act, but not when they fall under Article 50. The app interacts directly with people and generates text, so the project does not rely on that exclusion. As a system that is not high-risk, the obligations the project works to are Article 50 transparency and Article 4 AI literacy. |
| High-risk (Annex III) | Not high-risk for its intended purpose. IT administration of a Microsoft 365 tenant is not an Annex III use. The nearest category is employment (Annex III, point 4), which the registry rules below keep out of scope. |
| Prohibited practices (Article 5) | Not applicable. Agents that recognise emotions at work, categorise people by biometric data, or produce social scores are not accepted into the registry. |
| Disclosure of AI interaction (Article 50(1)) | Administrators always see that they are working with an AI model, which provider and model is in use, and where prompts go. |
| Marking of generated text (Article 50(2)) | Run reports from **Copy report** and **Share** end with a note that the report includes AI-generated text, naming the provider and model. JSON exports already carry the provider and model as fields. Text copied from a single Chat answer carries no note. |
| Model providers | The developers of the general-purpose models you select are the model providers, for example Anthropic, OpenAI, Google, or the publisher of a model you run in Ollama or LM Studio. Services that host or relay those models, such as GitHub Copilot and Azure OpenAI, carry their own terms. |
| OpenAdmin models | Fine-tunes of openly licensed base models. The Commission's guidelines for general-purpose AI model providers treat modification compute above one third of the original model's training compute as an indicative criterion for the modifier becoming a model provider. OpenAdmin training runs are several orders of magnitude below that. The models are still published with model cards and a public training dataset. |

## What the product does

These features exist for their own reasons. They also line up with what the Act asks of AI systems in general.

| Topic | In OpenAdminOS |
|---|---|
| Human oversight | Write agents always stop at a diff confirmation, and the change applies only after the confirmation phrase is typed exactly. There is no bypass. See [Write confirmation](write-confirmation.md). |
| Disclosure of AI use | The top bar always shows the current tenant, provider, and data boundary: no model, a local model, or the hosted provider and model that prompts go to. See [Hosted providers](hosted-providers.md). |
| Records | Run history is stored locally, subject to the retention setting in Settings. **Copy report** on a run result includes the status, start time, provider, model, tenant, steps, and logs, and ends with the AI-generated note. |
| Data location | With a local provider, prompts and tenant data stay on the device. With a hosted provider, the UI names where they go. See [Local-first guarantee](local-first.md). |
| Documentation | Every registry agent declares its Graph scopes, read or write mode, and write actions in its manifest. The [Graph scope matrix](../generated/reference/graph-scope-matrix.md) and [Write safety matrix](../generated/reference/write-safety-matrix.md) are generated from those manifests. |

## Registry rules

The public registry does not accept agents whose purpose is to:

- Score, rank, or evaluate individual workers' performance, productivity, or behaviour, or prepare recruitment, promotion, termination, or task-allocation decisions about them.
- Recognise emotions, or categorise people by biometric data.
- Produce social scores or other assessments of people beyond the security and configuration state of their accounts and devices.

Security and configuration work on accounts stays in scope. An agent that triages Entra risky users so an administrator can reset a password or revoke sessions looks at account compromise, not at the person's work. Directory change audits and sign-in failure analysis look at account and configuration events in the same way. Their outputs must not be used to evaluate individual workers. Maintainers apply these rules during [registry review](registry-trust.md).

## What stays with your organisation

If your organisation is subject to the Act as a deployer, its obligations remain its own. In practice:

- Take measures so that the administrators who use OpenAdminOS understand what the models can and cannot do (AI literacy, Article 4).
- Assess your own use. Agents from a custom registry fork, agents you write yourself, and questions asked in Chat are outside the public registry rules.
- Using OpenAdminOS for an Annex III purpose, such as evaluating workers, is outside its intended purpose. Under Article 25, that can make your organisation the provider of a high-risk AI system.
- Keep run reports where your audit process needs them, and set run history retention to match.
- Choose a local provider when prompts and tenant data must not leave the device.

## When this assessment changes

The project reviews this page when the Act or its guidance changes, when OpenAdminOS is distributed on different terms, when the registry accepts a new category of agent, or when OpenAdmin model training changes materially.
