import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { load as parseYaml } from "js-yaml";

import { getRedis, keys } from "~/lib/stats/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 120_000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUBMISSION_RATE_WINDOW_SECONDS = 60 * 60;
const SUBMISSION_RATE_MAX_PER_WINDOW = 3;

interface SubmissionPayload {
  metadata: {
    name: string;
    description: string;
    category: string;
    maintainerName: string;
    supportUrl: string;
    licenseConfirmed: boolean;
    privacyNotes: string;
    changelog: string;
  };
  package: {
    manifestYaml: string;
    readmeMarkdown: string;
    metadataJson: string;
  };
}

interface ParsedSubmission {
  metadata: SubmissionPayload["metadata"];
  manifest: ServerManifest;
  manifestYaml: string;
  readmeMarkdown: string;
  metadataJson: string;
  issueTitle: string;
  issueBody: string;
  manifestSha256: string;
}

interface ServerManifest {
  descriptor: {
    id: string;
    name: string;
    description: string;
    version: string;
    category: string;
    mode: "read" | "write";
    connectors?: Array<{ id: string }>;
  };
  skills: ServerSkill[];
}

interface ServerSkill {
  id: string;
  format: string;
  settings?: {
    scopes?: unknown;
    do?: unknown;
    confirmationPhrase?: unknown;
  };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return jsonError(413, "Submission is too large.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  const parsed = parseSubmissionPayload(body);
  if ("error" in parsed) {
    return jsonError(400, parsed.error);
  }

  try {
    const rateLimited = await applySubmissionRateLimit(clientIp(req));
    if (rateLimited) {
      return NextResponse.json(
        { error: "Rate limited. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(SUBMISSION_RATE_WINDOW_SECONDS) },
        },
      );
    }
    const issue = await createAgentSubmissionIssue(parsed.payload);
    return NextResponse.json({
      issueUrl: issue.html_url,
      issueNumber: issue.number,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[agent-submissions] failed:", message);
    return jsonError(500, "Failed to create GitHub issue.");
  }
}

function parseSubmissionPayload(body: unknown): { payload: ParsedSubmission } | { error: string } {
  if (!isObject(body)) return { error: "Body must be a JSON object." };
  if (!isObject(body.metadata)) return { error: "`metadata` is required." };
  if (!isObject(body.package)) return { error: "`package` is required." };

  const metadata = {
    name: stringField(body.metadata.name),
    description: stringField(body.metadata.description),
    category: stringField(body.metadata.category),
    maintainerName: stringField(body.metadata.maintainerName),
    supportUrl: stringField(body.metadata.supportUrl),
    licenseConfirmed: body.metadata.licenseConfirmed === true,
    privacyNotes: stringField(body.metadata.privacyNotes),
    changelog: stringField(body.metadata.changelog),
  };
  const manifestYaml = stringField(body.package.manifestYaml);
  const readmeMarkdown = stringField(body.package.readmeMarkdown);
  const metadataJson = stringField(body.package.metadataJson);

  if (metadata.name.length < 3) return { error: "Agent name is required." };
  if (metadata.description.length < 20) return { error: "Agent description is required." };
  if (metadata.maintainerName.length < 2) return { error: "Maintainer name is required." };
  if (!isKnownCategory(metadata.category)) return { error: "Agent category is invalid." };
  const supportError = validateSupportContact(metadata.supportUrl);
  if (supportError) return { error: supportError };
  if (!metadata.licenseConfirmed) return { error: "License confirmation is required." };
  if (metadata.privacyNotes.length < 10) return { error: "Privacy notes are required." };
  if (findSecretLikeValues([manifestYaml, readmeMarkdown, metadataJson].join("\n")).length > 0) {
    return { error: "Submission contains possible secret-like values." };
  }

  const manifestResult = parseServerManifest(manifestYaml);
  if ("error" in manifestResult) return manifestResult;
  const manifest = manifestResult.manifest;
  if (metadata.category !== manifest.descriptor.category) {
    return { error: "Metadata category must match descriptor.category." };
  }
  const metadataJsonResult = validateMetadataJson(metadataJson, manifest);
  if (metadataJsonResult) return { error: metadataJsonResult };

  const manifestSha256 = sha256(manifestYaml.trimEnd());
  const rebuiltIssueTitle = `[New Agent] ${manifest.descriptor.name}`;
  const rebuiltIssueBody = buildIssueBody({
    metadata,
    manifest,
    manifestYaml,
    readmeMarkdown,
    metadataJson,
    manifestSha256,
  });
  if (rebuiltIssueTitle.length > 180) return { error: "Issue title is too long." };
  if (rebuiltIssueBody.length > 58_000) return { error: "Issue body is too long." };

  return {
    payload: {
      metadata,
      manifest,
      manifestYaml,
      readmeMarkdown,
      metadataJson,
      issueTitle: rebuiltIssueTitle,
      issueBody: rebuiltIssueBody,
      manifestSha256,
    },
  };
}

async function createAgentSubmissionIssue(payload: ParsedSubmission) {
  const token = requireEnv("OPENADMINOS_GITHUB_TOKEN");
  const owner = requireEnv("OPENADMINOS_GITHUB_OWNER");
  const repo = requireEnv("OPENADMINOS_GITHUB_REPO");
  const octokit = new Octokit({ auth: token });
  const existing = await findExistingSubmissionIssue(octokit, {
    owner,
    repo,
    title: payload.issueTitle,
  });
  if (existing) {
    const body = `${payload.issueBody}\n\n---\n\n_Updated submission received. Manifest SHA-256: \`${payload.manifestSha256}\`._\n`;
    const response = await octokit.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      title: payload.issueTitle,
      body,
    });
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: `Updated submission package received for \`${payload.manifest.descriptor.id}\`.\n\nManifest SHA-256: \`${payload.manifestSha256}\``,
    });
    return response.data;
  }

  try {
    const response = await octokit.issues.create({
      owner,
      repo,
      title: payload.issueTitle,
      body: payload.issueBody,
      labels: ["agent-submission", "needs-review"],
    });
    return response.data;
  } catch (error) {
    if (isGithubValidationError(error)) {
      const response = await octokit.issues.create({
        owner,
        repo,
        title: payload.issueTitle,
        body: payload.issueBody,
      });
      return response.data;
    }
    throw error;
  }
}

async function findExistingSubmissionIssue(
  octokit: Octokit,
  input: { owner: string; repo: string; title: string },
) {
  const response = await octokit.issues.listForRepo({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    labels: "agent-submission",
    per_page: 100,
  });
  return response.data.find((issue) => issue.title === input.title);
}

async function applySubmissionRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  const bucket = Math.floor(Date.now() / 1000 / SUBMISSION_RATE_WINDOW_SECONDS);
  const rateKey = keys.agentSubmissionRate(ip, bucket);
  const count = await redis.incr(rateKey);
  if (count === 1) {
    await redis.expire(rateKey, SUBMISSION_RATE_WINDOW_SECONDS);
  }
  return count > SUBMISSION_RATE_MAX_PER_WINDOW;
}

function isGithubValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 422
  );
}

function parseServerManifest(manifestYaml: string): { manifest: ServerManifest } | { error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(manifestYaml);
  } catch {
    return { error: "manifest.yaml must be valid YAML." };
  }
  if (!isObject(raw)) return { error: "manifest.yaml must be a YAML object." };
  if (!isObject(raw.descriptor)) return { error: "manifest descriptor is required." };
  if (!Array.isArray(raw.skills)) return { error: "manifest skills array is required." };

  const descriptor = raw.descriptor;
  const id = stringField(descriptor.id);
  if (!id || !SLUG_RE.test(id)) return { error: "Manifest slug is invalid." };
  const name = stringField(descriptor.name);
  const description = stringField(descriptor.description);
  const version = stringField(descriptor.version);
  const category = stringField(descriptor.category);
  const mode = stringField(descriptor.mode);
  if (name.length < 3) return { error: "descriptor.name is required." };
  if (description.length < 20) return { error: "descriptor.description is required." };
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { error: "descriptor.version must be semver." };
  }
  if (!isKnownCategory(category)) return { error: "descriptor.category is invalid." };
  if (mode !== "read" && mode !== "write") return { error: "descriptor.mode is invalid." };

  const skills = raw.skills as unknown[];
  if (skills.length === 0) return { error: "manifest must declare at least one skill." };
  const parsedSkills: ServerSkill[] = [];
  for (const [index, skill] of skills.entries()) {
    const parsed = parseSkill(skill, `skills[${index}]`);
    if ("error" in parsed) return parsed;
    parsedSkills.push(parsed.skill);
  }
  const flattened = flattenSkills(parsedSkills);
  const hasLlm = flattened.some((skill) => skill.format === "llm");
  if (!hasLlm) return { error: "manifest must include at least one llm skill." };
  const writeSteps = flattened.filter((skill) => skill.format === "write");
  if (mode === "read" && writeSteps.length > 0) {
    return { error: "read-mode manifests cannot declare write steps." };
  }
  if (mode === "write" && writeSteps.length === 0) {
    return { error: "write-mode manifests must declare a write step." };
  }
  for (const step of writeSteps) {
    if (typeof step.settings?.confirmationPhrase !== "string" || step.settings.confirmationPhrase.trim().length === 0) {
      return { error: `write step "${step.id}" must declare confirmationPhrase.` };
    }
  }

  const connectors = Array.isArray(descriptor.connectors)
    ? descriptor.connectors
        .filter(isObject)
        .map((connector) => ({ id: stringField(connector.id) }))
        .filter((connector) => connector.id.length > 0)
    : undefined;

  return {
    manifest: {
      descriptor: {
        id,
        name,
        description,
        version,
        category,
        mode,
        ...(connectors && connectors.length > 0 ? { connectors } : {}),
      },
      skills: parsedSkills,
    },
  };
}

function parseSkill(value: unknown, path: string): { skill: ServerSkill } | { error: string } {
  if (!isObject(value)) return { error: `${path} must be an object.` };
  const id = stringField(value.id);
  const format = stringField(value.format);
  if (!id) return { error: `${path}.id is required.` };
  if (!format) return { error: `${path}.format is required.` };
  const settings = isObject(value.settings) ? value.settings : {};
  let nestedDo: unknown = settings.do;
  if (format === "map") {
    if (!Array.isArray(settings.do) || settings.do.length === 0) {
      return { error: `${path}.settings.do must be a non-empty array.` };
    }
    const parsedChildren: ServerSkill[] = [];
    for (const [index, child] of settings.do.entries()) {
      const parsed = parseSkill(child, `${path}.settings.do[${index}]`);
      if ("error" in parsed) return parsed;
      parsedChildren.push(parsed.skill);
    }
    nestedDo = parsedChildren;
  }
  return {
    skill: {
      id,
      format,
      settings: {
        scopes: settings.scopes,
        do: nestedDo,
        confirmationPhrase: settings.confirmationPhrase,
      },
    },
  };
}

function flattenSkills(skills: ServerSkill[]): ServerSkill[] {
  const flattened: ServerSkill[] = [];
  for (const skill of skills) {
    flattened.push(skill);
    if (skill.format === "map" && Array.isArray(skill.settings?.do)) {
      flattened.push(...flattenSkills(skill.settings.do as ServerSkill[]));
    }
  }
  return flattened;
}

function validateMetadataJson(metadataJson: string, manifest: ServerManifest): string | null {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!isObject(parsed)) return "metadata.json must be a JSON object.";
    const agent = isObject(parsed.agent) ? parsed.agent : undefined;
    const slug = agent ? stringField(agent.slug) || stringField(agent.id) : "";
    if (slug && slug !== manifest.descriptor.id) {
      return "metadata.json agent slug must match manifest descriptor.id.";
    }
    return null;
  } catch {
    return "metadata.json must be valid JSON.";
  }
}

function buildIssueBody(input: {
  metadata: SubmissionPayload["metadata"];
  manifest: ServerManifest;
  manifestYaml: string;
  readmeMarkdown: string;
  metadataJson: string;
  manifestSha256: string;
}): string {
  const scopes = collectScopes(input.manifest);
  const writeSteps = flattenSkills(input.manifest.skills).filter((skill) => skill.format === "write");
  const connectors = input.manifest.descriptor.connectors ?? [];
  return `## Summary

${input.metadata.description}

## Metadata

- Name: ${input.metadata.name}
- Category: ${input.metadata.category}
- Maintainer: ${input.metadata.maintainerName}
- Support: ${input.metadata.supportUrl}
- License confirmed: ${input.metadata.licenseConfirmed ? "yes" : "no"}
- Manifest SHA-256: \`${input.manifestSha256}\`

## Agent

- Slug: ${input.manifest.descriptor.id}
- Version: ${input.manifest.descriptor.version}
- Mode: ${input.manifest.descriptor.mode}
- Graph scopes: ${scopes.length > 0 ? scopes.map((scope) => `\`${scope}\``).join(", ") : "None declared"}
- Write steps: ${writeSteps.length}
- Connectors: ${connectors.length > 0 ? connectors.map((connector) => `\`${connector.id}\``).join(", ") : "None"}

## Privacy and egress

${input.metadata.privacyNotes}

## Changelog

${input.metadata.changelog || "- Initial community submission."}

## Server-side intake checks

- [x] Request body size accepted.
- [x] Metadata fields validated.
- [x] manifest.yaml parsed server-side.
- [x] Slug, mode, category, version, LLM step, and write-confirmation requirements validated.
- [x] metadata.json parsed server-side.
- [x] Secret-like values rejected by intake scan.

## Submitted files

<details>
<summary>manifest.yaml</summary>

\`\`\`yaml
${input.manifestYaml.trimEnd()}
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

This submission was accepted by the OpenAdminOS intake endpoint. It must not include tenant data, prompts, run history, provider settings, tokens, or secrets.
`;
}

function collectScopes(manifest: ServerManifest): string[] {
  const scopes = new Set<string>();
  for (const skill of flattenSkills(manifest.skills)) {
    const value = skill.settings?.scopes;
    if (!Array.isArray(value)) continue;
    for (const scope of value) {
      if (typeof scope === "string" && scope.trim().length > 0) scopes.add(scope.trim());
    }
  }
  return [...scopes].sort();
}

function isKnownCategory(value: string): boolean {
  return ["devices", "apps", "policies", "compliance", "updates"].includes(value);
}

function validateSupportContact(value: string): string | null {
  if (value.startsWith("@") && /^@[A-Za-z0-9-]{1,39}$/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0
      ? null
      : "Support contact must be a GitHub handle or HTTPS URL.";
  } catch {
    return "Support contact must be a GitHub handle or HTTPS URL.";
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function findSecretLikeValues(source: string): string[] {
  const patterns = [
    /\bpassword\s*[:=]\s*["']?[^"'\s]{6,}/i,
    /\b(client[_-]?secret|secret)\s*[:=]\s*["']?[^"'\s]{8,}/i,
    /\b(api[_-]?key|token)\s*[:=]\s*["']?[^"'\s]{12,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  return patterns.filter((pattern) => pattern.test(source)).map(String);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}.`);
  return value;
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}
