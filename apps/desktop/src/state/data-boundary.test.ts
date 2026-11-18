import { describe, expect, it } from "vitest";
import { createMockAppState } from "../test/test-utils";
import { deriveDataBoundary } from "./data-boundary";
import type { ProviderSummary } from "../shared/openAdminOS";

describe("the status strip boundary for Copilot Fusion", () => {
  it("names the tier and says who sees the prompt", () => {
    const copilot: ProviderSummary = {
      id: "copilot", name: "GitHub Copilot CLI", description: "", isLocal: false, status: "connected",
      models: ["fusion-high"], modelLabels: { "fusion-high": "Copilot Fusion High" },
    };
    const boundary = deriveDataBoundary(createMockAppState({ providers: [copilot], activeProviderId: "copilot", activeModelByProviderId: { copilot: "fusion-high" } }));
    expect(boundary.kind).toBe("hosted");
    expect(boundary.model).toBe("Copilot Fusion High");
    expect(boundary.kind === "hosted" ? boundary.modelNote : undefined).toBe("Several models may see each prompt");
    expect(boundary.tooltip).toContain("Several models may see each prompt.");
  });
});
