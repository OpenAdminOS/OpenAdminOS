interface GithubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

/** Return the agent directories from GitHub, revalidated hourly by Next.js. */
export async function getKnownSlugs(): Promise<Set<string>> {
  const owner = requireEnv("OPENADMINOS_GITHUB_OWNER");
  const repo = requireEnv("OPENADMINOS_GITHUB_REPO");
  const token = requireEnv("OPENADMINOS_GITHUB_TOKEN");
  const branch = process.env.OPENADMINOS_GITHUB_BRANCH ?? "main";

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/agents?ref=${branch}`;
  const response = await fetch(url, {
    next: { revalidate: 3600 },
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch agent slugs from GitHub: ${response.status} ${response.statusText}`,
    );
  }
  const entries = (await response.json()) as GithubContentEntry[];
  return new Set(entries.filter((entry) => entry.type === "dir").map((entry) => entry.name));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}.`);
  return value;
}
