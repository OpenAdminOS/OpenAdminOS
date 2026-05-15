import { safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class EncryptedSecretStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string> {
    try {
      const encrypted = await readFile(this.filePath);
      if (encrypted.length === 0) return "";
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          "Electron safeStorage is unavailable on this platform; cannot decrypt token cache.",
        );
      }
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }

  async write(plaintext: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Electron safeStorage is unavailable on this platform; cannot persist token cache.",
      );
    }
    const ciphertext = safeStorage.encryptString(plaintext);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, ciphertext, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await this.write("");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
