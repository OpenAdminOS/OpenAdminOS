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

  it("labels declared write requests in the permissions preview", () => {
    const preview = previewWithoutResult();
    preview.manifest.descriptor.mode = "write";
    preview.manifest.skills = [
      {
        id: "load_users",
        format: "graph",
        label: "Load users",
        settings: { method: "GET", path: "/users", scopes: ["User.Read.All"] },
      },
      {
        id: "disable_user",
        format: "write",
        label: "Disable user",
        settings: {
          kind: "graph-write",
          source: "{{ users }}",
          confirmationPhrase: "DISABLE 1 USER",
          actionTemplate: {
            label: "Disable user",
            request: {
              method: "PATCH",
              path: "/users/{{ item.id }}",
              body: { accountEnabled: false },
            },
          },
        },
      },
    ];

    render(<ManifestSections preview={preview} sections={["permissions"]} />);
    expect(screen.getByText("Declared Graph operations")).toBeInTheDocument();
    expect(screen.getByText("PATCH")).toBeInTheDocument();
    expect(screen.getByText("/users/{{ item.id }}")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
  });
});
