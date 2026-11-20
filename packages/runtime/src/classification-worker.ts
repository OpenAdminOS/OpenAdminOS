import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import type { WorkerMessage } from "./classification-worker-client.js";
import { ClassificationLedger, decodeWorkerLargeValue } from "./request-classification.js";
import { packWorkerGraphResult } from "./graph-ingress-classification.js";
import { prepareCacheClassification, type CacheStartupPage, type CacheClassificationRow } from "./cache-classification.js";
import { GRAPH_FIELD_CLASSES_VERSION } from "./graph-field-classes.js";
import { TenantValueIndex } from "./tenant-value-index.js";

const port = parentPort;
if (!port) throw new Error("Classification worker requires a parent port.");
const ledgers = new Map<number, ClassificationLedger>();
const shards = new Map<number, TenantValueIndex>();
let graphRows: unknown[] = [];

function classifyStartupPage(
  page: CacheStartupPage, options: Parameters<typeof prepareCacheClassification>[1], indexNames: boolean,
): ReturnType<typeof prepareCacheClassification> {
  const db = new DatabaseSync(page.dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
    const prefix = `[${GRAPH_FIELD_CLASSES_VERSION},%`;
    const select = db.prepare(`SELECT rowid, graph_id AS graphId, display_name AS displayName, raw_json AS rawJson
      FROM graph_resources WHERE tenant_id = ? AND resource = ? AND rowid > ?
      ${page.indexOnly ? "" : "AND (classification_json IS NULL OR classification_json NOT LIKE ?)"}
      ORDER BY rowid LIMIT ?`);
    const params = [page.tenantId, page.resource, page.afterRowId];
    const rows = select.all(...params, ...(page.indexOnly ? [64] : [prefix, 8])) as
      unknown as Array<CacheClassificationRow & { rowid: number }>;
    if (!rows.length) return { sidecars: [] };
    const result = prepareCacheClassification(rows, options, page.indexOnly, indexNames, page.indexOnly);
    if (!page.indexOnly) {
      const update = db.prepare(`UPDATE graph_resources SET classification_json = ?
        WHERE rowid = ? AND tenant_id = ? AND resource = ? AND raw_json = ?
        AND (classification_json IS NULL OR classification_json NOT LIKE ?)`);
      for (const [i, row] of rows.entries()) {
        update.run(result.sidecars[i]!, row.rowid, page.tenantId, page.resource, row.rawJson, prefix);
      }
      result.sidecars = [];
    }
    return { ...result, nextRowId: rows.at(-1)!.rowid };
  } finally {
    db.close();
  }
}

port.on("message", (message: WorkerMessage) => {
  switch (message.type) {
    case "values":
    case "large-value": {
      let ledger = ledgers.get(message.id);
      if (!ledger) ledgers.set(message.id, ledger = new ClassificationLedger());
      ledger.applyWorkerValues(message.type === "values" ? message.values : [decodeWorkerLargeValue(message.value)]);
      break;
    }
    case "identity": {
      let shard = shards.get(message.id);
      if (!shard) shards.set(message.id, shard = new TenantValueIndex());
      for (const entry of message.entries) shard.addWorkerEntry(entry);
      break;
    }
    case "graph-rows":
      graphRows.push(...message.rows);
      break;
    case "drop":
      ledgers.delete(message.id);
      shards.delete(message.id);
      break;
    case "graph":
    case "cache": {
      const indexes = message.shards.flatMap(id => shards.get(id) ?? []);
      const identityIndex = indexes.length ? {
        matches: (text: string) => !TenantValueIndex.spansFor(text, indexes).next().done,
      } : undefined;
      const options = { graphPath: message.graphPath, ...(identityIndex ? { identityIndex } : {}) };
      if (message.type === "graph") {
        const rows = graphRows;
        graphRows = [];
        const data = message.collection === true ? rows : typeof message.collection === "string"
          ? { ...(message.data as Record<string, unknown>), [message.collection]: rows } : message.data;
        const result = packWorkerGraphResult(data, options);
        port.postMessage(result, result.batches);
      } else {
        port.postMessage(message.startup ? classifyStartupPage(message.startup, options, message.indexNames)
          : prepareCacheClassification(message.rows, options, message.indexValues, message.indexNames));
      }
      break;
    }
    case "scan": {
      const result = ClassificationLedger.scanInWorker(message, ledgers, shards);
      port.postMessage(result, [result.offsets.buffer as ArrayBuffer]);
      break;
    }
  }
});
