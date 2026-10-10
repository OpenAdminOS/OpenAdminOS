import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentManifestPreview } from "@openadminos/agent-sdk";
import { ManifestSections } from "./ManifestPreview";

function previewWithoutResult(): AgentManifestPreview {
  return {
    kind: "agent-template",
    sourceText: "",
    manifest: {
      descriptor: {
        id: "offboarding-agent",
        name: "Offboarding agent",
        description: "Write plan without a result template.",
        version: "1.1.0",
        author: { name: "OpenAdminOS" },
        category: "devices",
      },
      definition: { settings: [] },
      skills: [],
    },
  } as unknown as AgentManifestPreview;
}

describe("ManifestSections", () => {
  it("omits the result section when the manifest declares no result template", () => {
    render(<ManifestSections preview={previewWithoutResult()} />);

    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(screen.queryByText("What the run produces")).not.toBeInTheDocument();
  });
});
