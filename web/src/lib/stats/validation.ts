/**
 * Validation helpers for the public `/api/install` endpoint. Strict by
 * design — the binary can lie about anything in the body, so every
 * field is pattern-checked before it reaches Redis or GitHub.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORMS = new Set(["darwin", "win32", "linux"]);

export interface InstallPayload {
  slug: string;
  installId: string;
  version: string;
  platform: "darwin" | "win32" | "linux";
}

export function parseInstallPayload(body: unknown): InstallPayload {
  if (!isObject(body)) throw badRequest("Body must be a JSON object.");

  const slug = body.slug;
  const installId = body.installId;
  const version = body.version;
  const platform = body.platform;

  if (typeof slug !== "string" || !SLUG_RE.test(slug) || slug.length > 64) {
    throw badRequest("`slug` must be a kebab-case string (max 64 chars).");
  }
  if (typeof installId !== "string" || !UUID_RE.test(installId)) {
    throw badRequest("`installId` must be a UUID.");
  }
  if (typeof version !== "string" || !SEMVER_RE.test(version) || version.length > 32) {
    throw badRequest("`version` must be a semver string (max 32 chars).");
  }
  if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
    throw badRequest("`platform` must be 'darwin', 'win32', or 'linux'.");
  }

  return {
    slug,
    installId,
    version,
    platform: platform as InstallPayload["platform"],
  };
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
