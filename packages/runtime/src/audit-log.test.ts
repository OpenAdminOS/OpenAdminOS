import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { appendSandboxEvent, AuditLogStore, graphRequestAuditSink } from "./audit-log.js";

const context = { tenantId: "tenant-1", organizationId: "org-1", sandboxId: "mini-pc", runId: "run_1", agentSlug: "find-inactive-devices", initiator: "schedule" as const };

describe("graphRequestAuditSink", () => {
  it("records sandbox request events with the organization, in a chain that verifies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oaos-audit-"));
    const store = new AuditLogStore(join(dir, "openadminos.db"));
    try {
      const sink = graphRequestAuditSink(store, context);
      await sink.attempted({ attemptId: "a1", method: "GET", path: "/deviceManagement/managedDevices", queryDigest: "ab" });
      await sink.result({ attemptId: "a1", method: "GET", path: "/deviceManagement/managedDevices", outcome: "ok", status: 200, durationMs: 4 });
      appendSandboxEvent(store, context, "sandbox.token.acquired", { roles: 1 });
      const { events } = store.readVerified();
      assert.deepEqual(events.map((event) => event.type), ["graph.request.attempted", "graph.request.result", "sandbox.token.acquired"]);
      for (const event of events) {
        assert.equal(event.source, "sandbox");
        assert.equal(event.organizationId, "org-1");
        assert.equal(event.tenantId, "tenant-1");
        assert.equal(event.details.sandboxId, "mini-pc");
      }
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws from attempted when the log cannot record, so the request is not sent", async () => {
    const store = new AuditLogStore(":memory:");
    store.close();
    const sink = graphRequestAuditSink(store, context);
    assert.throws(() => sink.attempted({ attemptId: "a2", method: "GET", path: "/users" }));
  });
});
