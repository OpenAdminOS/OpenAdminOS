import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import {
  compareSemver,
  listRegisteredConnectors,
  ManifestValidationError,
  parseAgentTemplate,
} from "@openadminos/runtime";
import type {
  AgentCommunitySubmissionMetadata,
  AgentCommunitySubmissionReview,
  AgentDraft,
  AgentDraftPreflightResult,
  AgentSummary,
  AgentTemplate,
  AgentUpdateReview,
  AgentUpdateTrustChange,
  RegistryAgentSummary,
  TemplateSetting,
} from "@openadminos/agent-sdk";
import { validatePath, type EndpointSummary } from "./graph-catalog.js";


export const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;




/**
 * Project the user-submitted values onto the manifest's declared settings,
 * coercing where it's safe (numeric string -> integer for type: integer)
 * and rejecting unrecognised types. Unknown ids are dropped.
 */
export function sanitizeSettingsAgainstSchema(
  declared: TemplateSetting[],
  values: Record<string, unknown>,
  slug: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of declared) {
    if (!Object.prototype.hasOwnProperty.call(values, def.id)) continue;
    const raw = values[def.id];
    if (raw === undefined || raw === null) continue;

    switch (def.type) {
      case "integer": {
        const coerced = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(coerced) || !Number.isInteger(coerced)) {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be an integer (got ${JSON.stringify(raw)}).`,
          );
        }
        result[def.id] = coerced;
        break;
      }
      case "string": {
        if (typeof raw !== "string") {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be a string (got ${typeof raw}).`,
          );
        }
        result[def.id] = raw;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be a boolean (got ${typeof raw}).`,
          );
        }
        result[def.id] = raw;
        break;
      }
      default: {
        // Unknown type in the manifest schema — accept the value as-is.
        // A separate slice tightens the schema with JSON Schema export.
        result[def.id] = raw;
      }
    }
  }
  return result;
}



// ─── NL2Agent helpers ─────────────────────────────────────────────────────

/**
 * System prompt for the natural-language → manifest pass. We give the
 * LLM the canonical JSON Schema inline (small and stable enough) and
 * two worked examples so it can pattern-match against the conventions
 * we use in the bundled agents. The temperature is kept low so output
 * stays close to the examples.
 */
export type DraftSkillLike = { id: string; format: string; settings: unknown };



export function collectGraphStepErrors(manifest: { skills: DraftSkillLike[] }): string[] {
  const errors: string[] = [];
  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format === "graph") {
      const settings = skill.settings as {
        method?: string;
        path?: string;
        scopes?: string[];
      } | null;
      if (!settings || typeof settings.method !== "string" || typeof settings.path !== "string") {
        continue;
      }
      const result = validatePath(
        settings.method,
        settings.path,
        Array.isArray(settings.scopes) ? settings.scopes : [],
      );
      if (!result.ok) {
        errors.push(
          `graph step "${skill.id}": ${result.reason}${result.suggestion ? ` (${result.suggestion})` : ""}`,
        );
      }
      continue;
    }

    // Generic graph-write — same catalogue check as reads, but the
    // method+path come from the action template. The legacy
    // retire-managed-device kind has its own hardcoded contract and
    // is skipped here.
    if (skill.format === "write") {
      const settings = skill.settings as {
        kind?: string;
        scopes?: string[];
        actionTemplate?: {
          request?: { method?: string; path?: string };
        };
      } | null;
      if (!settings || settings.kind !== "graph-write") continue;
      const request = settings.actionTemplate?.request;
      if (!request || typeof request.method !== "string" || typeof request.path !== "string") {
        continue;
      }
      // The path is templated (e.g. `/users/{{ item.id }}`). The
      // catalogue treats `{...}` segments as wildcards, so we strip
      // Liquid placeholders to a `{}` token before lookup.
      const lookupPath = request.path.replace(/\{\{[^}]+\}\}/g, "{}");
      const result = validatePath(
        request.method,
        lookupPath,
        Array.isArray(settings.scopes) ? settings.scopes : [],
      );
      if (!result.ok) {
        errors.push(
          `write step "${skill.id}": ${result.reason}${result.suggestion ? ` (${result.suggestion})` : ""}`,
        );
      }
    }
  }
  return errors;
}



export function collectConnectorStepErrors(manifest: {
  descriptor: {
    connectors?: Array<{
      id: string;
      capabilities: Array<{ id: string; version: number }>;
    }>;
  };
  skills: DraftSkillLike[];
}): string[] {
  const errors: string[] = [];
  const requirements = new Map(
    (manifest.descriptor.connectors ?? []).map((connector) => [
      connector.id,
      connector,
    ]),
  );

  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format !== "connector") continue;
    const settings = skill.settings as {
      connector?: string;
      capability?: string;
      version?: number;
    } | null;
    if (!settings?.connector || !settings.capability) continue;

    const requirement = requirements.get(settings.connector);
    if (!requirement) {
      errors.push(
        `connector step "${skill.id}": descriptor.connectors must declare "${settings.connector}".`,
      );
      continue;
    }

    const version = settings.version ?? 1;
    const hasCapability = requirement.capabilities.some(
      (capability) =>
        capability.id === settings.capability && capability.version === version,
    );
    if (!hasCapability) {
      errors.push(
        `connector step "${skill.id}": descriptor.connectors.${settings.connector} must declare capability "${settings.capability}" version ${version}.`,
      );
    }
  }

  return errors;
}



export function* iterateDraftSkills(skills: DraftSkillLike[]): Iterable<DraftSkillLike> {
  for (const skill of skills) {
    yield skill;
    if (skill.format !== "map") continue;
    const settings = skill.settings as { do?: DraftSkillLike[] } | null;
    if (Array.isArray(settings?.do)) {
      yield* iterateDraftSkills(settings.do);
    }
  }
}



export const WRITEY_KEYWORDS = [
  "disable",
  "delete",
  "remove",
  "retire",
  "wipe",
  "revoke",
  "reset",
  "assign",
  "unassign",
  "update",
  "patch",
  "create",
  "add",
  "enable",
  "block",
  "unblock",
  "restore",
];



export function promptLooksWritey(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return WRITEY_KEYWORDS.some((keyword) =>
    new RegExp(`\\b${keyword}\\b`).test(lower),
  );
}



export function validateAgentDraftSource(
  yamlSource: string,
  reservedSlugs: string[] = [],
): AgentDraft {
  const source = typeof yamlSource === "string" ? yamlSource.trim() : "";
  if (source.length === 0) {
    return {
      yamlSource: "",
      validationErrors: ["Manifest YAML is empty."],
    };
  }

  let manifest: AgentDraft["manifest"];
  const validationErrors: string[] = [];
  try {
    manifest = parseAgentTemplate(source);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      validationErrors.push(error.message);
    } else if (error instanceof Error) {
      validationErrors.push(error.message);
    } else {
      validationErrors.push(String(error));
    }
  }

  if (manifest && !manifest.skills.some((skill) => skill.format === "llm")) {
    validationErrors.push(
      "Manifest has no `format: llm` step. OpenAdminOS requires every agent to invoke the LLM at least once — add a summary or rationale step.",
    );
    manifest = undefined;
  }

  if (manifest) {
    const reserved = new Set(reservedSlugs);
    const slug = manifest.descriptor.id;
    if (!AGENT_SLUG_RE.test(slug)) {
      validationErrors.push(
        `Slug "${slug}" is invalid. Use lowercase letters, numbers, and single hyphens only, for example "inactive-device-review".`,
      );
      manifest = undefined;
    } else if (reserved.has(slug)) {
      validationErrors.push(
        `Slug "${slug}" is already used by another agent. Try "${suggestAvailableSlug(slug, reserved)}" instead.`,
      );
      manifest = undefined;
    }
  }

  if (manifest) {
    const semanticErrors = [
      ...collectGraphStepErrors(manifest),
      ...collectConnectorStepErrors(manifest),
    ];
    if (semanticErrors.length > 0) {
      validationErrors.push(...semanticErrors);
      manifest = undefined;
    }
  }

  return validationErrors.length > 0
    ? { yamlSource: source, validationErrors }
    : { yamlSource: `${source}\n`, manifest, validationErrors: [] };
}



export function assertValidAgentSlug(slug: string): void {
  if (!AGENT_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid agent slug "${slug}". Use lowercase letters, numbers, and single hyphens only.`,
    );
  }
}



export function safeUserAgentDirectory(userAgentsDir: string, slug: string): string {
  assertValidAgentSlug(slug);
  const root = resolve(userAgentsDir);
  const target = resolve(root, slug);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || rel.length === 0) {
    throw new Error(`Invalid user agent directory for slug "${slug}".`);
  }
  return target;
}



export function collectManifestScopes(manifest: AgentTemplate): string[] {
  const scopes = new Set<string>();
  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format === "graph" || skill.format === "write") {
      const settings = skill.settings as { scopes?: string[] };
      if (Array.isArray(settings.scopes)) {
        for (const scope of settings.scopes) scopes.add(scope);
      }
    }
  }
  return [...scopes].sort();
}



export function preflightConnectorRequirements(
  manifest: AgentTemplate,
): AgentDraftPreflightResult["checks"] {
  const requirements = manifest.descriptor.connectors ?? [];
  if (requirements.length === 0) {
    return [
      {
        id: "connectors",
        label: "Connectors",
        status: "pass",
        detail: "No connector egress declared.",
      },
    ];
  }

  const registered = new Map(
    listRegisteredConnectors().map((descriptor) => [
      descriptor.id,
      descriptor,
    ]),
  );

  return requirements.map((requirement) => {
    const descriptor = registered.get(requirement.id);
    if (!descriptor) {
      return {
        id: `connector:${requirement.id}`,
        label: `Connector: ${requirement.id}`,
        status: "fail",
        detail: "Connector is not registered in this OpenAdminOS build.",
      };
    }

    const missing = requirement.capabilities.filter(
      (needed) =>
        !descriptor.capabilities.some(
          (actual) =>
            actual.id === needed.id && actual.version === needed.version,
        ),
    );
    if (missing.length > 0) {
      return {
        id: `connector:${requirement.id}`,
        label: `Connector: ${descriptor.name}`,
        status: "fail",
        detail: `Missing capability ${missing.map((cap) => `${cap.id}@${cap.version}`).join(", ")}.`,
      };
    }

    return {
      id: `connector:${requirement.id}`,
      label: `Connector: ${descriptor.name}`,
      status: requirement.required ? "warn" : "pass",
      detail: requirement.required
        ? "Required connector is supported by this build. Configure and test it from Connectors before running this agent."
        : "Optional connector is understood by this build.",
    };
  });
}



export function buildAgentReadme(manifest: AgentTemplate): string {
  const scopes = collectManifestScopes(manifest);
  const connectors = manifest.descriptor.connectors ?? [];
  return `# ${manifest.descriptor.name}

${manifest.descriptor.description}

## Mode

${manifest.descriptor.mode === "write" ? "Write agent. Every write action pauses for typed confirmation before Graph changes are applied." : "Read-only agent. It does not mutate tenant state."}

## Graph permissions

${scopes.length > 0 ? scopes.map((scope) => `- \`${scope}\``).join("\n") : "- None declared"}

## Connectors

${connectors.length > 0 ? connectors.map((connector) => `- \`${connector.id}\` (${connector.required ? "required" : "optional"})`).join("\n") : "- None"}

## Local-first note

This bundle was exported from OpenAdminOS. It includes only agent source files and metadata. It does not include tenant data, prompts, run results, provider settings, tokens, or secrets.
`;
}



export function buildCommunityAgentReadme(
  manifest: AgentTemplate,
  metadata: AgentCommunitySubmissionMetadata,
): string {
  const scopes = collectManifestScopes(manifest);
  const connectors = manifest.descriptor.connectors ?? [];
  return `# ${metadata.name.trim() || manifest.descriptor.name}

${metadata.description.trim() || manifest.descriptor.description}

## Maintainer

- ${metadata.maintainerName.trim() || "Not provided"}
- Support: ${metadata.supportUrl.trim() || "Not provided"}

## Mode

${manifest.descriptor.mode === "write" ? "Write agent. Every write action pauses for typed confirmation before Graph changes are applied." : "Read-only agent. It does not mutate tenant state."}

## Graph permissions

${scopes.length > 0 ? scopes.map((scope) => `- \`${scope}\``).join("\n") : "- None declared"}

## Connectors

${connectors.length > 0 ? connectors.map((connector) => `- \`${connector.id}\` (${connector.required ? "required" : "optional"})`).join("\n") : "- None"}

## Privacy and egress

${metadata.privacyNotes.trim() || "No additional privacy or egress notes provided."}

## Changelog

${metadata.changelog.trim() || "- Initial community submission."}

## Submission note

This bundle was prepared by OpenAdminOS for public community review. It includes only agent source files and metadata. It does not include tenant data, prompts, run results, provider settings, tokens, or secrets.
`;
}



export function buildAgentBundleMetadata(manifest: AgentTemplate) {
  return {
    schema: "openadminos-agent-bundle/v1",
    exportedAt: new Date(0).toISOString(),
    agent: {
      id: manifest.descriptor.id,
      name: manifest.descriptor.name,
      version: manifest.descriptor.version,
      mode: manifest.descriptor.mode,
      category: manifest.descriptor.category,
      scopes: collectManifestScopes(manifest),
      connectors: manifest.descriptor.connectors ?? [],
    },
    files: ["manifest.yaml", "README.md", "metadata.json"],
    excludes: [
      "tenant data",
      "run history",
      "prompts",
      "provider settings",
      "tokens",
      "secrets",
    ],
  };
}



export function buildCommunitySubmissionMetadata(
  manifest: AgentTemplate,
  metadata: AgentCommunitySubmissionMetadata,
) {
  return {
    schema: "openadminos-agent-community-submission/v1",
    submittedAt: new Date(0).toISOString(),
    agent: {
      id: manifest.descriptor.id,
      name: metadata.name.trim() || manifest.descriptor.name,
      description: metadata.description.trim() || manifest.descriptor.description,
      version: manifest.descriptor.version,
      mode: manifest.descriptor.mode,
      category: metadata.category || manifest.descriptor.category,
      scopes: collectManifestScopes(manifest),
      connectors: manifest.descriptor.connectors ?? [],
    },
    maintainer: {
      name: metadata.maintainerName.trim(),
      supportUrl: metadata.supportUrl.trim(),
    },
    privacyNotes: metadata.privacyNotes.trim(),
    changelog: metadata.changelog.trim(),
    excludes: [
      "tenant data",
      "run history",
      "prompts",
      "provider settings",
      "tokens",
      "secrets",
    ],
  };
}



export function buildAgentCommunitySubmissionReview(
  yamlSource: string,
  metadata: AgentCommunitySubmissionMetadata,
  draft: AgentDraft,
): AgentCommunitySubmissionReview {
  const checks: AgentCommunitySubmissionReview["checks"] = [];
  const manifest = draft.manifest;

  checks.push({
    id: "metadata-name",
    label: "Agent name",
    status: metadata.name.trim().length >= 3 ? "pass" : "fail",
    detail:
      metadata.name.trim().length >= 3
        ? "Name is present."
        : "Agent name is missing or too short.",
    fix: "Use a clear public name, for example `Inactive device reviewer`.",
  });
  checks.push({
    id: "metadata-description",
    label: "Description",
    status: metadata.description.trim().length >= 20 ? "pass" : "fail",
    detail:
      metadata.description.trim().length >= 20
        ? "Description is present."
        : "Description needs enough context for maintainers.",
    fix: "Describe what the agent reads, what it reports, and when an admin should use it.",
  });
  checks.push({
    id: "metadata-maintainer",
    label: "Maintainer",
    status: metadata.maintainerName.trim().length >= 2 ? "pass" : "fail",
    detail:
      metadata.maintainerName.trim().length >= 2
        ? "Maintainer name is present."
        : "Maintainer name is required for review follow-up.",
    fix: "Add your display name or organization name.",
  });
  checks.push(validateSupportUrl(metadata.supportUrl));
  checks.push({
    id: "license",
    label: "License",
    status: metadata.licenseConfirmed ? "pass" : "fail",
    detail: metadata.licenseConfirmed
      ? "MIT contribution confirmation is checked."
      : "Community submissions must be contributed under the project license.",
    fix: "Confirm that you can submit this agent under the MIT license.",
  });
  checks.push({
    id: "privacy-notes",
    label: "Privacy notes",
    status: metadata.privacyNotes.trim().length >= 10 ? "pass" : "fail",
    detail:
      metadata.privacyNotes.trim().length >= 10
        ? "Privacy and egress notes are present."
        : "Privacy and egress notes are missing.",
    fix: "State what data the agent reads and whether it uses connectors or hosted providers.",
  });

  if (!manifest) {
    checks.push({
      id: "manifest",
      label: "Manifest",
      status: "fail",
      detail: draft.validationErrors.join("; ") || "Manifest failed validation.",
      fix: "Open Edit, fix the YAML validation errors, then run QA again.",
    });
    return finalizeCommunitySubmissionReview(yamlSource, metadata, undefined, checks);
  }

  checks.push({
    id: "manifest",
    label: "Manifest",
    status: draft.validationErrors.length === 0 ? "pass" : "fail",
    detail:
      draft.validationErrors.length === 0
        ? "Schema, Graph endpoints, scopes, connector declarations, and LLM-step checks pass."
        : draft.validationErrors.join("; "),
    fix: "Open Edit, fix the YAML validation errors, then run QA again.",
  });
  checks.push({
    id: "metadata-category",
    label: "Category",
    status: metadata.category === manifest.descriptor.category ? "pass" : "fail",
    detail:
      metadata.category === manifest.descriptor.category
        ? "Submission category matches the manifest."
        : `Submission category "${metadata.category}" does not match manifest category "${manifest.descriptor.category}".`,
    fix: "Edit the manifest descriptor.category or choose the matching category before submitting.",
  });

  const writeSteps = manifest.skills.filter((skill) => skill.format === "write");
  checks.push({
    id: "write-confirmation",
    label: "Write confirmation",
    status:
      manifest.descriptor.mode === "write" && writeSteps.length === 0 ? "fail" : "pass",
    detail:
      writeSteps.length > 0
        ? `${writeSteps.length} write step(s) will use typed confirmation.`
        : manifest.descriptor.mode === "write"
          ? "Write agent declares no write step."
          : "Read-only agent has no write steps.",
    fix: "Declare write actions with a confirmation phrase, or change the manifest mode to read.",
  });

  const connectors = manifest.descriptor.connectors ?? [];
  checks.push({
    id: "connectors",
    label: "Connector declarations",
    status: connectors.length > 0 ? "warn" : "pass",
    detail:
      connectors.length > 0
        ? `${connectors.length} connector declaration(s) will be highlighted for maintainer review.`
        : "No connector egress declared.",
    fix: "If connector egress is not intentional, remove the connector declaration and steps.",
  });

  const highRiskScopes = collectManifestScopes(manifest).filter(isHighRiskScope);
  checks.push({
    id: "security-scopes",
    label: "Security flags",
    status:
      highRiskScopes.length > 0 || writeSteps.length > 0 || connectors.length > 0
        ? "warn"
        : "pass",
    detail:
      highRiskScopes.length > 0
        ? `High-risk scope(s) require maintainer review: ${highRiskScopes.join(", ")}.`
        : writeSteps.length > 0
          ? "Write actions require maintainer review."
          : connectors.length > 0
            ? "External connector egress requires maintainer review."
            : "No high-risk scopes, write actions, or connector egress detected.",
    fix: "Keep scopes as narrow as possible and explain why each write or connector action is needed.",
  });

  const secretMatches = findSecretLikeValues(
    [
      yamlSource,
      metadata.name,
      metadata.description,
      metadata.maintainerName,
      metadata.supportUrl,
      metadata.privacyNotes,
      metadata.changelog,
    ].join("\n"),
  );
  checks.push({
    id: "secrets",
    label: "Secret scan",
    status: secretMatches.length === 0 ? "pass" : "fail",
    detail:
      secretMatches.length === 0
        ? "No obvious token, key, password, or tenant-id values found."
        : `Possible secret-like text found: ${secretMatches.join(", ")}.`,
    fix: "Remove tokens, tenant IDs, client secrets, API keys, and environment-specific values before submitting.",
  });

  const readme = buildCommunityAgentReadme(manifest, metadata);
  checks.push({
    id: "readme",
    label: "README",
    status: readme.length > 200 ? "pass" : "fail",
    detail:
      readme.length > 200
        ? "README can be generated from the agent and metadata."
        : "README is too short for review.",
    fix: "Fill in description, privacy notes, and changelog, then run QA again.",
  });

  checks.push({
    id: "public-issue",
    label: "Public issue",
    status: "pass",
    detail: "Submission will create a public GitHub issue for maintainer review.",
  });

  return finalizeCommunitySubmissionReview(yamlSource, metadata, manifest, checks);
}



export function finalizeCommunitySubmissionReview(
  yamlSource: string,
  metadata: AgentCommunitySubmissionMetadata,
  manifest: AgentTemplate | undefined,
  checks: AgentCommunitySubmissionReview["checks"],
): AgentCommunitySubmissionReview {
  const fallbackName = metadata.name.trim() || "New agent";
  const issueTitle = `[New Agent] ${manifest?.descriptor.name ?? fallbackName}`;
  const readmeMarkdown = manifest
    ? buildCommunityAgentReadme(manifest, metadata)
    : `# ${fallbackName}\n\n${metadata.description.trim()}\n`;
  const metadataJson = JSON.stringify(
    manifest
      ? buildCommunitySubmissionMetadata(manifest, metadata)
      : { schema: "openadminos-agent-community-submission/v1", agent: { name: fallbackName } },
    null,
    2,
  );
  const issueBody = buildCommunityIssueBody({
    metadata,
    manifest,
    yamlSource,
    readmeMarkdown,
    metadataJson,
    checks,
  });
  const blockingFailures = checks.some((check) => check.status === "fail");
  const bodyTooLarge = issueBody.length > 58_000;
  if (bodyTooLarge) {
    checks.push({
      id: "issue-size",
      label: "Issue size",
      status: "fail",
      detail: "Submission is too large for a GitHub issue.",
      fix: "Shorten long prompt text, comments, descriptions, or embedded examples in the manifest.",
    });
  }
  return {
    ok: !blockingFailures && !bodyTooLarge,
    checks,
    issueTitle,
    issueBody,
    package: {
      manifestYaml: `${yamlSource.trimEnd()}\n`,
      readmeMarkdown,
      metadataJson: `${metadataJson}\n`,
    },
  };
}



export function validateSupportUrl(
  supportUrl: string,
): AgentCommunitySubmissionReview["checks"][number] {
  const trimmed = supportUrl.trim();
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return {
      id: "support",
      label: "Support contact",
      status: "pass",
      detail: "GitHub handle is present.",
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
      return {
        id: "support",
        label: "Support contact",
        status: "pass",
        detail: "Support URL is valid.",
      };
    }
  } catch {
    // handled below
  }
  return {
    id: "support",
    label: "Support contact",
    status: "fail",
    detail: "Support contact must be a GitHub handle or HTTPS URL.",
    fix: "Use `@handle` or an HTTPS URL maintainers can use for follow-up.",
  };
}



export function buildCommunityIssueBody(input: {
  metadata: AgentCommunitySubmissionMetadata;
  manifest: AgentTemplate | undefined;
  yamlSource: string;
  readmeMarkdown: string;
  metadataJson: string;
  checks: AgentCommunitySubmissionReview["checks"];
}): string {
  const manifest = input.manifest;
  const scopes = manifest ? collectManifestScopes(manifest) : [];
  const connectors = manifest?.descriptor.connectors ?? [];
  const writeSteps = manifest?.skills.filter((skill) => skill.format === "write") ?? [];
  const checkLines = input.checks
    .map((check) => `- [${check.status === "fail" ? " " : "x"}] ${check.label}: ${check.detail}`)
    .join("\n");
  return `## Summary

${input.metadata.description.trim()}

## Metadata

- Name: ${input.metadata.name.trim()}
- Category: ${input.metadata.category}
- Maintainer: ${input.metadata.maintainerName.trim()}
- Support: ${input.metadata.supportUrl.trim()}
- License confirmed: ${input.metadata.licenseConfirmed ? "yes" : "no"}

## Agent

- Slug: ${manifest?.descriptor.id ?? "Unavailable"}
- Version: ${manifest?.descriptor.version ?? "Unavailable"}
- Mode: ${manifest?.descriptor.mode ?? "Unavailable"}
- Graph scopes: ${scopes.length > 0 ? scopes.map((scope) => `\`${scope}\``).join(", ") : "None declared"}
- Write steps: ${writeSteps.length}
- Connectors: ${connectors.length > 0 ? connectors.map((connector) => `\`${connector.id}\``).join(", ") : "None"}

## Privacy and egress

${input.metadata.privacyNotes.trim()}

## Changelog

${input.metadata.changelog.trim() || "- Initial community submission."}

## Local QA

${checkLines}

## Submitted files

<details>
<summary>manifest.yaml</summary>

\`\`\`yaml
${input.yamlSource.trimEnd()}
\`\`\`
</details>

<details>
<summary>README.md</summary>

\`\`\`md
${input.readmeMarkdown.trimEnd()}
\`\`\`
</details>

<details>
<summary>metadata.json</summary>

\`\`\`json
${input.metadataJson.trimEnd()}
\`\`\`
</details>

## Exclusion statement

This submission was prepared by OpenAdminOS. It must not include tenant data, prompts, run history, provider settings, tokens, or secrets.
`;
}



export function isHighRiskScope(scope: string): boolean {
  return (
    scope.includes("ReadWrite") ||
    scope.includes("Privileged") ||
    scope.endsWith(".All") && /Directory|User|Application/.test(scope)
  );
}



export function findSecretLikeValues(source: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["password", /\bpassword\s*[:=]\s*["']?[^"'\s]{6,}/i],
    ["secret", /\b(client[_-]?secret|secret)\s*[:=]\s*["']?[^"'\s]{8,}/i],
    ["api key", /\b(api[_-]?key|token)\s*[:=]\s*["']?[^"'\s]{12,}/i],
    ["tenant id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const matches = new Set<string>();
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) matches.add(label);
  }
  return [...matches];
}



export function suggestAvailableSlug(baseSlug: string, reservedSlugs: Set<string>): string {
  const base = baseSlug.replace(/-\d+$/, "") || "custom-agent";
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!reservedSlugs.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}



export function formatCandidates(candidates: EndpointSummary[]): string {
  if (candidates.length === 0) return "(none)";
  return candidates
    .map((ep) => {
      const scope =
        ep.scopesDelegated.length > 0
          ? ep.scopesDelegated[0]
          : "(no delegated scope documented)";
      const summary = ep.summary ? ` — ${ep.summary}` : "";
      return `- ${ep.method} ${ep.path} | scope: ${scope}${summary}`;
    })
    .join("\n");
}



export function buildNl2AgentSystemPrompt(
  readCandidates: EndpointSummary[],
  writeCandidates: EndpointSummary[] = [],
  reservedSlugs: string[] = [],
): string {
  const readBlock =
    readCandidates.length === 0
      ? "(No catalogue match for this prompt. Pick `GET /deviceManagement/managedDevices` if no better fit exists — it is always available.)"
      : formatCandidates(readCandidates);

  const writeBlock =
    writeCandidates.length === 0
      ? ""
      : `\n\nCandidate write endpoints (use these for a \`graph-write\` step — declare the listed scope):\n${formatCandidates(writeCandidates)}`;

  const reservedSlugBlock =
    reservedSlugs.length === 0
      ? "(none)"
      : reservedSlugs.slice(0, 80).map((slug) => `- ${slug}`).join("\n");

  return `You generate Agent Template manifests for OpenAdminOS — a desktop tool that runs AI agents against a Microsoft 365 tenant.

The manifest is a YAML document with three top-level keys: descriptor, skills, definition.

Hard rules:
- mode is "read" unless the user explicitly asks for a destructive (write) agent.
- category must be one of: devices, apps, policies, compliance, updates.
- Slug ids are lower-case hyphen-separated, e.g. "find-inactive-devices".
- Do not reuse any reserved slug listed below. Pick a specific new slug such as "inactive-device-risk-review" rather than "test-agent".
- New user-authored drafts start at version: 0.1.0. Use SemVer exactly.
- Skill ids are lower-case snake_case, e.g. "load_devices".
- Graph steps: pick the closest match from the candidate endpoints listed below. Do not invent endpoints — if none of the candidates fit, fall back to GET /deviceManagement/managedDevices. Always declare the scope shown alongside the endpoint.
- Query values must be YAML strings, including numeric-looking OData values. Example: $top: "25".
- Transform kinds available: group-by-age, filter-by-age, count-by-field, group-by-field, sort-by, correlate-stale-devices.
- Use definition.settings for user-adjustable values. Reference them as {{ settings.settingId }}. Supported setting types: string, integer, boolean.
- Use a scheduled trigger only when the user asks for recurring checks. Always include a manual trigger too.
- Use a map step when the user asks for per-item triage/rationale/classification. Put the per-item LLM step inside settings.do and add a small limit, e.g. limit: 25.
- Use LLM inputs when the prompt consumes multiple prior outputs: inputs: { devices: "{{ load_devices.output }}", counts: "{{ by_state.output }}" }.
- Use connector steps only when the user explicitly asks to send/post results to Teams. Then merge a descriptor.connectors array into the single top-level descriptor and use a connector step with capability post-channel-message version 1.
- EVERY agent MUST include at least one step with format: llm. This is what makes it an agent rather than a deterministic query — the LLM writes the headline summary an admin reads. Do not gate it with "when:". The runtime preflights the provider and fails the run if one isn't connected, so the gate is unnecessary and misleading.
- definition.result.summary MUST reference the LLM step's output, e.g.: {{ summarize.output.text | default("Summary unavailable.") }}. Do not put raw counts in the summary line — those belong in result.data.
- Write-action kinds available: \`graph-write\` (the generic kind — any POST/PATCH/PUT/DELETE Graph endpoint, with typed-confirmation diff) and \`retire-managed-device\` (legacy alias for POST /deviceManagement/managedDevices/{id}/retire). Always prefer \`graph-write\` for new agents. For write agents, the LLM step should explain the planned actions in plain language and the write step's actionTemplate.label / actionTemplate.description should make every individual action self-explanatory. \`severity: destructive\` is the safe default unless the action is plainly reversible.
- The confirmationPhrase must spell out the operation count and noun in CAPS, e.g. "DISABLE {{ actions | size }} GUEST ACCOUNTS" or "REVOKE {{ actions | size }} SESSIONS". This is what the admin types to approve the plan.
- Templating uses Liquid-subset {{ path.expr | filter }}. Filters available: size, total, sample(n), default("…"), join(", ").
- Always include a top-level "# yaml-language-server: $schema=../../schemas/agent-template.schema.json" comment.

Reserved slugs you must not use:
${reservedSlugBlock}

Candidate Microsoft Graph read endpoints for this prompt (pick from these for graph steps — declare the listed scope):
${readBlock}${writeBlock}

Reference example — read agent, bucketed by compliance state, LLM summary as headline:

# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: compliance-overview
  name: Compliance overview
  description: Counts Intune-managed devices by compliance state and writes a plain-language posture summary.
  version: 0.1.0
  author:
    name: OpenAdminOS
    handle: openadminos
    verified: false
  category: compliance
  mode: read
  preferredModel: llama3.1:8b
skills:
  - id: load_devices
    format: graph
    label: Load managed device inventory
    detail: Reads managedDevices from the active tenant.
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      select: [id, deviceName, userPrincipalName, operatingSystem, complianceState, lastSyncDateTime]
      scopes:
        - DeviceManagementManagedDevices.Read.All
  - id: by_state
    format: transform
    label: Count devices by compliance state
    settings:
      kind: count-by-field
      source: "{{ load_devices.output }}"
      field: complianceState
      buckets: [compliant, noncompliant, unknown]
  - id: summarize
    format: llm
    label: Summarize compliance posture
    detail: Two-sentence executive summary plus one prioritised action.
    settings:
      system: >-
        You are a Microsoft 365 administrator's assistant. Be concise and
        factual. Two sentences plus one prioritised action. Never invent
        numbers — use only the figures you are given.
      prompt: |-
        Total devices: {{ load_devices.output | size }}.
        Compliant: {{ by_state.output.compliant }}.
        Noncompliant: {{ by_state.output.noncompliant }}.
        Unknown: {{ by_state.output.unknown }}.

        Write an executive summary. Lead with the biggest risk, then one
        short prioritised action.
      temperature: 0.2
      maxTokens: 200
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: '{{ summarize.output.text | default("Summary unavailable.") }}'
    data:
      total: "{{ load_devices.output | size }}"
      counts: "{{ by_state.output }}"
      llmModel: "{{ summarize.output.model }}"

Pattern snippet — per-item map step with an inner LLM classifier:

  - id: triage_items
    format: map
    label: Classify each risky item
    settings:
      source: "{{ load_items.output }}"
      as: item
      limit: 25
      do:
        - id: classify
          format: llm
          label: Classify this item
          settings:
            system: You are a Microsoft 365 administrator's assistant. Return concise JSON-like text.
            prompt: |-
              Classify this item as likely false positive, likely issue, or unclear.
              Item: {{ item }}
            temperature: 0.1
            maxTokens: 180

Pattern snippet — optional Teams connector delivery when explicitly requested:

descriptor:
  connectors:
    - id: teams
      minVersion: 1.0.0
      required: false
      capabilities:
        - id: post-channel-message
          version: 1
skills:
  - id: post_to_teams
    format: connector
    label: Post report to Teams
    when: ctx.connectors.teams.available
    settings:
      connector: teams
      capability: post-channel-message
      version: 1
      args:
        markdown: "{{ summarize.output.text }}"

Reference example — write agent using graph-write to disable inactive guest users:

# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: disable-inactive-guests
  name: Disable inactive guest accounts
  description: Disables guest accounts that have not signed in for 90+ days after typed diff confirmation.
  version: 0.1.0
  author:
    name: OpenAdminOS
    handle: openadminos
    verified: false
  category: policies
  mode: write
  preferredModel: llama3.1:8b
skills:
  - id: load_guests
    format: graph
    label: Load guest accounts
    settings:
      method: GET
      path: /users
      query:
        $filter: "userType eq 'Guest'"
      select: [id, displayName, userPrincipalName, accountEnabled, signInActivity]
      scopes:
        - User.Read.All
        - AuditLog.Read.All
  - id: stale
    format: transform
    label: Pick guests inactive for 90+ days
    settings:
      kind: filter-by-age
      source: "{{ load_guests.output }}"
      timestampField: signInActivity.lastSignInDateTime
      inactiveDaysAtLeast: 90
  - id: explain_plan
    format: llm
    label: Explain the disable plan
    settings:
      system: You are a Microsoft 365 administrator's assistant. Be concise and factual. Never invent numbers.
      prompt: |-
        About to disable {{ stale.output | size }} guest accounts that have
        not signed in for 90+ days. Write a one-paragraph rationale a
        manager could read before approving.
      temperature: 0.2
      maxTokens: 200
  - id: disable_guests
    format: write
    label: Disable inactive guest accounts
    settings:
      kind: graph-write
      source: "{{ stale.output }}"
      confirmationPhrase: "DISABLE {{ actions | size }} GUEST ACCOUNTS"
      scopes:
        - User.ReadWrite.All
      actionTemplate:
        label: "Disable {{ item.userPrincipalName }}"
        description: "Last sign-in {{ item.signInActivity.lastSignInDateTime | default('never') }}"
        severity: destructive
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: '{{ explain_plan.output.text | default("Summary unavailable.") }}'
    data:
      total: "{{ stale.output | size }}"
      llmModel: "{{ explain_plan.output.model }}"

When the user's description is vague, pick sensible defaults and continue — don't ask clarifying questions. When you cannot fulfil a request inside the available endpoints / transforms, choose the closest supported shape rather than inventing new mechanisms.

Output: a single YAML manifest. Nothing else.`;
}



export function buildNl2AgentRepairPrompt(
  originalDescription: string,
  failedDraft: AgentDraft,
): string {
  return `Repair this OpenAdminOS manifest.yaml so it passes validation.

Original user description:
"""
${originalDescription}
"""

Validation errors:
${failedDraft.validationErrors.map((error) => `- ${error}`).join("\n")}

YAML to repair:
"""
${failedDraft.yamlSource}
"""

Return ONLY the corrected YAML manifest. Do not include commentary, headings, or markdown fences.`;
}



export function stripCodeFences(source: string): string {
  // The LLM sometimes wraps output in \`\`\`yaml fences despite the system
  // prompt. Strip a leading and trailing fence if present so the
  // parser sees pure YAML.
  let s = source.trim();
  if (s.startsWith("\`\`\`")) {
    const firstNewline = s.indexOf("\n");
    if (firstNewline >= 0) s = s.slice(firstNewline + 1);
    else s = s.slice(3);
  }
  if (s.endsWith("\`\`\`")) {
    s = s.slice(0, -3);
  }
  return s.trim();
}



export function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}



export function buildAgentProvenance(input: {
  agent: RegistryAgentSummary;
  installedAt: string;
  updatedAt?: string;
  manifestText?: string;
  manifestSha256?: string;
  source?: "registry" | "bundled" | "user";
}): NonNullable<AgentSummary["provenance"]> {
  const source =
    input.source ??
    (input.agent.manifestUrl
      ? "registry"
      : input.agent.registryPath?.includes("user-agents")
        ? "user"
        : "bundled");
  return {
    source,
    ...(input.agent.manifestUrl ? { manifestUrl: input.agent.manifestUrl } : {}),
    ...(input.agent.registryPath ? { registryPath: input.agent.registryPath } : {}),
    ...(input.manifestSha256
      ? { manifestSha256: input.manifestSha256 }
      : input.manifestText
        ? { manifestSha256: sha256(input.manifestText) }
        : input.agent.manifestSha256
          ? { manifestSha256: input.agent.manifestSha256 }
          : {}),
    installedVersion: input.agent.version,
    installedAt: input.installedAt,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.agent.manifestUrl
      ? { registryRef: extractRegistryRef(input.agent.manifestUrl) }
      : {}),
    ...(input.agent.minAppVersion ? { minAppVersion: input.agent.minAppVersion } : {}),
  };
}



export function withAgentCompatibility<T extends { minAppVersion?: string; name?: string }>(
  agent: T,
  appVersion: string,
): T & { compatibility: NonNullable<AgentSummary["compatibility"]> } {
  const minAppVersion = agent.minAppVersion ?? "0.1.0";
  const supported = compareSemver(appVersion, minAppVersion) >= 0;
  return {
    ...agent,
    minAppVersion,
    compatibility: {
      supported,
      appVersion,
      minAppVersion,
      ...(supported
        ? {}
        : {
            reason: `${agent.name ?? "This agent"} requires OpenAdminOS ${minAppVersion} or newer. You are running ${appVersion}.`,
          }),
    },
  };
}



export function assertAgentCompatible(
  agent: { name?: string; compatibility?: AgentSummary["compatibility"] },
  action: "install" | "run" | "update" | "review",
): void {
  if (agent.compatibility?.supported !== false) return;
  const verb =
    action === "install"
      ? "install"
      : action === "run"
        ? "run"
        : action === "update"
          ? "update"
          : "review updates for";
  throw new Error(
    `Update OpenAdminOS to ${agent.compatibility.minAppVersion} before you ${verb} ${agent.name ?? "this agent"}. Current version: ${agent.compatibility.appVersion}.`,
  );
}



export function buildAgentUpdateReview(input: {
  previous: AgentSummary;
  target: RegistryAgentSummary;
  parsedManifest: ReturnType<typeof parseAgentTemplate>;
  manifestText: string;
  manifestSha256: string;
}): AgentUpdateReview {
  const changes: AgentUpdateTrustChange[] = [];
  const previousScopes = new Set(input.previous.scopes);
  const nextScopes = new Set([
    ...input.target.scopes,
    ...collectTemplateScopes(input.parsedManifest.skills),
  ]);
  const addedScopes = [...nextScopes].filter((scope) => !previousScopes.has(scope)).sort();
  if (addedScopes.length > 0) {
    changes.push({
      id: "graph-scopes-added",
      label: "New Graph permissions",
      severity: addedScopes.some(isHighRiskGraphScope) ? "danger" : "warn",
      detail: `Adds ${addedScopes.length} Graph scope${addedScopes.length === 1 ? "" : "s"}: ${addedScopes.join(", ")}.`,
      before: input.previous.scopes.join(", ") || "none",
      after: [...nextScopes].sort().join(", ") || "none",
    });
  }

  const nextWriteKinds = collectWriteKinds(input.parsedManifest.skills);
  if (input.previous.mode !== "write" && input.target.mode === "write") {
    changes.push({
      id: "write-mode-added",
      label: "Write actions enabled",
      severity: "danger",
      detail:
        "This update changes the agent from read-only to write-capable. Runs will require diff confirmation before applying changes.",
      before: input.previous.mode,
      after: input.target.mode,
    });
  } else if (input.previous.mode === "write" && nextWriteKinds.length > 0) {
    changes.push({
      id: "write-actions-reviewed",
      label: "Write action template changed",
      severity: "warn",
      detail: `Review the updated write action kind${nextWriteKinds.length === 1 ? "" : "s"}: ${nextWriteKinds.join(", ")}.`,
      after: nextWriteKinds.join(", "),
    });
  }

  const previousConnectors = new Set(
    (input.previous.connectors ?? []).map((connector) => connector.id),
  );
  const nextConnectors = new Set(
    (input.parsedManifest.descriptor.connectors ?? []).map((connector) => connector.id),
  );
  const addedConnectors = [...nextConnectors]
    .filter((connector) => !previousConnectors.has(connector))
    .sort();
  if (addedConnectors.length > 0) {
    changes.push({
      id: "connector-egress-added",
      label: "New connector egress",
      severity: "danger",
      detail: `Adds external connector access: ${addedConnectors.join(", ")}.`,
      before: [...previousConnectors].sort().join(", ") || "none",
      after: [...nextConnectors].sort().join(", ") || "none",
    });
  }

  const previousMin = input.previous.provenance?.minAppVersion ?? "0.1.0";
  const nextMin = input.target.minAppVersion ?? previousMin;
  if (compareSemver(nextMin, previousMin) > 0) {
    changes.push({
      id: "min-app-version-raised",
      label: "Minimum app version raised",
      severity: "warn",
      detail: `Requires OpenAdminOS ${nextMin} or newer.`,
      before: previousMin,
      after: nextMin,
    });
  }

  if (input.previous.provenance?.manifestSha256 && input.previous.provenance.manifestSha256 !== input.manifestSha256) {
    changes.push({
      id: "manifest-hash-changed",
      label: "Manifest digest changed",
      severity: "info",
      detail: `New SHA-256 digest ${input.manifestSha256.slice(0, 12)}…`,
      before: input.previous.provenance.manifestSha256.slice(0, 12),
      after: input.manifestSha256.slice(0, 12),
    });
  }

  return {
    slug: input.target.slug,
    fromVersion: input.previous.version,
    toVersion: input.target.version,
    manifestUrl: input.target.manifestUrl ?? "",
    manifestSha256: input.manifestSha256,
    requiresConfirmation: changes.some(
      (change) => change.severity === "warn" || change.severity === "danger",
    ),
    changes:
      changes.length > 0
        ? changes
        : [
            {
              id: "metadata-only",
              label: "Metadata-only update",
              severity: "info",
              detail:
                "No new Graph scopes, write actions, connector egress, or app-version requirements detected.",
            },
          ],
  };
}



export function collectTemplateScopes(skills: AgentTemplate["skills"]): string[] {
  const scopes = new Set<string>();
  const visit = (steps: AgentTemplate["skills"]): void => {
    for (const step of steps) {
      const value = (step as { settings?: { scopes?: unknown; do?: unknown } }).settings?.scopes;
      if (Array.isArray(value)) {
        for (const scope of value) {
          if (typeof scope === "string") scopes.add(scope);
        }
      }
      const nested = (step as { settings?: { do?: unknown } }).settings?.do;
      if (Array.isArray(nested)) visit(nested as AgentTemplate["skills"]);
    }
  };
  visit(skills);
  return [...scopes];
}



export function collectWriteKinds(skills: AgentTemplate["skills"]): string[] {
  const kinds = new Set<string>();
  const visit = (steps: AgentTemplate["skills"]): void => {
    for (const step of steps) {
      if (step.format === "write") {
        kinds.add(step.settings.kind);
      }
      const nested = (step as { settings?: { do?: unknown } }).settings?.do;
      if (Array.isArray(nested)) visit(nested as AgentTemplate["skills"]);
    }
  };
  visit(skills);
  return [...kinds].sort();
}



export function isHighRiskGraphScope(scope: string): boolean {
  return /ReadWrite|Privileged|\.All$/i.test(scope) && !/Read\.All$/i.test(scope);
}



export function extractRegistryRef(manifestUrl: string): string | undefined {
  const match = manifestUrl.match(/githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
  return match?.[1];
}



export const __agentDraftTestUtils = {
  validateAgentDraftSource,
  buildNl2AgentSystemPrompt,
  buildAgentCommunitySubmissionReview,
};
