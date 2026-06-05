---
status: published
title: "How to build your own Microsoft 365 admin agent"
seo_title: "Build Microsoft 365 admin agents"
slug: "how-to-build-your-own-microsoft-365-admin-agent"
description: "A practical guide to designing a Microsoft 365 admin agent with a clear goal, Graph scopes, model steps, test runs, and write confirmation."
primary_keyword: "build your own Microsoft 365 admin agent"
secondary_keywords:
  - "Microsoft 365 agent builder"
  - "custom Intune agent"
  - "Microsoft Graph agent manifest"
  - "build AI agent for admins"
linkedin_angle: "The hard part of building an admin agent is not the prompt. It is defining the scope, evidence, permission boundary, and review gate."
---

# How to build your own Microsoft 365 admin agent

To build a useful Microsoft 365 admin agent, start with the operational question, not the model. Define the tenant evidence the agent needs, declare the Microsoft Graph scopes, decide whether the workflow is read-only or write-capable, add a model step where reasoning is actually needed, and test the result before installing it as a reusable workflow.

The hard part is not writing a prompt. The hard part is making the agent safe and specific enough for tenant administration.

## Start with a real admin question

Good agents start with a narrow question.

Weak prompt:

> Help me manage Intune devices.

Better prompt:

> Find corporate-owned Intune devices that have not synced in 90 days, exclude devices with retire or wipe already pending, group them by operating system, and summarize which ones look safe to review for cleanup.

The second version gives the workflow a boundary. It names the target area, data signals, exclusions, and expected output.

Before building the agent, write down:

- Target service: Intune, Entra, Conditional Access, app registrations, licensing, or another area.
- Intent: read-only investigation or write-capable plan.
- Evidence: which records or events matter.
- Output: table, report, ranked list, diff, or notification.
- Risk: what could go wrong if the agent is too broad.

If those answers are unclear, the agent is not ready to build.

## Decide whether the agent is read-only or write-capable

This decision should happen early.

Read-only agents can:

- Collect evidence.
- Summarize findings.
- Rank results.
- Suggest next checks.
- Prepare a report.

Write-capable agents can:

- Prepare a proposed change.
- Show a before and after diff.
- Wait for approval.
- Execute the approved Graph write.

The second category needs a higher bar. It should not be possible to add "and retire the devices" at the end of a broad prompt and silently turn an investigation into a tenant-changing workflow.

If a write agent produces a non-empty change plan, it should stop for confirmation every time.

## Identify the Graph evidence

Most useful Microsoft 365 admin agents depend on Microsoft Graph.

For each workflow step, identify the data source:

| Agent goal | Likely evidence |
| --- | --- |
| Stale Intune device review | Managed devices, Entra devices, ownership, compliance, pending actions |
| Sign-in failure explanation | Sign-in logs, users, apps, devices, Conditional Access results |
| Secure Score prioritization | Secure Score controls, tenant context, risk categories |
| Dormant app registration review | Applications, credentials, permissions, sign-in activity |
| Guest cleanup planning | Guest users, group membership, sign-in activity, invitations |

This step is where many draft agents become too vague. "Check tenant health" is not a data plan. The agent needs to know which Graph surfaces to read and why.

## Declare scopes as part of the design

Graph scopes are not an implementation detail. They are part of the trust contract.

For each evidence source, the agent should declare the required scopes. If the agent needs a high-risk permission, the description should explain why.

Good scope behavior:

- Declare scopes before install.
- Avoid broad scopes when a narrower path works.
- Separate read scopes from write scopes.
- Treat write scopes as a review event.
- Show incremental consent before the run needs it.

Bad scope behavior:

- Request broad permissions "just in case."
- Hide scopes until the Microsoft consent screen appears.
- Mix read-only and write behavior under vague wording.
- Change scopes in an update without review.

Admins are used to consent prompts. What they need is context before the prompt.

## Add the model where it earns its keep

The LLM step should do work that a deterministic transform cannot do well.

Good model tasks:

- Explain why a pattern matters.
- Summarize evidence into an admin-readable report.
- Rank findings by context.
- Produce a short rationale for each proposed action.
- Turn raw policy behavior into plain language.

Weak model tasks:

- Count rows.
- Sort by date.
- Filter by one field.
- Convert JSON to CSV.
- Repeat static documentation.

The deterministic parts of the workflow should stay deterministic. Use the model for reasoning and language, not for basic data processing.

## Design the output before the prompt

A useful agent result should be easy to review.

Decide whether the output should be:

- A table of findings.
- A ranked list.
- A short report.
- A grouped summary.
- A change plan.
- A connector preview.

For admin work, the output should usually include:

- Main finding
- Evidence
- Risk or impact
- Next action
- Objects affected
- Tenant and provider context

If the agent is write-capable, the output must include a diff before execution.

## Test before install

A custom agent should go through a local test pass before it becomes part of the admin's reusable toolkit.

Test for:

- Provider availability
- Graph scope validity
- Endpoint validity
- Empty result behavior
- Large tenant behavior
- Permission failures
- Write confirmation behavior
- Hosted provider warning behavior

Empty results are especially important. "No stale devices found" is not a failure. It should be reported clearly.

Permission failures also need clear recovery. "403" is not enough. The admin needs to know which scope, consent, role, or license is likely missing.

## Think about sharing separately

Building an agent for yourself is not the same as publishing an agent for others.

Before sharing, check:

- Does the manifest avoid tenant identifiers?
- Does the README explain what data the agent reads?
- Are scopes justified?
- Are write actions clearly described?
- Are connector destinations documented?
- Are secrets excluded?
- Is the license clear?

Community agents need a review path. A public registry should not accept arbitrary code or unclear manifests without checks.

## Where OpenAdminOS fits

OpenAdminOS is designed around this workflow:

- Build or draft an agent.
- Review the manifest.
- Validate Graph scopes and endpoints.
- Run a local preflight.
- Save and install only after validation.
- Use local providers for local prompt handling when desired.
- Stop write agents at diff confirmation.

The builder should help with the structure, but it should not remove review. Admins should still see the scopes, evidence, provider boundary, and write behavior before trusting the workflow.

## A simple first agent idea

A good first custom agent is a read-only report.

Example:

> Review Intune managed devices that have not synced in 60 days. Group by ownership, operating system, and compliance state. Exclude devices with retire or wipe pending. Summarize which groups should be reviewed first and why.

This is a good first agent because:

- It is read-only.
- The Graph area is clear.
- The output is useful.
- The model has a real summarization job.
- There is no tenant write risk.

Once that pattern works, a write-capable version can be designed separately with diff confirmation.

## Mini-case: turning a vague request into a usable agent

Suppose the starting request is:

> Find risky devices.

That is not enough for an admin agent. "Risky" could mean stale sync, noncompliance, unsupported operating system, missing encryption, personal ownership, or a device connected to a risky user. The builder should force the request into a narrower workflow.

A better agent definition is:

> Review corporate-owned Intune managed devices that are noncompliant or have not synced in 60 days. Group them by operating system, ownership, and compliance state. Exclude devices with retire or wipe pending. Produce a ranked review list with the evidence for each group.

Now the design is testable. The agent has a target area, filters, exclusions, output shape, and a read-only mode. The admin can validate the Graph scopes before install and run a preflight before trusting the result.

If the admin later wants cleanup automation, that should become a second write agent. The read-only investigation should not quietly grow into a tenant-changing workflow.

## Checklist: before saving a custom agent

- Is the goal narrow?
- Is the agent read-only or write-capable?
- Are the Graph scopes declared?
- Are the Graph endpoints valid?
- Does the model step add real reasoning?
- Is the output reviewable?
- Does the agent behave clearly when there are no results?
- Does a write plan stop for confirmation?
- Are hosted provider boundaries labeled?
- Is the manifest safe to share?

## Related reading

- Agent registry: `/registry`
- Trust model: `/trust-model`
- Microsoft Graph agent model: `/blog/microsoft-graph-and-ai-agents`
- LLM providers: `/llm-providers`

## LinkedIn draft

The hard part of building a Microsoft 365 admin agent is not the prompt.

It is the boundary.

Before the model, define:

1. The admin question
2. The tenant evidence needed
3. The Microsoft Graph scopes
4. Read-only or write-capable mode
5. The expected output
6. The review gate before writes

A useful agent is a reusable workflow, not a loose chat instruction.

That distinction is what makes it reviewable by another admin.
