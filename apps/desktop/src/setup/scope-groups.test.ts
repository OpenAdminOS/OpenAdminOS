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

  it("groups each service by part, in registry order, with reasons", () => {
    const intune = groupRequestedScopes(rows).find((group) => group.id === "intune");
    expect(intune?.parts.map((part) => part.id)).toEqual([
      "intune.people",
      "intune.devices",
      "intune.apps",
    ]);
    const people = intune?.parts[0];
    expect(people?.title).toBe("Users and groups");
    expect(people?.scopes.map((scope) => scope.name)).toEqual([
      "User.Read.All",
      "GroupMember.Read.All",
      "Organization.Read.All",
    ]);
    expect(people?.scopes.every((scope) => scope.rationale.length > 0)).toBe(true);
    // Device.Read.All belongs to both Intune devices and Entra devices.
    const entraDevices = groupRequestedScopes(rows)
      .find((group) => group.id === "entra")
      ?.parts.find((part) => part.id === "entra.devices");
    expect(entraDevices?.scopes.map((scope) => scope.name)).toEqual(["Device.Read.All"]);
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
    expect(group?.parts[0]?.scopes[0]?.name).toBe("New.Read.All");
  });
});
