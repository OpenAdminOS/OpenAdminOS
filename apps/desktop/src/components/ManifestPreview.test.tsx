import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentManifestPreview } from "@openadminos/agent-sdk";
import { ManifestPreview, ManifestSections } from "./ManifestPreview";

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
  for (const Component of [ManifestSections, ManifestPreview]) {
    it(`shows declared write limits in ${Component.name}`, () => {
      const preview = previewWithoutResult();
      preview.manifest.descriptor.mode = "write";
      preview.manifest.descriptor.writeLimits = { maxActions: 50, maxActionsPerOperation: { "graph-write": 20 } };
      render(<Component preview={preview} />);
      expect(screen.getByText("Write limit: 50 actions per run (manifest).")).toBeInTheDocument();
      expect(screen.getByText("graph-write")).toBeInTheDocument();
      expect(screen.getByText(/at most 20 actions per run/)).toBeInTheDocument();
    });

    it(`shows the host default for write agents in ${Component.name}`, () => {
      const preview = previewWithoutResult();
      preview.manifest.descriptor.mode = "write";
      render(<Component preview={preview} />);
      expect(screen.getByText("Write limit: 100 actions per run (host default).")).toBeInTheDocument();
    });
  }

  it("omits write limits for read agents", () => {
    const preview = previewWithoutResult();
    preview.manifest.descriptor.mode = "read";
    render(<ManifestSections preview={preview} />);
    expect(screen.queryByText(/Write limit:/)).not.toBeInTheDocument();
  });

  it("omits the result section when the manifest declares no result template", () => {
    render(<ManifestSections preview={previewWithoutResult()} />);

    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(screen.queryByText("What the run produces")).not.toBeInTheDocument();
  });
});
