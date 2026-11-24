import { Octokit } from "@octokit/rest";

import type { InstallSnapshot } from "./store";

const STATS_PATH = "stats/agents.json";
const FLUSH_TRAILER = "OpenAdminOS-Install-Counts: ";
const FLUSH_HISTORY_LIMIT = 100;

let cachedOctokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (cachedOctokit) return cachedOctokit;
  const token = process.env.OPENADMINOS_GITHUB_TOKEN;
  if (!token) throw new Error("Missing OPENADMINOS_GITHUB_TOKEN.");
  cachedOctokit = new Octokit({ auth: token });
  return cachedOctokit;
}

function repoConfig() {
  const owner = process.env.OPENADMINOS_GITHUB_OWNER;
  const repo = process.env.OPENADMINOS_GITHUB_REPO;
  const branch = process.env.OPENADMINOS_GITHUB_BRANCH ?? "main";
  if (!owner || !repo) {
    throw new Error("Missing OPENADMINOS_GITHUB_OWNER / OPENADMINOS_GITHUB_REPO.");
  }
  return { owner, repo, branch };
}

export interface AgentStatsEntry {
  installs: number;
  installs7d: number;
  discussionUrl?: string;
  comments?: number;
  reactions?: Record<string, number>;
}

export interface AgentStatsFile {
  updatedAt: string;
  agents: Record<string, AgentStatsEntry>;
}

interface StatsFetchResult {
  file: AgentStatsFile;
  sha: string;
  lastFlush: InstallSnapshot[];
}

export async function fetchStats(): Promise<StatsFetchResult> {
  const octokit = getOctokit();
  const { owner, repo, branch } = repoConfig();

  // Check one page of stats-file commits. Legacy and rolling-window-only commits can sit above a receipt.
  const { data: commits } = await octokit.repos.listCommits({
    owner, repo, sha: branch, path: STATS_PATH, per_page: FLUSH_HISTORY_LIMIT,
  });
  const ref = commits[0]?.sha;
  if (!ref) throw new Error(`No commit found for ${STATS_PATH}.`);

  let lastFlush: InstallSnapshot[] = [];
  for (const { commit: { message } } of commits) {
    const trailer = message.split("\n").find((line) => line.startsWith(FLUSH_TRAILER));
    if (trailer) {
      lastFlush = JSON.parse(trailer.slice(FLUSH_TRAILER.length)) as InstallSnapshot[];
      break;
    }
  }

  // Pin the file read to the latest commit in that same history.
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: STATS_PATH,
    ref,
  });
  if (Array.isArray(response.data) || response.data.type !== "file") {
    throw new Error(`Expected ${STATS_PATH} to be a file, got: ${JSON.stringify(response.data)}`);
  }
  const decoded = Buffer.from(response.data.content, "base64").toString("utf8");
  let parsed: AgentStatsFile;
  try {
    parsed = JSON.parse(decoded) as AgentStatsFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${STATS_PATH}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.agents) {
    throw new Error(`${STATS_PATH} has no \`agents\` object.`);
  }
  return { file: parsed, sha: response.data.sha, lastFlush };
}

/** Use the blob SHA to prevent overwriting a concurrent stats update. */
export async function commitStats(input: {
  file: AgentStatsFile;
  sha: string;
  commitMessage: string;
  snapshot: InstallSnapshot[];
}): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo, branch } = repoConfig();
  const content = Buffer.from(`${JSON.stringify(input.file, null, 2)}\n`, "utf8").toString(
    "base64",
  );
  const message = input.snapshot.length
    ? `${input.commitMessage}\n\n${FLUSH_TRAILER}${JSON.stringify(input.snapshot)}`
    : input.commitMessage;
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: STATS_PATH,
    branch,
    message,
    content,
    sha: input.sha,
  });
}
