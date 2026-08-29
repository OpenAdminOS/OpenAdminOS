import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_READ_SCOPE_NAMES } from "../shared/openAdminOS";
import type { RequestedScope } from "../shared/openAdminOS";
import { groupRequestedScopes, SCOPE_GROUP_BY_NAME } from "./scope-groups";

const knownScopeNames = [...DEFAULT_GRAPH_READ_SCOPE_NAMES];

describe("setup scope groups", () => {
  it("classifies every default tenant scope exactly once", () => {
    expect(Object.keys(SCOPE_GROUP_BY_NAME).sort()).toEqual([...knownScopeNames].sort());
    const scopes: RequestedScope[] = knownScopeNames.map((name) => ({
      name,
      mode: "read",
      rationale: `${name} rationale`,
    }));
    const grouped = groupRequestedScopes(scopes);
    expect(grouped.flatMap((group) => group.scopes.map((scope) => scope.name)).sort()).toEqual(
      [...knownScopeNames].sort(),
    );
    expect(grouped.map((group) => [group.id, group.scopes.length])).toEqual([
      ["devices", 6],
      ["apps", 2],
      ["directory", 4],
      ["identity", 3],
      ["security", 6],
    ]);
  });

  it("keeps future scopes visible in an Other group", () => {
    const [group] = groupRequestedScopes([
      { name: "New.Read.All", mode: "read", rationale: "A future capability." },
    ]);
    expect(group?.id).toBe("other");
    expect(group?.scopes[0]?.name).toBe("New.Read.All");
  });
});
