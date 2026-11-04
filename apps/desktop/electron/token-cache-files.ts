import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** The default identity's cache keeps its original name so existing installs are untouched. */
export const DEFAULT_TOKEN_CACHE_FILE = "tokens.bin";

const PER_CLIENT_TOKEN_CACHE_FILE = /^tokens-([0-9a-zA-Z-]+)\.bin$/;

/**
 * The file a token cache partition (a canonical, lower case client ID)
 * lives in. Bring-your-own registrations get an isolated cache: MSAL binds
 * tokens to a client id, so mixing caches would surface accounts that the
 * active client can never refresh.
 */
export function tokenCacheFileName(partition: string, defaultPartition: string): string {
  return partition === defaultPartition
    ? DEFAULT_TOKEN_CACHE_FILE
    : `tokens-${partition.replace(/[^0-9a-z-]/g, "")}.bin`;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/**
 * Before client IDs were stored in one case, a custom registration's cache
 * file was named with the client ID as typed, for example
 * `tokens-AAAAAAAA-....bin`, and the OpenAdminOS client ID typed in upper
 * case as a custom registration got its own file instead of `tokens.bin`.
 * Move each such file onto its canonical name when that name is free. When
 * the canonical file already exists as a separate file (on a case-sensitive
 * filesystem, or `tokens.bin` for the default client ID), keep both and
 * return the legacy path under its partition: the app reads both and
 * removes accounts from both, and never deletes either file. On a
 * case-insensitive filesystem a name that differs only in case is already
 * the canonical file, so nothing changes.
 */
export async function adoptLegacyTokenCacheFiles(
  dir: string,
  defaultPartition: string,
): Promise<Map<string, string[]>> {
  const legacy = new Map<string, string[]>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return legacy;
    throw error;
  }
  for (const name of names.sort()) {
    const match = PER_CLIENT_TOKEN_CACHE_FILE.exec(name);
    if (!match?.[1]) continue;
    const partition = match[1].toLowerCase();
    const canonicalName = tokenCacheFileName(partition, defaultPartition);
    if (name === canonicalName) continue;
    const source = join(dir, name);
    const target = join(dir, canonicalName);
    const targetStat = await statIfPresent(target);
    if (!targetStat) {
      await rename(source, target);
      continue;
    }
    const sourceStat = await stat(source);
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) continue;
    legacy.set(partition, [...(legacy.get(partition) ?? []), source]);
  }
  return legacy;
}
