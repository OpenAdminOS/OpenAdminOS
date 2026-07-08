---
title: "Registry trust"
description: "How OpenAdminOS treats public agent registry updates."
---

# Registry Trust

The public Agent Hub, reached from the Hub tab under Agents, is backed by the OpenAdminOS repository. Public agents are reviewed manifests, not arbitrary TypeScript from an untrusted source.

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

## Registry QA

Registry CI rejects malformed or incomplete public agents before they can appear in the generated index. Checks cover duplicate slugs, invalid semver, missing README files, missing LLM steps, undeclared scopes, content-safety issues, and stale generated index output.

Generated GitBook agent pages come from reviewed manifest metadata, so the catalog, scope matrix, write safety matrix, and per-agent pages stay aligned with the registry.
