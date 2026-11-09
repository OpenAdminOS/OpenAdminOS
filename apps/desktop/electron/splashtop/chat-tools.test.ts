import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeIntuneChatTool, isTenantTool, splashtopToolDefinitionsForPrompt, tenantDataSourceForTool, type IntuneChatToolContext, type SplashtopChatContext } from "../intune-chat/tools.js";
import { toolStepFinish, toolStepStart } from "../intune-chat/chat-steps.js";
import { TenantValueIndex } from "../intune-chat/tenant-values.js";

function context(splashtop?: SplashtopChatContext): IntuneChatToolContext & { tenantObservations: TenantValueIndex } {
  return {
    tenantId: "tenant",
    store: {} as never,
    grantedScopes: new Set(),
    graphForScopes: async () => { throw new Error("no Graph in this test"); },
    refreshResource: async () => { throw new Error("no refresh in this test"); },
    getDriftTimeline: async () => { throw new Error("no drift in this test"); },
    tenantObservations: new TenantValueIndex(),
    ...(splashtop ? { splashtop } : {}),
  };
}

const splashtop: SplashtopChatContext = {
  organizationName: "Woodgrove Bank",
  host: "webapi.splashtop.eu",
  tools: ["splashtop_list_computers", "splashtop_list_sessions"],
  read: async (tool) => ({
    tool,
    records: [{ id: 4711, name: "WGB-FINANCE-PC07", host_name: "wgb-finance-pc07" }],
    page: { offset: 0, limit: 25, total: 40, next: { offset: 25, limit: 25 } },
  }),
};

describe("Splashtop tools in Chat", () => {
  it("counts their results as organization data, so their values never reach a public reference", async () => {
    const ctx = context(splashtop);
    assert.equal(isTenantTool("splashtop_list_computers"), true);
    const execution = await executeIntuneChatTool(ctx, "splashtop_list_computers", { limit: 25 });
    assert.equal(execution.trace.error, undefined);
    assert.equal(execution.trace.resultSummary, "1 of 40 Splashtop records returned · more available");
    assert.equal(ctx.tenantObservations.matches("how do I fix WGB-FINANCE-PC07"), true);
    assert.equal(tenantDataSourceForTool("splashtop_list_computers", {}), "splashtop:splashtop_list_computers");
  });

  it("are refused when the organization has no connection, or the token does not reach the part", async () => {
    const none = await executeIntuneChatTool(context(), "splashtop_list_computers", {});
    assert.match(none.trace.error ?? "", /not connected for this organization/);
    const notReached = await executeIntuneChatTool(context(splashtop), "splashtop_list_users", {});
    assert.match(notReached.trace.error ?? "", /does not reach this data/);
  });

  it("are described with the organization and the host they read from, only for offered tools", () => {
    const text = splashtopToolDefinitionsForPrompt(splashtop);
    assert.match(text, /splashtop_list_computers/);
    assert.match(text, /webapi\.splashtop\.eu/);
    assert.doesNotMatch(text, /splashtop_list_users/);
  });

  it("show as Splashtop Open API steps", () => {
    const start = toolStepStart("splashtop_list_sessions", {}, undefined, "Ollama");
    assert.equal(start.title, "Reading Splashtop");
    assert.equal(start.originLabel, "Splashtop Open API");
    const finish = toolStepFinish({ id: "t", tool: "splashtop_list_sessions", params: {}, resultSummary: "3 Splashtop records returned", durationMs: 5, createdAt: "", completedAt: "" });
    assert.equal(finish.title, "Read Splashtop");
  });
});
