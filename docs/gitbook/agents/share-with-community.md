---
title: "Share with community"
description: "Submit a local user-authored agent for public OpenAdminOS maintainer review."
---

# Share With Community

Share with community starts a reviewed submission for a user-authored local agent. It does not publish directly to Agent Hub.

The current preview uses public GitHub issue intake. OpenAdminOS sends the validated submission to the OpenAdminOS web API, and the server creates or updates a public `[New Agent]` issue for maintainer review.

## What The Submission Includes

The submission includes the agent manifest, generated README, metadata, maintainer details, support contact, license confirmation, changelog note, privacy and egress notes, and local QA results.

Security review flags call out high-risk Graph scopes, destructive writes, and external connector egress so maintainers can review the trust boundary before accepting the agent.

## What Is Never Included

Sharing does not include tenant data, run history, prompts, provider settings, access tokens, secrets, or local app state.

Secret-like values block submission. Tenant identifiers and personal data are rejected by the local QA gate before the issue can be created.

## Public Review

The created GitHub issue is public. Agent Hub only changes after maintainers accept the submission through the normal repository review path and the generated registry index includes the agent.

Private registry forks and private agent sharing are not part of the v0.2.1 preview.
