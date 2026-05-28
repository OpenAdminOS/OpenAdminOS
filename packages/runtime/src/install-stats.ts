import { createHash } from "node:crypto";

export interface RegistryInstallCountPayloadInput {
  slug: string;
  rawInstallId: string;
  version: string;
  platform: NodeJS.Platform;
  now?: Date;
}

export interface RegistryInstallCountPayload {
  slug: string;
  /**
   * Yearly per-agent SHA-256 digest derived from the local random install id.
   * This keeps dedupe stable only for the same agent in the same calendar year.
   */
  installId: string;
  version: string;
  platform: NodeJS.Platform;
}

export function createRegistryInstallCountPayload({
  slug,
  rawInstallId,
  version,
  platform,
  now = new Date(),
}: RegistryInstallCountPayloadInput): RegistryInstallCountPayload {
  const year = now.getUTCFullYear();
  const installId = createHash("sha256")
    .update(`openadminos:registry-install:${year}:${slug}:${rawInstallId}`)
    .digest("hex");

  return {
    slug,
    installId,
    version,
    platform,
  };
}
