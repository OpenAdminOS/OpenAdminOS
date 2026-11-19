import { parentPort } from "node:worker_threads";
import type { WorkerMessage } from "./classification-worker-client.js";
import { ClassificationLedger, decodeWorkerLargeValue } from "./request-classification.js";
import { TenantValueIndex } from "./tenant-value-index.js";

const port = parentPort;
if (!port) throw new Error("Classification worker requires a parent port.");
const ledgers = new Map<number, ClassificationLedger>();
const shards = new Map<number, TenantValueIndex>();

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
    case "drop":
      ledgers.delete(message.id);
      shards.delete(message.id);
      break;
    case "scan": {
      const result = ClassificationLedger.scanInWorker(message, ledgers, shards);
      port.postMessage(result, [result.offsets.buffer as ArrayBuffer]);
      break;
    }
  }
});
