import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { graphCacheRequestFromNextLink } from "./state-helpers.js";

describe("Graph cache nextLink validation", () => {
  it("keeps beta paths, query values, and caller headers", () => {
    assert.deepEqual(
      graphCacheRequestFromNextLink(
        "https://graph.microsoft.com/beta/users?%24skiptoken=abc&%24top=100",
        { ConsistencyLevel: "eventual" },
      ),
      {
        path: "/users",
        query: { $skiptoken: "abc", $top: "100" },
        headers: { ConsistencyLevel: "eventual" },
      },
    );
  });

  it("rejects non-beta and cross-origin continuation URLs", () => {
    assert.throws(
      () => graphCacheRequestFromNextLink("https://graph.microsoft.com/v1.0/users", undefined),
      /required beta endpoint/,
    );
    assert.throws(
      () => graphCacheRequestFromNextLink("https://example.invalid/beta/users", undefined),
      /unsafe cache paging URL/,
    );
  });
});

import { fetchGraphCachePages } from "./state-helpers.js";
import type { RunGraphApi } from "@openadminos/agent-sdk";

it("complete preload passes the old page/row caps and deduplicates IDs", async () => {
  let requests = 0;
  const graph = { request: async () => {
    const page = requests++;
    return { value: Array.from({length:101}, (_, i) => ({id:String(page * 100 + i)})), ...(page < 11 ? { "@odata.nextLink": `https://graph.microsoft.com/beta/users?$skiptoken=${page+1}` } : {}) };
  }} as unknown as RunGraphApi;
  const result = await fetchGraphCachePages(graph, {path:"/users"}, undefined, true);
  assert.equal(requests,12); assert.equal(result.rows.length,1201); assert.equal(result.pageLimitReached,false);
});

it("exactly reaching the row cap on the last page is complete", async () => {
  const graph = {request:async()=>({value:Array.from({length:1000},(_,i)=>({id:String(i)}))})} as unknown as RunGraphApi;
  assert.equal((await fetchGraphCachePages(graph,{path:"/users"})).pageLimitReached,false);
});

it("cancelled paging and repeated continuation links fail instead of returning a complete collection", async () => {
  const controller = new AbortController();
  const graph = {request:async()=>{controller.abort();return {value:[{id:"a"}]};}} as unknown as RunGraphApi;
  await assert.rejects(fetchGraphCachePages(graph,{path:"/users"},controller.signal,true), /abort/i);
  const loop = {request:async()=>({value:[],"@odata.nextLink":"https://graph.microsoft.com/beta/users?$skiptoken=same"})} as unknown as RunGraphApi;
  await assert.rejects(fetchGraphCachePages(loop,{path:"/users"},undefined,true),/repeated/);
});

import { boundedConversationMemory, buildIntuneChatSources, CHAT_MEMORY_MAX_CHARS, executedResourcesForAnswer, isGraphCacheStatusStale, resourcesFromToolTrace, toolRefreshedResources } from "./state-helpers.js";
import type { GraphCacheResourceStatus, IntuneChatMessage, IntuneChatToolTraceEntry } from "@openadminos/agent-sdk";

describe("chat sources come from executed tools, not the plan", () => {
  const traceEntry = (tool: IntuneChatToolTraceEntry["tool"], params: unknown, error?: string): IntuneChatToolTraceEntry => ({
    id: `trace-${tool}`,
    tool,
    params,
    resultSummary: "ok",
    durationMs: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:00:01.000Z",
    ...(error ? { error } : {}),
  });
  const status = (resource: GraphCacheResourceStatus["resource"]): GraphCacheResourceStatus => ({
    resource,
    label: resource,
    rows: 3,
    refreshedAt: "2026-08-01T09:00:00.000Z",
    scopeSet: [],
  });

  it("derives resources from successful trace entries only", () => {
    const trace = [
      traceEntry("list_cached_resources", {}),
      traceEntry("query_cache", { resource: "managedDevices" }),
      traceEntry("query_cache", { resource: "users" }, "boom"),
      traceEntry("refresh_resource", { resource: "groups" }),
      traceEntry("query_drift", { resource: "managedDevices" }),
      traceEntry("graph_get", { path: "/users" }),
      traceEntry("graph_get", { path: "/me" }),
      traceEntry("web_search", { query: "public" }),
      traceEntry("find_graph_endpoint", { query: "devices" }),
    ];
    assert.deepEqual(
      [...resourcesFromToolTrace(trace)].sort(),
      ["groups", "managedDevices", "users"],
    );
  });

  it("shows executed resources as sources and drops planned-but-unused ones", () => {
    const cacheStatus = [status("managedDevices"), status("users"), status("groups")];
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["managedDevices", "users"],
      executedResources: ["managedDevices", "groups"],
      refreshedResources: new Set(),
    });
    assert.deepEqual(sources.map((source) => source.resource).sort(), ["groups", "managedDevices"]);
  });

  it("yields no sources when nothing was executed", () => {
    const sources = buildIntuneChatSources({
      cacheStatus: [status("managedDevices")],
      plannedResources: ["managedDevices"],
      executedResources: [],
      refreshedResources: new Set(),
    });
    assert.deepEqual(sources, []);
  });

  it("decides executed vs planned sources per answer mode", () => {
    const queried = [traceEntry("query_cache", { resource: "managedDevices" })];
    const inventoryOnly = [traceEntry("list_cached_resources", {})];
    const webOnly = [traceEntry("web_search", { query: "public" })];

    assert.deepEqual(
      [...(executedResourcesForAnswer({ toolTrace: queried, usedDeterministic: false, usedNoData: false }) ?? [])],
      ["managedDevices"],
    );
    // Inventory-only answers read every resource's status; planned is honest.
    assert.equal(executedResourcesForAnswer({ toolTrace: inventoryOnly, usedDeterministic: false, usedNoData: false }), undefined);
    // Web-only answers must not claim tenant sources.
    assert.deepEqual([...(executedResourcesForAnswer({ toolTrace: webOnly, usedDeterministic: false, usedNoData: false }) ?? [])], []);
    // Deterministic answers are built from planned rows.
    assert.equal(executedResourcesForAnswer({ toolTrace: queried, usedDeterministic: true, usedNoData: false }), undefined);
    // Write blocks, named agents, and failures read no data for the answer.
    assert.deepEqual([...(executedResourcesForAnswer({ toolTrace: queried, usedDeterministic: false, usedNoData: true }) ?? [])], []);
    // No trace at all: planned fallback.
    assert.equal(executedResourcesForAnswer({ toolTrace: undefined, usedDeterministic: false, usedNoData: false }), undefined);
  });

  it("collects resources refreshed by the refresh_resource tool", () => {
    const trace = [
      traceEntry("refresh_resource", { resource: "groups" }),
      traceEntry("refresh_resource", { resource: "users" }, "boom"),
      traceEntry("query_cache", { resource: "users" }),
    ];
    assert.deepEqual([...toolRefreshedResources(trace)], ["groups"]);
  });

  it("uses per-resource TTLs and retries errored resources (multi-tenant preflight)", () => {
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    // Sign-ins go stale after 15 minutes: 20 minutes old is stale even
    // though a flat 6h rule would call it fresh.
    assert.equal(isGraphCacheStatusStale({ ...status("signIns"), refreshedAt: at(20 * 60 * 1000) }), true);
    // A 23h-old default-TTL resource (24h) is still fresh.
    assert.equal(isGraphCacheStatusStale({ ...status("deviceCompliancePolicies"), refreshedAt: at(23 * 60 * 60 * 1000) }), false);
    // Errored resources are retried, matching the single-tenant send path.
    assert.equal(isGraphCacheStatusStale({ ...status("managedDevices"), refreshedAt: at(60 * 1000), lastError: "HTTP 403" }), true);
  });

  it("bounds conversation memory to the last four turns under a hard cap", () => {
    const message = (index: number, role: "user" | "assistant", content: string, status: IntuneChatMessage["status"] = "completed"): IntuneChatMessage => ({
      id: `msg-${index}`,
      conversationId: "chat-1",
      role,
      content,
      status,
      createdAt: `2026-08-01T10:0${index}:00.000Z`,
    });
    const history: IntuneChatMessage[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      history.push(message(turn * 2 - 1, "user", `Question ${turn}`));
      history.push(message(turn * 2, "assistant", `Answer ${turn}`));
    }
    history.push(message(99, "assistant", "partial junk", "failed"));

    const memory = boundedConversationMemory(history);
    assert.ok(memory);
    assert.match(memory, /Question 6/);
    assert.match(memory, /Answer 3/);
    assert.doesNotMatch(memory, /Question 2/);
    assert.doesNotMatch(memory, /partial junk/);
    assert.ok(memory.length <= CHAT_MEMORY_MAX_CHARS);

    const longHistory = [
      message(1, "user", "x".repeat(5000)),
      message(2, "assistant", "y".repeat(5000)),
      message(3, "user", "latest question"),
      message(4, "assistant", "latest answer"),
    ];
    const longMemory = boundedConversationMemory(longHistory);
    assert.ok(longMemory);
    assert.ok(longMemory.length <= CHAT_MEMORY_MAX_CHARS);
    assert.match(longMemory, /latest answer/);

    assert.equal(boundedConversationMemory([]), undefined);
    assert.equal(boundedConversationMemory([message(1, "assistant", " ", "completed")]), undefined);
  });

  it("falls back to planned resources when no trace exists (deterministic path)", () => {
    const sources = buildIntuneChatSources({
      cacheStatus: [status("managedDevices"), status("users")],
      plannedResources: ["users"],
      refreshedResources: new Set(),
    });
    assert.deepEqual(sources.map((source) => source.resource), ["users"]);
  });
});
