import { open } from "node:fs/promises";

type OpenFile = (path: string, flags: string, mode?: number) => Promise<{
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

/**
 * Write a file, and when `durable`, flush it to disk through the same
 * writable handle before closing. On Windows `fsync` is FlushFileBuffers,
 * which needs write access, so a handle opened for reading cannot flush.
 */
export async function writeFileDurably(
  path: string,
  data: string,
  options: { durable: boolean; mode?: number; openFile?: OpenFile } = { durable: false },
): Promise<void> {
  const openFile = options.openFile ?? (open as unknown as OpenFile);
  const handle = await openFile(path, "w", options.mode ?? 0o600);
  try {
    await handle.writeFile(data, "utf8");
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
}

/** File systems that cannot flush a directory entry; anything else is a real failure. */
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * Flush a directory entry after a rename, so the rename survives a crash.
 * Windows cannot open a directory handle for fsync, so it is a no-op there.
 * A file system that does not support it is skipped; any other failure is
 * thrown to the caller instead of being swallowed.
 */
export async function syncDirectory(
  path: string,
  options: { platform?: NodeJS.Platform; openFile?: OpenFile } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) === "win32") return;
  const openFile = options.openFile ?? (open as unknown as OpenFile);
  let handle: Awaited<ReturnType<OpenFile>>;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if (UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException)?.code ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
  } finally {
    await handle.close();
  }
}
