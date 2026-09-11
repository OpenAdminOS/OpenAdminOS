import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** NTFS replacement can briefly fail while another reader holds the destination.
 * Keep the old file intact and retry the same atomic replacement, never unlink it.
 */
export async function atomicRename(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform;
    replace?: typeof rename;
    wait?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  const replace = options.replace ?? rename;
  const wait = options.wait ?? delay;
  for (let attempt = 0; ; attempt++) {
    try {
      await replace(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        (options.platform ?? process.platform) !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        attempt >= 6
      )
        throw error;
      await wait(20 * 2 ** attempt);
    }
  }
}
