const GITHUB_REPO_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS";

interface GitHubRepoResponse {
  stargazers_count?: unknown;
}

export async function getGitHubRepoStats(): Promise<{ stars: number } | null> {
  try {
    const response = await fetch(GITHUB_REPO_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      next: { revalidate: 3600 },
    });

    if (!response.ok) return null;

    const repo = (await response.json()) as GitHubRepoResponse;
    const stars = repo.stargazers_count;

    if (typeof stars !== "number" || !Number.isFinite(stars)) return null;

    return { stars };
  } catch {
    return null;
  }
}
