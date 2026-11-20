import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import type { WorkerMessage } from "./classification-worker-client.js";
import { ClassificationLedger, decodeWorkerLargeValue } from "./request-classification.js";
import { packWorkerGraphResult } from "./graph-ingress-classification.js";
import { MAX_READ_SIDECAR_UNITS, packCacheIdentity, prepareCacheClassification, type CacheStartupPage, type CacheClassificationRow } from "./cache-classification.js";
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
  // Background work must never create a database if its store was removed.
  const db = new DatabaseSync(`${pathToFileURL(page.dbPath).href}?mode=ro`, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const prefix = `[${GRAPH_FIELD_CLASSES_VERSION},%`;
    const select = db.prepare(`SELECT g.rowid, g.snapshot_id AS snapshotId, g.graph_id AS graphId, g.display_name AS displayName, g.raw_json AS rawJson
      FROM graph_resources g
      ${page.indexOnly ? "" : "LEFT JOIN graph_classification_sidecars s ON s.cache_rowid = g.rowid AND s.snapshot_id = g.snapshot_id AND s.tenant_id = g.tenant_id AND s.resource = g.resource"}
      WHERE g.tenant_id = ? AND g.resource = ? AND g.rowid > ?
      ${page.snapshotId === undefined ? "" : "AND g.snapshot_id = ?"}
      ${page.indexOnly ? "" : `AND length(CAST(g.raw_json AS BLOB)) <= 262144
        AND COALESCE(s.field_map_version, 0) <> ? AND COALESCE(g.classification_json, '') NOT LIKE ?`}
      ORDER BY g.rowid LIMIT ?`);
    const params = [page.tenantId, page.resource, page.afterRowId, ...(page.snapshotId === undefined ? [] : [page.snapshotId])];
    const rows = select.all(...params, ...(page.indexOnly ? [64] : [GRAPH_FIELD_CLASSES_VERSION, prefix, 8])) as
      unknown as Array<CacheClassificationRow & { rowid: number; snapshotId: string }>;
    if (!rows.length) return { sidecars: [] };
    const result = prepareCacheClassification(rows, options, page.indexOnly, indexNames, page.indexOnly);
    const nextRowId = rows.at(-1)!.rowid;
    if (page.indexOnly) {
      const egress = packCacheIdentity(result.egressIndex);
      const firstNames = packCacheIdentity(result.firstNames);
      return { sidecars: [], nextRowId, identityBatches: {
        egress: egress.batches, firstNames: firstNames.batches, incomplete: egress.incomplete || firstNames.incomplete,
      } };
    }
    return { sidecars: [], nextRowId, startupSidecars: rows.flatMap(({ rowid, snapshotId }, i) => {
      const sidecar = result.sidecars[i]!;
      return Buffer.byteLength(sidecar) <= MAX_READ_SIDECAR_UNITS ? [{ rowid, snapshotId, compressed: deflateSync(sidecar) }] : [];
    }) };
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
      const options = { ...(message.type === "graph" ? message.settings : { graphPath: message.graphPath }),
        ...(identityIndex ? { identityIndex } : {}) };
      if (message.type === "graph") {
        const rows = graphRows;
        graphRows = [];
        const data = message.collection === true ? rows : typeof message.collection === "string"
          ? { ...(message.data as Record<string, unknown>), [message.collection]: rows } : message.data;
        const result = packWorkerGraphResult(data, options);
        port.postMessage(result, result.batches);
      } else {
        const result = message.startup ? classifyStartupPage(message.startup, options, message.indexNames)
          : prepareCacheClassification(message.rows, options, message.indexValues, message.indexNames);
        const identity = result.identityBatches;
        port.postMessage(result, identity ? [...identity.egress, ...identity.firstNames] : []);
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
