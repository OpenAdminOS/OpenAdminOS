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
