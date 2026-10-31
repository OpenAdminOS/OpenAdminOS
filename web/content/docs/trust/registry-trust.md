---
title: "Registry trust"
description: "How OpenAdminOS treats public agent registry updates."
---

# Registry Trust

The public Agent Hub, reached by selecting **Hub** in the Agents Library, is backed by the OpenAdminOS repository. Public agents are reviewed manifests, not arbitrary TypeScript from an untrusted source.

## Catalog Source

OpenAdminOS downloads the catalog from the configured HTTPS source. Catalog signing
keys are not required. The official catalog retains monotonic revision checks,
and downloaded manifests must match the catalog's SHA-256 digests and declared
trust metadata. These hashes detect mismatches with the catalog; they do not
independently authenticate its publisher. Changing to a custom source still
requires trust review.

Desktop installer signing and macOS notarization are separate and remain enabled.
Older desktop versions that require catalog signatures must be updated before
refreshing the new catalog. Their previously cached catalog can still be used.

## Install Provenance

When a public agent is installed, OpenAdminOS records where it came from: source URL, registry reference, manifest SHA-256 when available, installed version, minimum app version, and install time.

This provenance is used when the app checks for public agent updates.

## Update Review

Registry updates are not silently applied when the trust boundary changes. OpenAdminOS asks for explicit review before applying an update that:

- Adds Microsoft Graph scopes.
- Changes write actions.
- Adds connector egress.
- Raises the required OpenAdminOS version.

If an agent requires a newer OpenAdminOS version, Agent Hub still shows it but blocks install, run, and update application with Update OpenAdminOS copy.

## Accepted Purposes

The public registry accepts agents for IT administration: devices, apps, policies, identities, licences, and tenant configuration. It does not accept agents whose purpose is to evaluate individual workers' performance or behaviour, to prepare employment decisions about them, to recognise emotions, to categorise people by biometric data, or to produce social scores. Account-security and configuration work, such as reviewing Entra risky users or auditing directory changes, stays in scope. See [EU AI Act](eu-ai-act.md) for the reasoning.

## Registry QA

Registry CI rejects malformed or incomplete public agents before they can appear in the generated index. Checks cover duplicate slugs, invalid semver, missing README files, missing LLM steps, undeclared scopes, content-safety issues, and stale generated index output.

Generated agent pages come from reviewed manifest metadata, so the catalog, scope matrix, write safety matrix, and per-agent pages stay aligned with the registry.
