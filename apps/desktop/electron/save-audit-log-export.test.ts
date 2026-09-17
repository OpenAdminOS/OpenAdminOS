import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AuditLogExportResult } from "@openadminos/agent-sdk";
import { saveAuditLogExport } from "./save-audit-log-export.js";

it("saves host-generated audit exports above renderer IPC limits without truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audit-save-"));
  try {
    for (const format of ["json", "csv"] as const) {
      const exported: AuditLogExportResult = {
        format, suggestedName: `audit.${format}`,
        mimeType: format === "json" ? "application/json" : "text/csv",
        content: "evidence ü\n".repeat(250_000), generatedAt: "2026-09-15T00:00:00Z",
        eventCount: 250_000,
        hashChain: { algorithm: "sha256", startHash: "0".repeat(64), finalHash: "a".repeat(64) },
      };
      const filePath = join(directory, exported.suggestedName);
      const result = await saveAuditLogExport(exported, async (options) => {
        assert.deepEqual(options.filters, [{ name: format.toUpperCase(), extensions: [format] }]);
        return { canceled: false, filePath };
      });
      assert.equal(await readFile(filePath, "utf8"), exported.content);
      assert.equal(result.content, "");
      assert.equal(result.eventCount, exported.eventCount);
      assert.deepEqual(result.hashChain, exported.hashChain);
      const canceled = await saveAuditLogExport(exported, async () => ({ canceled: true }));
      assert.equal(canceled.savedFile?.canceled, true);
      assert.equal(canceled.content, "");
      await assert.rejects(saveAuditLogExport(exported, async () => ({ canceled: false, filePath: directory })));
    }
    assert.equal((await readdir(directory)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
