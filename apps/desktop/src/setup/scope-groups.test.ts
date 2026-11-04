import { describe, expect, it } from "vitest";
import { SERVICE_PARTS } from "../shared/openAdminOS";
import type { RequestedScope } from "../shared/openAdminOS";
import { groupRequestedScopes } from "./scope-groups";

const rows: RequestedScope[] = SERVICE_PARTS.flatMap((part) =>
  part.scopes.map((scope) => ({
    service: part.service,
    partId: part.id,
    name: scope.name,
    mode: "read" as const,
    rationale: scope.reason,
  })),
);

describe("setup scope groups", () => {
  it("groups part scopes by service and lists a shared scope once per service", () => {
    const grouped = groupRequestedScopes(rows);
    expect(grouped.map((group) => [group.id, group.scopes.length])).toEqual([
      ["intune", 10],
      ["entra", 11],
      ["defender", 3],
    ]);
    for (const group of grouped) {
      const names = group.scopes.map((scope) => scope.name);
      expect(new Set(names).size).toBe(names.length);
    }
    expect(grouped.find((group) => group.id === "intune")?.title).toBe("Intune");
  });

  it("keeps rows of an unknown service visible in an Other group", () => {
    const [group] = groupRequestedScopes([
      {
        service: "exchange",
        partId: "exchange.mail",
        name: "New.Read.All",
        mode: "read",
        rationale: "A future capability.",
      },
    ]);
    expect(group?.id).toBe("other");
    expect(group?.scopes[0]?.name).toBe("New.Read.All");
  });
});
