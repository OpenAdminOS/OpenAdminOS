export function adventEnabled() {
  return process.env.ADVENT_ENABLED === "true";
}

export function rulesApproved() {
  return process.env.ADVENT_RULES_APPROVED === "true";
}

export const RULES_VERSION = "2026-11-23";
export const MARKETING_CONSENT_VERSION = "2026-11-23";
export const REMINDERS_CONSENT_VERSION = "2026-11-23";
export const REMINDERS_CONSENT_LABEL = "Email me when each door opens (optional)";
export const MARKETING_CONSENT_LABEL = "Email me about OpenAdminOS releases (optional)";

export function sessionSecret() {
  const secret = process.env.ADVENT_SESSION_SECRET;
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
}

export function storageConfig() {
  const key = process.env.ADVENT_SUPABASE_SERVICE_KEY?.trim();
  try {
    const url = new URL(process.env.ADVENT_SUPABASE_URL ?? "");
    if (!key || url.protocol !== "https:" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, key };
  } catch {
    return null;
  }
}

export function isAdventAdmin(email: string) {
  return (process.env.ADVENT_ADMIN_EMAILS ?? "").split(",")
    .some((value) => value.trim().toLowerCase() === email.toLowerCase());
}

export function missingLoginConfig() {
  if (!storageConfig() || !sessionSecret()) return "Campaign accounts are not configured yet.";
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return "Sign-in rate limiting is not configured yet.";
  }
  if (process.env.ADVENT_RESEND_API_KEY ? !process.env.ADVENT_EMAIL_FROM : process.env.NODE_ENV === "production") {
    return "Sign-in email is not configured yet.";
  }
  return null;
}
