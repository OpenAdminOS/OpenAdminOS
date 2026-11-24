export interface RegistryInstallCountPayload {
  slug: string;
  version: string;
  platform: NodeJS.Platform;
}

export function createRegistryInstallCountPayload({
  slug,
  version,
  platform,
}: RegistryInstallCountPayload): RegistryInstallCountPayload {
  return { slug, version, platform };
}
