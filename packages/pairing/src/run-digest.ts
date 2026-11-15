import { createHash } from "node:crypto";

import { canonicalJson } from "@openadminos/runtime";

/** The audit event types that name a run record's digest. */
export const RUN_DIGEST_EVENTS = Object.freeze(["sandbox.run.finished", "sandbox.run.rewritten"] as const);

/**
 * SHA-256 hex of the canonical JSON of a run record. A sandbox puts it in
 * the `sandbox.run.finished` event, and in `sandbox.run.rewritten` each
 * time it changes a finished record, so the desktop can check that the
 * record it received is the one the verified audit rows name.
 */
export function runRecordDigest(run: unknown): string {
  return createHash("sha256").update(canonicalJson(run), "utf8").digest("hex");
}
