import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reset OpenAdminOS seals the data folder for the rest of this process once
 * its marker is written. Writers in this process change files by path, and
 * from that moment the folder at that path may no longer be the one being
 * reset (a restore can put another profile there before the restart).
 *
 * Two layers. The secret stores and other known writers check
 * `dataFolderSealed()` themselves, so they skip quietly. Beneath them every
 * path based change through Node's file system API (writes, appends,
 * folders, removals, renames, copies, links, mode changes, opens for
 * writing, write streams), from this app or a dependency such as Baileys,
 * is refused for any path inside the data folder, so a writer nobody
 * listed cannot reach it either. Changes through a handle opened earlier
 * (SQLite, Chromium) are not paths and stay as they are; the process exits
 * right after.
 */
let sealed = false;
let sealedRoots: string[] = [];
/** Names directly in the data folder that stay writable: the reset's own marker. */
let allowedNamePrefixes: string[] = [];

export class DataFolderSealedError extends Error {
  readonly code = "EROFS";
  constructor() {
    super("OpenAdminOS is resetting and restarts in a moment. Nothing was saved.");
    this.name = "DataFolderSealedError";
  }
}

/**
 * Seals the data folder at `root` (with no root, only the flag the known
 * writers check). Entries directly in it whose names start with one of
 * `allowNamePrefixes` stay writable, so the reset can still add its
 * warnings to its own marker.
 */
export function sealDataFolder(root?: string, options: { allowNamePrefixes?: string[] } = {}): void {
  sealed = true;
  if (root) {
    sealedRoots = rootsFor(root);
    allowedNamePrefixes = (options.allowNamePrefixes ?? []).map(normalize);
    installGuard();
    // A refused write that nobody awaited (a background save) is logged,
    // never raised as an error of the main process in the moment before
    // the restart.
    if (!rejectionLogInstalled) {
      rejectionLogInstalled = true;
      process.on("unhandledRejection", (reason) => {
        if (reason instanceof DataFolderSealedError) console.warn("[local-reset] a write was refused after the reset committed");
        else console.error("[local-reset] unhandled rejection while resetting", reason);
      });
    }
  }
}

let rejectionLogInstalled = false;

/** A reset refused after all: the data folder is written again. */
export function unsealDataFolder(): void {
  sealed = false;
  sealedRoots = [];
  allowedNamePrefixes = [];
}

export function dataFolderSealed(): boolean {
  return sealed;
}

function rootsFor(root: string): string[] {
  const roots = new Set([normalize(resolve(root))]);
  try {
    roots.add(normalize(fs.realpathSync(root)));
  } catch {
    // The lexical path is enough when the folder cannot be resolved.
  }
  return [...roots];
}

function normalize(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** True when a path argument names something inside a sealed data folder. */
export function isSealedPath(target: unknown): boolean {
  if (!sealed || sealedRoots.length === 0) return false;
  let path: string;
  if (typeof target === "string") path = target;
  else if (target instanceof URL) path = fileURLToPath(target);
  else if (Buffer.isBuffer(target)) path = target.toString("utf8");
  else return false; // A file descriptor: a handle opened earlier.
  const full = normalize(resolve(path));
  const separator = process.platform === "win32" ? "\\" : "/";
  return sealedRoots.some((root) => {
    if (full === root) return true;
    if (!full.startsWith(`${root}${separator}`)) return false;
    const rest = full.slice(root.length + 1);
    return !(!rest.includes(separator) && allowedNamePrefixes.some((prefix) => rest.startsWith(prefix)));
  });
}

const WRITE_FLAG_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

function opensForWriting(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & WRITE_FLAG_BITS) !== 0;
  if (typeof flags === "string") return /[wa+]/.test(flags);
  return false;
}

let guardInstalled = false;

type AnyFunction = (...args: unknown[]) => unknown;

/** Which arguments are paths that the call changes. */
const MUTATING_PATH_ARGS: Record<string, number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  mkdtemp: [0],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  rename: [0, 1],
  copyFile: [1],
  cp: [1],
  truncate: [0],
  symlink: [1],
  link: [1],
  chmod: [0],
  lchmod: [0],
  chown: [0],
  lchown: [0],
  utimes: [0],
  lutimes: [0],
};

function installGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const promises = fs.promises as unknown as Record<string, AnyFunction>;
  const callbacks = fs as unknown as Record<string, AnyFunction>;
  for (const [name, indexes] of Object.entries(MUTATING_PATH_ARGS)) {
    const refused = (args: unknown[]) => indexes.some((index) => isSealedPath(args[index]));
    wrapPromise(promises, name, refused);
    wrapCallback(callbacks, name, refused);
    wrapSync(callbacks, `${name}Sync`, refused);
  }
  const openRefused = (args: unknown[]) => isSealedPath(args[0]) && opensForWriting(args[1]);
  wrapPromise(promises, "open", openRefused);
  wrapCallback(callbacks, "open", openRefused);
  wrapSync(callbacks, "openSync", openRefused);
  const streamRefused = (args: unknown[]) => {
    const options = args[1];
    const flags = typeof options === "object" && options !== null ? (options as { flags?: unknown }).flags : undefined;
    return isSealedPath(args[0]) && (flags === undefined || opensForWriting(flags));
  };
  wrapSync(callbacks, "createWriteStream", streamRefused);
  syncBuiltinESMExports();
}

function wrapPromise(target: Record<string, AnyFunction>, name: string, refused: (args: unknown[]) => boolean): void {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function sealedPromise(this: unknown, ...args: unknown[]) {
    if (refused(args)) return Promise.reject(new DataFolderSealedError());
    return original.apply(this, args);
  };
}

function wrapCallback(target: Record<string, AnyFunction>, name: string, refused: (args: unknown[]) => boolean): void {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function sealedCallback(this: unknown, ...args: unknown[]) {
    if (refused(args)) {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        process.nextTick(() => (callback as (error: Error) => void)(new DataFolderSealedError()));
        return undefined;
      }
      throw new DataFolderSealedError();
    }
    return original.apply(this, args);
  };
}

function wrapSync(target: Record<string, AnyFunction>, name: string, refused: (args: unknown[]) => boolean): void {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function sealedSync(this: unknown, ...args: unknown[]) {
    if (refused(args)) throw new DataFolderSealedError();
    return original.apply(this, args);
  };
}
