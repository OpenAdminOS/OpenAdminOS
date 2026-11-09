import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEffect } from "react";

import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import { DataBoundaryProvider, useDataBoundary } from "./data-boundary";

function VoiceProbe() {
  const { boundary, setVoiceHosted } = useDataBoundary();
  useEffect(() => {
    setVoiceHosted(true);
  }, [setVoiceHosted]);
  return <output data-testid="tooltip">{boundary.tooltip}</output>;
}

describe("voice boundary (PR #175 Muse round 2, I)", () => {
  it("says where voice goes, what its location depends on, and that no tenant data is sent when nothing is connected", async () => {
    await act(async () => {
      renderWithAppState(
        <DataBoundaryProvider>
          <VoiceProbe />
        </DataBoundaryProvider>,
        { bridge: makeMockBridge({}, createMockAppState({ tenants: [], activeTenantId: undefined })) },
      );
    });
    const tooltip = await screen.findByTestId("tooltip");
    await act(async () => undefined);
    expect(tooltip.textContent).toContain("Voice audio and prompts go to OpenAI. No organization is active, so no tenant data is sent. Processing follows your OpenAI workspace's data residency setting.");
    expect(tooltip.textContent).not.toMatch(/Tenant context will be sent/);
  });
});
