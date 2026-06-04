import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import { getRedis, keys } from "~/lib/stats/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 100_000;
const MAX_ISSUE_BODY_LENGTH = 58_000;
const SUPPORT_RATE_WINDOW_SECONDS = 60 * 60;
const SUPPORT_RATE_MAX_PER_WINDOW = 5;
const SUPPORT_DEDUP_TTL_SECONDS = 24 * 60 * 60;

interface SupportIssuePayload {
  confirmPublic: true;
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

interface ParsedSupportIssue {
  title: string;
  body: string;
  dedupHash: string;
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return jsonError(413, "Support report is too large.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  let parsed: { payload: ParsedSupportIssue } | { error: string };
  try {
    parsed = parseSupportIssuePayload(body);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(error.status, error.message);
    }
    throw error;
  }
  if ("error" in parsed) {
    return jsonError(400, parsed.error);
  }

  try {
    const rateLimited = await applySupportRateLimit(clientIp(req));
    if (rateLimited) {
      return NextResponse.json(
        { error: "Rate limited. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(SUPPORT_RATE_WINDOW_SECONDS) },
        },
      );
    }

    const duplicate = await hasSupportIssueDedup(parsed.payload.dedupHash);
    if (duplicate) {
      return jsonError(409, "A matching support issue was already submitted recently.");
    }

    const issue = await createSupportIssue(parsed.payload);
    await markSupportIssueDedup(parsed.payload.dedupHash);
    return NextResponse.json({
      issueUrl: issue.html_url,
      issueNumber: issue.number,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[support-issues] failed:", message);
    return jsonError(500, "Failed to create GitHub issue.");
  }
}

function parseSupportIssuePayload(
  body: unknown,
): { payload: ParsedSupportIssue } | { error: string } {
  if (!isObject(body)) return { error: "Body must be a JSON object." };
  if (body.confirmPublic !== true) {
    return { error: "Public issue confirmation is required." };
  }
  if (!isObject(body.issue)) return { error: "`issue` is required." };

  const payload: SupportIssuePayload = {
    confirmPublic: true,
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
      dedupHash: sha256(
        [
          title,
          payload.issue.description,
          payload.issue.stepsToReproduce ?? "",
          payload.issue.expectedBehavior ?? "",
          payload.issue.actualBehavior ?? "",
          payload.diagnostics === undefined ? "" : JSON.stringify(payload.diagnostics),
        ].join("\n"),
      ),
    },
  };
}

function buildIssueBody(payload: SupportIssuePayload): string {
  const diagnostics = payload.diagnostics
    ? `\n\`\`\`json\n${truncate(JSON.stringify(payload.diagnostics, null, 2), 32_000)}\n\`\`\`\n`
    : "_Not included._\n";

  return [
    section("What happened", payload.issue.description),
    section("Steps to reproduce", payload.issue.stepsToReproduce),
    section("Expected behavior", payload.issue.expectedBehavior),
    section("Actual behavior", payload.issue.actualBehavior),
    section("Diagnostics", diagnostics, { raw: true }),
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

function section(title: string, value: string | undefined, options?: { raw?: boolean }) {
  const body = value?.trim();
  if (!body) return `### ${title}\n_Not provided._\n`;
  return `### ${title}\n${options?.raw ? body : body}\n`;
}

async function createSupportIssue(payload: ParsedSupportIssue) {
  const token = requireEnv("OPENADMINOS_GITHUB_TOKEN");
  const owner = requireEnv("OPENADMINOS_GITHUB_OWNER");
  const repo = requireEnv("OPENADMINOS_GITHUB_REPO");
  const octokit = new Octokit({ auth: token });

  const response = await octokit.issues.create({
    owner,
    repo,
    title: payload.title,
    body: payload.body,
  });
  return response.data;
}

async function applySupportRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  const bucket = Math.floor(Date.now() / 1000 / SUPPORT_RATE_WINDOW_SECONDS);
  const rateKey = keys.supportIssueRate(ip, bucket);
  const count = await redis.incr(rateKey);
  if (count === 1) {
    await redis.expire(rateKey, SUPPORT_RATE_WINDOW_SECONDS);
  }
  return count > SUPPORT_RATE_MAX_PER_WINDOW;
}

async function hasSupportIssueDedup(hash: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.get(keys.supportIssueDedup(hash))) !== null;
}

async function markSupportIssueDedup(hash: string): Promise<void> {
  const redis = getRedis();
  await redis.set(keys.supportIssueDedup(hash), "1", {
    nx: true,
    ex: SUPPORT_DEDUP_TTL_SECONDS,
  });
}

function sanitizeDiagnostics(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length > 40_000) {
    throw new HttpError(413, "Diagnostics payload is too large.");
  }
  return JSON.parse(sanitizePublicText(serialized, 40_000));
}

function optionalSanitizedText(value: unknown, maxLength: number): string | undefined {
  const raw = optionalStringField(value);
  return raw === undefined ? undefined : sanitizePublicText(raw, maxLength);
}

function sanitizePublicText(value: string, maxLength: number): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[guid]")
    .replace(/\b[A-Za-z0-9-]+\.onmicrosoft\.com\b/gi, "[tenant-domain]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
