import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]),
    // Optional so the site can build without stats credentials.
    SUPABASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    SUPABASE_SECRET_KEY: z.string().min(1).optional(),
    STATS_IP_HASH_SECRET: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_TOKEN: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_OWNER: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_REPO: z.string().min(1).optional(),
    OPENADMINOS_GITHUB_BRANCH: z.string().min(1).optional(),
    CRON_SECRET: z.string().min(1).optional(),
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    STATS_IP_HASH_SECRET: process.env.STATS_IP_HASH_SECRET,
    OPENADMINOS_GITHUB_TOKEN: process.env.OPENADMINOS_GITHUB_TOKEN,
    OPENADMINOS_GITHUB_OWNER: process.env.OPENADMINOS_GITHUB_OWNER,
    OPENADMINOS_GITHUB_REPO: process.env.OPENADMINOS_GITHUB_REPO,
    OPENADMINOS_GITHUB_BRANCH: process.env.OPENADMINOS_GITHUB_BRANCH,
    CRON_SECRET: process.env.CRON_SECRET,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
