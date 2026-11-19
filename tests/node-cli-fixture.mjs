import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { registerProviderFixtureDirectory } from "./provider-test-guard.mjs";

export async function writeNodeCliFixture(directory, name, script, windowsEntry) {
  const binary = join(directory, name);
  registerProviderFixtureDirectory(directory);
  if (process.platform === "win32") {
    const entry = join(directory, "node_modules", windowsEntry);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, script);
    // The adapter must resolve the official entry and call process.execPath.
    await writeFile(`${binary}.cmd`, "@exit /b 99\r\n");
    return `${binary}.cmd`;
  }

  const entry = `${binary}.cjs`;
  const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;
  await writeFile(entry, script);
  // A quoted absolute interpreter also works when its path contains spaces.
  await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
  await chmod(binary, 0o755);
  return binary;
}
