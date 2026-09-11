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
