import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalClientId,
  graphCacheRequestFromNextLink,
  humanizeMsalError,
  sanitizeSavedAppRegistrations,
  tokenCacheForPartition,
  tokenCachePartition,
} from "./state-helpers.js";
import { GRAPH_CLI_CLIENT_ID, OPENADMINOS_CLIENT_ID } from "@openadminos/runtime";

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
  const graphTraceEntry = (): IntuneChatToolTraceEntry => ({
    ...traceEntry("graph_get", { path: "/users", query: { $select: "id,displayName" } }),
    graphSource: {
      path: "/users",
      query: { $select: "id,displayName", $top: "50" },
      rows: 1,
      pagesFetched: 1,
      truncated: true,
    },
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

  it("describes live graph_get evidence from the execution, not the cache", () => {
    const cacheStatus = [{
      resource: "users" as const,
      label: "Users",
      rows: 500,
      pages: 10,
      pageLimitReached: false,
      refreshedAt: "2026-08-01T09:00:00.000Z",
      scopeSet: [],
    }];
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [graphTraceEntry()],
      refreshedResources: new Set(),
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.source, "live");
    assert.equal(sources[0]?.rows, 1);
    assert.equal(sources[0]?.pages, 1);
    assert.equal(sources[0]?.pageLimitReached, true);
    assert.equal(sources[0]?.refreshedAt, "2026-08-01T10:00:01.000Z");
    assert.equal(sources[0]?.path, "/users");
    assert.deepEqual(sources[0]?.select, ["id", "displayName"]);

    // The deterministic fallback (no executedResources) must describe
    // its snapshot pack, not the abandoned investigation's live read.
    const fallbackSources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      toolTrace: [graphTraceEntry()],
      refreshedResources: new Set(),
    });
    assert.equal(fallbackSources[0]?.source, "cache");
    assert.equal(fallbackSources[0]?.rows, 500);
    assert.equal(fallbackSources[0]?.refreshedAt, "2026-08-01T09:00:00.000Z");

    // When the same answer also read the cache for this resource, the
    // live lookup must not hide that older evidence: both appear.
    const cacheRead = {
      ...traceEntry("query_cache", { resource: "users" }),
      cacheSource: { resource: "users", rows: 500, refreshedAt: "2026-08-01T09:00:00.000Z" },
    };
    const mixedSources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [cacheRead, graphTraceEntry()],
      refreshedResources: new Set(),
    });
    assert.equal(mixedSources.length, 2);
    assert.deepEqual(
      mixedSources.map((source) => [source.source, source.rows, source.refreshedAt]),
      [
        ["cache", 500, "2026-08-01T09:00:00.000Z"],
        ["live", 1, "2026-08-01T10:00:01.000Z"],
      ],
    );

    // A refresh during the investigation does not rewrite the
    // provenance of the snapshot read before it: both snapshots stay.
    const refreshedStatus = [{
      ...cacheStatus[0]!,
      rows: 2,
      refreshedAt: "2026-08-01T10:00:01.000Z",
    }];
    const prePostRefresh = buildIntuneChatSources({
      cacheStatus: refreshedStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [
        {
          ...traceEntry("query_cache", { resource: "users" }),
          cacheSource: { resource: "users", rows: 1, refreshedAt: "2026-08-01T08:00:00.000Z" },
        },
        {
          ...traceEntry("refresh_resource", { resource: "users" }),
          cacheSource: {
            resource: "users",
            rows: 2,
            refreshedAt: "2026-08-01T10:00:01.000Z",
            fromRefresh: true,
          },
        },
      ],
      refreshedResources: new Set(["users"]),
    });
    assert.deepEqual(
      prePostRefresh.map((source) => [source.source, source.rows, source.refreshedAt]),
      [
        ["cache", 1, "2026-08-01T08:00:00.000Z"],
        ["live", 2, "2026-08-01T10:00:01.000Z"],
      ],
    );

    // Distinct live lookups for one resource all stay visible, with
    // their own truncation flags.
    const detailLookup = {
      ...traceEntry("graph_get", { path: "/users/user-1" }),
      completedAt: "2026-08-01T10:00:02.000Z",
      graphSource: { path: "/users/user-1", rows: 1, pagesFetched: 1, truncated: false },
    };
    const multiLive = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [graphTraceEntry(), detailLookup],
      refreshedResources: new Set(),
    });
    assert.deepEqual(
      multiLive.map((source) => [source.path, source.rows, source.pageLimitReached]),
      [
        ["/users", 1, true],
        ["/users/user-1", 1, false],
      ],
    );

    // A snapshot that survived a failed refresh keeps its warning on
    // the per-read source entry.
    const warnedSources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [
        {
          ...traceEntry("query_cache", { resource: "users" }),
          cacheSource: {
            resource: "users",
            rows: 500,
            refreshedAt: "2026-08-01T09:00:00.000Z",
            error: "HTTP 403: reconnect the tenant",
          },
        },
      ],
      refreshedResources: new Set(),
    });
    assert.equal(warnedSources[0]?.error, "HTTP 403: reconnect the tenant");

    // The warning also survives when the same snapshot was already
    // read before the refresh failed: dedupe merges it in.
    const warnedAfterReread = buildIntuneChatSources({
      cacheStatus,
      plannedResources: ["users"],
      executedResources: ["users"],
      toolTrace: [
        {
          ...traceEntry("query_cache", { resource: "users" }),
          cacheSource: { resource: "users", rows: 500, refreshedAt: "2026-08-01T09:00:00.000Z" },
        },
        {
          ...traceEntry("query_cache", { resource: "users" }),
          cacheSource: {
            resource: "users",
            rows: 500,
            refreshedAt: "2026-08-01T09:00:00.000Z",
            error: "HTTP 403: reconnect the tenant",
          },
        },
      ],
      refreshedResources: new Set(),
    });
    assert.equal(warnedAfterReread.length, 1);
    assert.equal(warnedAfterReread[0]?.error, "HTTP 403: reconnect the tenant");
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

    // Failed or cancelled exchanges are not completed turns: their user
    // prompts must not ride along just because the assistant side was
    // filtered out.
    const cancelled: IntuneChatMessage[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      cancelled.push(message(100 + turn * 2 - 1, "user", `Abandoned prompt ${turn}`));
      cancelled.push(message(100 + turn * 2, "assistant", "Stopped", "cancelled"));
    }
    const mixed = [
      ...cancelled,
      message(201, "user", "Kept question"),
      message(202, "assistant", "Kept answer"),
    ];
    const mixedMemory = boundedConversationMemory(mixed);
    assert.ok(mixedMemory);
    assert.match(mixedMemory, /Kept question/);
    assert.doesNotMatch(mixedMemory, /Abandoned prompt/);
    assert.equal(boundedConversationMemory(cancelled), undefined);
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

describe("sign-in errors name the registration used and the fix", () => {
  const custom = {
    kind: "custom" as const,
    clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    authority: "https://login.microsoftonline.com/common",
  };
  const openAdminOS = { kind: "openadminos" as const, clientId: OPENADMINOS_CLIENT_ID };
  const customName = "your app registration (client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)";
  const msal = (message: string) => new Error(message);

  it("AADSTS50011 asks for the http://localhost redirect under Mobile and desktop applications", () => {
    const text = humanizeMsalError(
      msal("AADSTS50011: The redirect URI 'http://localhost:51234' specified in the request does not match the redirect URIs configured for the application."),
      custom,
    );
    assert.match(text, new RegExp(customName.replace(/[()]/g, "\\$&")));
    assert.match(text, /Mobile and desktop applications with the redirect URI http:\/\/localhost/);
  });

  it("AADSTS500113 is treated as the same missing redirect", () => {
    assert.match(
      humanizeMsalError(msal("AADSTS500113: No reply address is registered for the application."), custom),
      /redirect URI http:\/\/localhost/,
    );
  });

  it("AADSTS7000218 asks to allow public client flows", () => {
    const text = humanizeMsalError(
      msal("AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'."),
      custom,
    );
    assert.match(text, /client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
    assert.match(text, /set Allow public client flows to Yes/);
    assert.match(text, /never uses a client secret/);
  });

  it("AADSTS700016 asks to check the client ID and directory ID", () => {
    const text = humanizeMsalError(
      msal("AADSTS700016: Application with identifier 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' was not found in the directory 'Fabrikam'."),
      custom,
    );
    assert.match(text, /could not find your app registration \(client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\)/);
    assert.match(text, /Application \(client\) ID/);
    assert.match(text, /Directory \(tenant\) ID/);
  });

  it("AADSTS700016 for the OpenAdminOS app points at third-party app blocking", () => {
    const text = humanizeMsalError(
      msal("AADSTS700016: Application with identifier was not found in the directory."),
      openAdminOS,
    );
    assert.match(text, new RegExp(`the OpenAdminOS app \\(client ID ${OPENADMINOS_CLIENT_ID}\\)`));
    assert.match(text, /connect with your own app registration/);
  });

  it("AADSTS50194 asks for the Directory (tenant) ID of a single-tenant app", () => {
    const text = humanizeMsalError(
      msal("AADSTS50194: Application 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' is not configured as a multi-tenant application."),
      custom,
    );
    assert.match(text, /^Your app registration \(client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\) is single-tenant/);
    assert.match(text, /Enter the Directory \(tenant\) ID/);
  });

  it("AADSTS65001 asks to grant admin consent or use the setup script", () => {
    const text = humanizeMsalError(
      msal("AADSTS65001: The user or administrator has not consented to use the application."),
      custom,
    );
    assert.match(text, /Admin consent has not been granted for your app registration/);
    assert.match(text, /Grant admin consent/);
    assert.match(text, /setup script/);
    assert.match(
      humanizeMsalError(msal("AADSTS65001: not consented"), openAdminOS),
      /Admin consent is required for the OpenAdminOS app/,
    );
  });

  it("defaults to the OpenAdminOS app and never mentions the Microsoft Graph CLI", () => {
    const codes = ["50011", "7000218", "700016", "50194", "65001", "50105", "900023"];
    for (const code of codes) {
      const text = humanizeMsalError(msal(`AADSTS${code}: failure`));
      assert.doesNotMatch(text, /Graph CLI/);
      assert.match(text, /the OpenAdminOS app|The OpenAdminOS app|OpenAdminOS app/);
    }
  });

  it("names a tenant still pinned to its original client by that client ID", () => {
    const text = humanizeMsalError(
      msal("AADSTS65001: not consented"),
      { kind: "openadminos", clientId: GRAPH_CLI_CLIENT_ID },
    );
    assert.match(text, new RegExp(`client ID ${GRAPH_CLI_CLIENT_ID}`));
    assert.doesNotMatch(text, /Graph CLI/);
  });

  it("keeps the existing mappings for other errors", () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "TenantConnectCancelledError";
    assert.equal(humanizeMsalError(cancelled), "Sign-in was cancelled. Nothing was connected.");
    assert.match(humanizeMsalError(msal("fetch failed")), /Couldn't reach Microsoft's sign-in endpoint/);
    assert.match(humanizeMsalError(msal("invalid_grant")), /previous sign-in session expired/);
    assert.match(humanizeMsalError(msal("AADSTS50020: user account from identity provider does not exist")), /doesn't exist in this tenant/);
    assert.match(
      humanizeMsalError(msal("AADSTS50105: The signed in user is not assigned to a role"), custom),
      /isn't assigned to your app registration \(client ID/,
    );
    assert.equal(
      humanizeMsalError(msal("something odd"), custom),
      "Sign-in with your app registration (client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee) failed: something odd",
    );
  });
});

describe("client ID canonical form and token cache partitions", () => {
  const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const UPPER = CLIENT_ID.toUpperCase();
  const RT_KEY = `home.tid-login.microsoftonline.com-refreshtoken-${CLIENT_ID}----`;
  const refreshToken = (clientId: string, secret: string) => ({
    home_account_id: "home.tid",
    environment: "login.microsoftonline.com",
    credential_type: "RefreshToken",
    client_id: clientId,
    secret,
  });

  it("lower-cases and trims client IDs and resolves the default partition", () => {
    assert.equal(canonicalClientId(` ${UPPER} `), CLIENT_ID);
    assert.equal(tokenCachePartition({ clientId: UPPER }), CLIENT_ID);
    assert.equal(tokenCachePartition(undefined), OPENADMINOS_CLIENT_ID);
    assert.equal(tokenCachePartition({ clientId: OPENADMINOS_CLIENT_ID.toUpperCase() }), OPENADMINOS_CLIENT_ID);
  });

  it("stores remembered registrations with the canonical client ID", () => {
    assert.deepEqual(
      sanitizeSavedAppRegistrations([{ clientId: UPPER, lastUsedAt: "2026-11-03T10:00:00.000Z" }]),
      [{ clientId: CLIENT_ID, lastUsedAt: "2026-11-03T10:00:00.000Z" }],
    );
  });

  it("returns a cache with nothing to change unchanged", () => {
    const cache = JSON.stringify({ RefreshToken: { [RT_KEY]: refreshToken(CLIENT_ID, "rt") } });
    assert.equal(tokenCacheForPartition(cache, [], CLIENT_ID), cache);
    assert.equal(tokenCacheForPartition("", [], CLIENT_ID), "");
    assert.equal(tokenCacheForPartition("not json", ["{}"], CLIENT_ID), "not json");
  });

  it("gives credentials written with a differently cased client ID the canonical ID", () => {
    const cache = JSON.stringify({
      RefreshToken: { [RT_KEY]: refreshToken(UPPER, "rt") },
      AppMetadata: { [`appmetadata-login.microsoftonline.com-${CLIENT_ID}`]: { client_id: UPPER, environment: "login.microsoftonline.com" } },
      RefreshTokenOther: { x: { client_id: "11111111-2222-4333-8444-555555555555" } },
    });
    const merged = JSON.parse(tokenCacheForPartition(cache, [], CLIENT_ID)) as Record<string, Record<string, { client_id: string }>>;
    assert.equal(merged.RefreshToken?.[RT_KEY]?.client_id, CLIENT_ID);
    assert.equal(Object.values(merged.AppMetadata ?? {})[0]?.client_id, CLIENT_ID);
    assert.equal(merged.RefreshTokenOther?.x?.client_id, "11111111-2222-4333-8444-555555555555");
  });

  it("merges legacy caches under the primary cache and skips unreadable ones", () => {
    const primary = JSON.stringify({ RefreshToken: { [RT_KEY]: refreshToken(CLIENT_ID, "primary") } });
    const legacy = JSON.stringify({
      RefreshToken: {
        [RT_KEY]: refreshToken(UPPER, "legacy"),
        "other.tid-login.microsoftonline.com-refreshtoken-x----": refreshToken(UPPER, "other"),
      },
    });
    const merged = JSON.parse(tokenCacheForPartition(primary, [legacy, "not json"], CLIENT_ID)) as Record<
      string,
      Record<string, { client_id: string; secret: string }>
    >;
    assert.equal(merged.RefreshToken?.[RT_KEY]?.secret, "primary");
    assert.equal(merged.RefreshToken?.["other.tid-login.microsoftonline.com-refreshtoken-x----"]?.client_id, CLIENT_ID);
  });
});
