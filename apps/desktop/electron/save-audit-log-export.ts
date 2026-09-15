import { writeFile } from "node:fs/promises";
import type { AuditLogExportResult, SaveTextFileResult } from "@openadminos/agent-sdk";

/** Host-generated audit content never makes a round trip through renderer file IPC. */
export async function saveAuditLogExport(
  exported: AuditLogExportResult,
  chooseFile: (options: { defaultPath: string; filters: { name: string; extensions: string[] }[] }) => Promise<SaveTextFileResult>,
): Promise<AuditLogExportResult> {
  const savedFile = await chooseFile({
    defaultPath: exported.suggestedName,
    filters: [{ name: exported.format.toUpperCase(), extensions: [exported.format] }],
  });
  if (!savedFile.canceled && savedFile.filePath) {
    await writeFile(savedFile.filePath, exported.content, "utf8");
  } else {
    return { ...exported, content: "", savedFile: { canceled: true } };
  }
  return { ...exported, content: "", savedFile };
}
