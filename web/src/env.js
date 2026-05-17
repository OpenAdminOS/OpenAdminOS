import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]),
    // Stats API — only required at runtime for the /api/install + /api/flush routes.
    // Validation is per-handler (so a request without these set fails 500 with a
    // clear message), not at build time, so the marketing site can still build
    // even before the env vars are provisioned.
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
    OPENAGENTS_GITHUB_TOKEN: z.string().min(1).optional(),
    OPENAGENTS_GITHUB_OWNER: z.string().min(1).optional(),
    OPENAGENTS_GITHUB_REPO: z.string().min(1).optional(),
    OPENAGENTS_GITHUB_BRANCH: z.string().min(1).optional(),
    CRON_SECRET: z.string().min(1).optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    OPENAGENTS_GITHUB_TOKEN: process.env.OPENAGENTS_GITHUB_TOKEN,
    OPENAGENTS_GITHUB_OWNER: process.env.OPENAGENTS_GITHUB_OWNER,
    OPENAGENTS_GITHUB_REPO: process.env.OPENAGENTS_GITHUB_REPO,
    OPENAGENTS_GITHUB_BRANCH: process.env.OPENAGENTS_GITHUB_BRANCH,
    CRON_SECRET: process.env.CRON_SECRET,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
