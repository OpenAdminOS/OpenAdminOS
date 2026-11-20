/**
 * Reset OpenAdminOS seals the data folder for the rest of this process once
 * its marker is written. The secret stores write and delete their files by
 * path, and from that moment the folder at that path may no longer be the
 * one being reset (a restore can put another profile there before the
 * restart). While sealed, a secret is never read from disk (a read that
 * cannot decrypt would delete the file), written or removed. One flag for
 * the process, since every store of this process shares the one data folder.
 */
let sealed = false;

export class DataFolderSealedError extends Error {
  constructor() {
    super("OpenAdminOS is resetting and restarts in a moment. Nothing was saved.");
    this.name = "DataFolderSealedError";
  }
}

export function sealDataFolder(): void {
  sealed = true;
}

/** A reset refused after all: the data folder is written again. */
export function unsealDataFolder(): void {
  sealed = false;
}

export function dataFolderSealed(): boolean {
  return sealed;
}
