---
status: published
title: "Microsoft Graph and AI agents: a practical model for Microsoft 365 admins"
seo_title: "Microsoft Graph and AI agents"
slug: "microsoft-graph-and-ai-agents"
description: "How Microsoft Graph, declared scopes, tenant evidence, and AI agents fit together for Microsoft 365 administration workflows."
primary_keyword: "Microsoft Graph and AI agents"
secondary_keywords:
  - "Microsoft Graph permissions"
  - "Microsoft 365 admin agents"
  - "Graph scopes"
  - "Intune automation"
linkedin_angle: "Microsoft Graph gives agents the tenant evidence. The runtime decides whether that evidence becomes a safe admin workflow or a black box."
---

# Microsoft Graph and AI agents: a practical model for Microsoft 365 admins

Microsoft Graph is the control surface that makes Microsoft 365 admin agents useful. It provides the tenant evidence: users, devices, groups, policies, sign-ins, audit logs, app registrations, Intune records, and security signals. The agent layer should not hide that surface. It should declare which Graph scopes it needs, explain what evidence it read, and stop before any write operation changes the tenant.

The model is simple: Graph supplies structured tenant data, the agent workflow turns that data into a result, and the runtime enforces the trust boundary.

## Why Graph matters for agents

An AI agent without tenant evidence is just advice. It can explain general Microsoft 365 concepts, but it cannot answer what is happening in this tenant.

Microsoft Graph changes that. It lets a workflow read the objects and events that admins already care about:

- Intune managed devices
- Entra users and groups
- Conditional Access policies
- Sign-in logs
- Directory audit logs
- Secure Score controls
- App registrations
- License assignments
- Device compliance state

That evidence is what makes agent output specific. "Several devices are stale" is vague. "These 12 corporate-owned Windows devices have not synced in 120 days, have no pending retire action, and have matching inactive Entra device records" is useful.

## The permission problem

Graph access is also the risk.

Every agent that reads tenant data needs permissions. Some permissions are narrow. Others expose high-value administrative context. Write permissions can change tenant state.

That means scopes are not implementation details. They are part of the product contract.

A credible admin agent should show:

| Permission detail | Why the admin needs it |
| --- | --- |
| Required Graph scopes | Shows which tenant data or operations the workflow needs |
| Read or write mode | Separates investigation from mutation |
| Incremental consent behavior | Makes it clear when a new agent needs additional consent |
| High-risk scopes | Flags permissions that deserve extra review |
| Connector egress | Shows whether results leave the app for Teams, tickets, email, or another service |

If the product waits until runtime to reveal broad access, the admin cannot make a good consent decision.

## The manifest should be visible

For an agent registry, the manifest should be the source of truth.

A manifest should answer:

- What is the agent called?
- What does it do?
- Which Graph scopes does it need?
- Is it read-only or write-capable?
- Which model requirements does it have?
- Does it use local or hosted provider capabilities?
- Does it send output through connectors?
- What version is installed?
- What app version does it require?

This is what turns a catalog of community agents into something an organization can review. The alternative is a marketplace of attractive descriptions and hidden behavior. That is not enough for tenant administration.

## A practical example: sign-in failure explanation

Consider a sign-in failure explainer.

The admin wants to know why a group of users failed to sign in during the last 24 hours. The agent might need:

- Sign-in logs
- User records
- App display names
- Device context
- Conditional Access policy results
- Risk detail if the tenant has the right license

The useful output is not just a list of failures. The admin needs clustering:

- Failures by user
- Failures by app
- Failures by policy result
- Failures by client app or device platform
- A short explanation of the likely cause
- Next checks an admin should run

This is a good agent task because the value comes from correlation and explanation.

It is also a task where the permissions should be clear. The workflow may need audit and policy data. That should be declared before install or run.

## Mini-case: app registration review

Another useful Graph-backed agent is a dormant app registration review.

The raw data is available through Graph, but the decision is rarely one field. An admin may need application owners, credential age, sign-in activity, redirect URI patterns, permission grants, publisher domain, and whether the app still has a business owner. A simple export can produce a long list. The harder part is deciding which apps deserve review first.

A well-scoped agent can read the relevant application and sign-in evidence, then group findings:

- Apps with old client secrets and no recent sign-in activity.
- Apps with broad permissions but unclear ownership.
- Apps with redirect URIs that deserve manual review.
- Apps that look active and should be excluded from cleanup.

The agent should not delete or modify anything from that report. It should explain the evidence and produce a review queue. If a later write workflow exists, it should be a separate agent with a diff gate and a much narrower scope.

That separation also makes review easier for a second admin.

It gives the reviewer a narrow question to answer: does the evidence justify the proposed queue? That is much easier than reviewing an agent that mixes discovery, interpretation, and mutation in one opaque run. The Graph data still matters, but the workflow boundary becomes understandable.

## Read agents and write agents are different products

Read agents and write agents may share the same runtime, but they should not feel the same to the admin.

Read agents:

- Collect evidence.
- Produce a report.
- Do not change tenant state.
- Can run autonomously once tenant and provider preflight pass.

Write agents:

- Collect evidence.
- Prepare a proposed change.
- Show the exact diff.
- Wait for approval.
- Require typed confirmation for destructive operations.

That distinction should be visible in the registry, the install flow, and the run screen.

An agent that can retire Intune devices or disable guest accounts should not be presented like a reporting tool.

## The model provider is also part of the Graph story

Once an agent reads Graph data, the next question is where that data goes.

If the selected model provider is local, tenant evidence and prompts can stay on the admin workstation. If the selected provider is hosted, relevant tenant context may leave the device for that provider.

Both modes can be valid. The mistake is treating them as equivalent.

For Microsoft 365 admins, provider labeling should be visible near the run:

- Local provider: tenant context stays on this device.
- Hosted provider: tenant context is sent to the selected model provider.
- Connector output: report or notification is sent to the selected destination.

This matters because Graph data often contains operational detail about the tenant. Device names, user identifiers, policy names, sign-in locations, app registrations, and remediation candidates can all be sensitive.

## Best practices for Graph-backed agents

A Graph-backed agent should follow these rules:

1. Declare every required Graph scope.
2. Prefer the narrowest scope that can support the workflow.
3. Separate read-only investigations from write-capable actions.
4. Explain why high-risk scopes are needed.
5. Keep Graph calls visible in logs or run details.
6. Use the active tenant context explicitly.
7. Stop before every write operation.
8. Show before and after values where possible.
9. Keep local-provider prompts and results on the device.
10. Label hosted provider egress before the run.

These rules are not cosmetic. They are what make agents governable.

## Where OpenAdminOS fits

OpenAdminOS uses Microsoft Graph as the tenant data layer and treats the agent manifest as the review surface.

The design goals are:

- MSAL tenant connection.
- Declared Graph scopes per agent.
- Read/write classification.
- Local-first model provider support.
- Optional hosted provider support with clear egress labeling.
- Registry review before install.
- Diff confirmation before writes.

The product should make an admin faster without asking them to trust an invisible automation layer.

## Checklist: reviewing a Graph-backed agent

Before installing or running an agent, ask:

- Does the agent need these Graph scopes?
- Are any scopes broader than the stated job?
- Is the agent read-only or write-capable?
- Does it explain the evidence it uses?
- Does it show which tenant is active?
- Does the model provider keep Graph context local or send it to a hosted API?
- What happens if the agent proposes a write?
- Can the agent send output to a connector?

If the product cannot answer those questions, the issue is not the AI model. The issue is the runtime contract.

## Related reading

- Agent registry: `/registry`
- Trust model: `/trust-model`
- Intune use cases: `/use-cases/intune`
- LLM providers: `/llm-providers`

## LinkedIn draft

Microsoft Graph gives AI agents the tenant evidence.

That is also why the runtime matters.

For Microsoft 365 admins, an agent should show:

1. Which Graph scopes it needs
2. Whether it is read-only or write-capable
3. Which tenant is active
4. Where model prompts go
5. What happens before a write operation

The agent layer should not hide Graph permissions behind a friendly prompt.

It should make the workflow easier to review.
