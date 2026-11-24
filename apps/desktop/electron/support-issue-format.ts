import { createHash } from "node:crypto";

import { redactSupportPublicText } from "./support-secret-redaction.js";

// Keep the desktop and web formatters in sync. The web build has its own root.
const MAX_ISSUE_BODY_LENGTH = 58_000;
const MAX_DIAGNOSTICS_LENGTH = 40_000;

interface SupportIssuePayload {
  issue: {
    title: string;
    description: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    source: "sidebar" | "run-failure" | "settings-about" | "native-menu";
    appVersion: string;
  };
  diagnostics?: unknown;
}

interface FormattedSupportIssue {
  title: string;
  body: string;
  dedupInput: string;
}

export function bucketSupportCount(count: number): string {
  if (count <= 0) return "0";
  if (count <= 10) return "1-10";
  if (count <= 100) return "11-100";
  if (count <= 1_000) return "101-1000";
  if (count <= 10_000) return "1001-10000";
  return "10001+";
}

export function supportIssuePreviewDigest(title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([title, body])).digest("hex");
}

export function formatSupportIssue(
  body: unknown,
): { payload: FormattedSupportIssue } | { error: string } {
  if (!isObject(body)) return { error: "Body must be a JSON object." };
  if (!isObject(body.issue)) return { error: "`issue` is required." };

  const payload: SupportIssuePayload = {
    issue: {
      title: sanitizePublicText(stringField(body.issue.title), 180),
      description: sanitizePublicText(stringField(body.issue.description), 4_000),
      stepsToReproduce: optionalSanitizedText(body.issue.stepsToReproduce, 3_000),
      expectedBehavior: optionalSanitizedText(body.issue.expectedBehavior, 2_000),
      actualBehavior: optionalSanitizedText(body.issue.actualBehavior, 2_000),
      source: parseSource(body.issue.source),
      appVersion: sanitizePublicText(stringField(body.issue.appVersion), 40),
    },
    diagnostics:
      body.diagnostics === undefined ? undefined : sanitizeDiagnostics(body.diagnostics),
  };

  if (payload.issue.title.length < 3) return { error: "Issue title is required." };
  if (payload.issue.description.length < 10) {
    return { error: "Issue description is required." };
  }

  const title = `[Support] ${payload.issue.title}`;
  if (title.length > 200) return { error: "Issue title is too long." };

  const supportBody = buildIssueBody(payload);
  if (supportBody.length > MAX_ISSUE_BODY_LENGTH) {
    return { error: "Issue body is too long." };
  }

  return {
    payload: {
      title,
      body: supportBody,
      dedupInput: [
        title,
        payload.issue.description,
        payload.issue.stepsToReproduce ?? "",
        payload.issue.expectedBehavior ?? "",
        payload.issue.actualBehavior ?? "",
        payload.diagnostics === undefined ? "" : JSON.stringify(payload.diagnostics),
      ].join("\n"),
    },
  };
}

function buildIssueBody(payload: SupportIssuePayload): string {
  const diagnostics = payload.diagnostics
    ? `\n\`\`\`json\n${JSON.stringify(payload.diagnostics, null, 2)}\n\`\`\`\n`
    : "_Not included._\n";

  return [
    section("What happened", payload.issue.description),
    section("Steps to reproduce", payload.issue.stepsToReproduce),
    section("Expected behavior", payload.issue.expectedBehavior),
    section("Actual behavior", payload.issue.actualBehavior),
    section("Diagnostics", diagnostics),
    section(
      "Report metadata",
      [
        `App version: ${payload.issue.appVersion || "unknown"}`,
        `Source: ${payload.issue.source}`,
        "Submitted from OpenAdminOS after explicit public issue confirmation.",
      ].join("\n"),
    ),
    "---\n\n_Public issue created by the OpenAdminOS support report endpoint. Server-side redaction was applied before GitHub submission._\n",
  ].join("\n");
}

function section(title: string, value: string | undefined) {
  const body = value?.trim();
  if (!body) return `### ${title}\n_Not provided._\n`;
  return `### ${title}\n${body}\n`;
}

function sanitizeDiagnostics(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_DIAGNOSTICS_LENGTH) {
    throw new SupportIssueSizeError(413, "Diagnostics payload is too large.");
  }

  // Older clients sent numeric counts and hashes of error text.
  const bucketed = JSON.stringify(value, (key, field: unknown) => {
    if (/^(?:detailHash|errorHash|.*ErrorHash)$/.test(key)) return undefined;
    if (
      typeof field === "number" &&
      (key === "rows" || key === "pages" || key === "total" ||
        key === "tenantTotal" || key.endsWith("Count"))
    ) {
      return bucketSupportCount(field);
    }
    if ((key === "byStatus" || key === "byTrigger") && isObject(field)) {
      return Object.fromEntries(
        Object.entries(field).map(([name, count]) => [
          name,
          typeof count === "number" ? bucketSupportCount(count) : count,
        ]),
      );
    }
    return field;
  });
  return JSON.parse(redactSupportPublicText(bucketed));
}

function optionalSanitizedText(value: unknown, maxLength: number): string | undefined {
  const raw = optionalStringField(value);
  return raw === undefined ? undefined : sanitizePublicText(raw, maxLength);
}

function sanitizePublicText(value: string, maxLength: number): string {
  return redactSupportPublicText(value)
    .replace(/\s+\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function parseSource(value: unknown): SupportIssuePayload["issue"]["source"] {
  const source = stringField(value);
  if (
    source === "sidebar" ||
    source === "run-failure" ||
    source === "settings-about" ||
    source === "native-menu"
  ) {
    return source;
  }
  return "sidebar";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SupportIssueSizeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
