import { Octokit } from "@octokit/rest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import registryIndex from "~/generated/registry-index.json";
import {
  formatSupportIssue,
  supportIssuePreviewDigest,
  SupportIssueSizeError,
} from "~/lib/support/issue-format";
import { statsUnavailable } from "~/lib/stats/responses";
import { getStatsStore, StatsStorageError } from "~/lib/stats/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 100_000;
const SUPPORT_RATE_WINDOW_SECONDS = 60 * 60;
const SUPPORT_RATE_MAX_PER_WINDOW = 5;
const SUPPORT_DEDUP_TTL_SECONDS = 24 * 60 * 60;
const publicAgentSlugs = new Set(registryIndex.agents.map(({ slug }) => slug));

class MissingGitHubConfig extends Error {}

export async function POST(req: Request) {
  const store = getStatsStore();
  if (!store) return statsUnavailable(false);

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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "Body must be a JSON object.");
  }
  if (!("confirmPublic" in body) || body.confirmPublic !== true) {
    return jsonError(400, "Public issue confirmation is required.");
  }

  let parsed: ReturnType<typeof formatSupportIssue>;
  try {
    parsed = formatSupportIssue(body, publicAgentSlugs);
  } catch (error) {
    if (error instanceof SupportIssueSizeError) {
      return jsonError(error.status, error.message);
    }
    throw error;
  }
  if ("error" in parsed) {
    return jsonError(400, parsed.error);
  }

  const { title, body: issueBody, dedupInput } = parsed.payload;
  // TODO(ugur): Is previewDigest the right name for the reviewed-content check on this endpoint?
  if ("previewDigest" in body && body.previewDigest !== supportIssuePreviewDigest(title, issueBody)) {
    return jsonError(409, "The server formatted the report differently. Update OpenAdminOS and review the report again.");
  }
  const dedupHash = sha256(dedupInput);

  try {
    const allowed = await store.rateLimitHit("support-issue", req, SUPPORT_RATE_WINDOW_SECONDS, SUPPORT_RATE_MAX_PER_WINDOW);
    if (!allowed) {
      return NextResponse.json(
        { error: "Rate limited. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(SUPPORT_RATE_WINDOW_SECONDS) },
        },
      );
    }

    const claimed = await store.claimSupportDedup(dedupHash, SUPPORT_DEDUP_TTL_SECONDS);
    if (!claimed) {
      return jsonError(409, "A matching support issue was already submitted recently.");
    }

    const issue = await createSupportIssue(title, issueBody).catch(async (error: unknown) => {
      // Release on a definite rejection. A lost GitHub response can still mean the issue exists.
      if (isGithubRejection(error)) await store.releaseSupportDedup(dedupHash);
      throw error;
    });
    return NextResponse.json({
      issueUrl: issue.html_url,
      issueNumber: issue.number,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[support-issues] failed:", message);
    if (error instanceof StatsStorageError) return statsUnavailable(true);
    return jsonError(500, "Failed to create GitHub issue.");
  }
}

async function createSupportIssue(title: string, body: string) {
  const token = requireEnv("OPENADMINOS_GITHUB_TOKEN");
  const owner = requireEnv("OPENADMINOS_GITHUB_OWNER");
  const repo = requireEnv("OPENADMINOS_GITHUB_REPO");
  const octokit = new Octokit({ auth: token });

  const response = await octokit.issues.create({
    owner,
    repo,
    title,
    body,
  });
  return response.data;
}

function isGithubRejection(error: unknown): boolean {
  if (error instanceof MissingGitHubConfig) return true;
  return typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 408;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingGitHubConfig(`${name} is not configured.`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}
