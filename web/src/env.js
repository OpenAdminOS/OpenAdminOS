import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    // Campaign settings are optional and validated by the handlers that use them.
    ADVENT_ENABLED: z.string().optional(),
    ADVENT_SUPABASE_URL: z.string().optional(),
    ADVENT_SUPABASE_SERVICE_KEY: z.string().optional(),
    ADVENT_SESSION_SECRET: z.string().optional(),
    ADVENT_ANSWER_PEPPER: z.string().optional(),
    ADVENT_RESEND_API_KEY: z.string().optional(),
    ADVENT_EMAIL_FROM: z.string().optional(),
    ADVENT_ADMIN_EMAILS: z.string().optional(),
    ADVENT_NOW: z.string().optional(),
    ADVENT_RULES_APPROVED: z.string().optional(),
    ADVENT_REMINDERS_SEND: z.string().optional(),
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
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    ADVENT_ENABLED: process.env.ADVENT_ENABLED,
    ADVENT_SUPABASE_URL: process.env.ADVENT_SUPABASE_URL,
    ADVENT_SUPABASE_SERVICE_KEY: process.env.ADVENT_SUPABASE_SERVICE_KEY,
    ADVENT_SESSION_SECRET: process.env.ADVENT_SESSION_SECRET,
    ADVENT_ANSWER_PEPPER: process.env.ADVENT_ANSWER_PEPPER,
    ADVENT_RESEND_API_KEY: process.env.ADVENT_RESEND_API_KEY,
    ADVENT_EMAIL_FROM: process.env.ADVENT_EMAIL_FROM,
    ADVENT_ADMIN_EMAILS: process.env.ADVENT_ADMIN_EMAILS,
    ADVENT_NOW: process.env.ADVENT_NOW,
    ADVENT_RULES_APPROVED: process.env.ADVENT_RULES_APPROVED,
    ADVENT_REMINDERS_SEND: process.env.ADVENT_REMINDERS_SEND,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    OPENADMINOS_GITHUB_TOKEN: process.env.OPENADMINOS_GITHUB_TOKEN,
    OPENADMINOS_GITHUB_OWNER: process.env.OPENADMINOS_GITHUB_OWNER,
    OPENADMINOS_GITHUB_REPO: process.env.OPENADMINOS_GITHUB_REPO,
    OPENADMINOS_GITHUB_BRANCH: process.env.OPENADMINOS_GITHUB_BRANCH,
    CRON_SECRET: process.env.CRON_SECRET,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
