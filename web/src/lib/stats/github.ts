import { Octokit } from "@octokit/rest";

const STATS_PATH = "stats/agents.json";

let cachedOctokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (cachedOctokit) return cachedOctokit;
  const token = process.env.OPENAGENTS_GITHUB_TOKEN;
  if (!token) throw new Error("Missing OPENAGENTS_GITHUB_TOKEN.");
  cachedOctokit = new Octokit({ auth: token });
  return cachedOctokit;
}

function repoConfig() {
  const owner = process.env.OPENAGENTS_GITHUB_OWNER;
  const repo = process.env.OPENAGENTS_GITHUB_REPO;
  const branch = process.env.OPENAGENTS_GITHUB_BRANCH ?? "main";
  if (!owner || !repo) {
    throw new Error("Missing OPENAGENTS_GITHUB_OWNER / OPENAGENTS_GITHUB_REPO.");
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
  /** GitHub blob SHA of the current file — required to PUT an update. */
  sha: string;
}

/**
 * Read the current `stats/agents.json`. Throws if the file doesn't
 * exist or doesn't parse — both are signs of repo drift that we want
 * to alert on rather than silently overwrite.
 */
export async function fetchStats(): Promise<StatsFetchResult> {
  const octokit = getOctokit();
  const { owner, repo, branch } = repoConfig();
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: STATS_PATH,
    ref: branch,
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
  return { file: parsed, sha: response.data.sha };
}

/**
 * Commit a new version of `stats/agents.json`. Idempotent w.r.t. the
 * SHA — if `main` moved since `fetchStats` returned, the PUT 409s and
 * the caller should re-fetch and retry.
 */
export async function commitStats(input: {
  file: AgentStatsFile;
  sha: string;
  commitMessage: string;
}): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo, branch } = repoConfig();
  const content = Buffer.from(`${JSON.stringify(input.file, null, 2)}\n`, "utf8").toString(
    "base64",
  );
  // No author / committer override — let GitHub attribute the commit to
  // the PAT owner. Vercel's deployment-authorization check rejects any
  // commit whose author email doesn't map to a GitHub account, so the
  // previous `stats-bot@openagents.sh` placeholder caused production
  // redeploys to bounce.
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: STATS_PATH,
    branch,
    message: input.commitMessage,
    content,
    sha: input.sha,
  });
}
