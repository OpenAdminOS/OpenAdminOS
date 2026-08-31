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
    OPENADMINOS_GITHUB_TOKEN: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_OWNER: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_REPO: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_BRANCH: z.string().min(1).optional(),
    CRON_SECRET: z.string().min(1).optional(),
    // Runtime-only and optional so unconfigured builds render an idle line.
    // Storage is the shared UgurLabs Supabase project (oaos_-prefixed tables).
    TRAINING_STATE_TOKEN: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    OPENADMINOS_GITHUB_TOKEN: process.env.OPENADMINOS_GITHUB_TOKEN,
    OPENADMINOS_GITHUB_OWNER: process.env.OPENADMINOS_GITHUB_OWNER,
    OPENADMINOS_GITHUB_REPO: process.env.OPENADMINOS_GITHUB_REPO,
    OPENADMINOS_GITHUB_BRANCH: process.env.OPENADMINOS_GITHUB_BRANCH,
    CRON_SECRET: process.env.CRON_SECRET,
    TRAINING_STATE_TOKEN: process.env.TRAINING_STATE_TOKEN,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
