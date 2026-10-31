import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentScheduleCard } from "./AgentScheduleCard";
import { ScheduleUsageForecast } from "./ScheduleUsageForecast";
import { createMockAgent, createMockAppState, makeMockBridge, mockProviders, renderWithAppState } from "../test/test-utils";
import type { RunRecord } from "../shared/openAdminOS";

describe("schedule usage before enabling", () => {
  it("previews presets and custom intervals without saving, then enables the selected interval", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithAppState(<AgentScheduleCard agent={createMockAgent()} onChange={onChange} />);
    expect(await screen.findByText(/About 720 runs per 30 days/)).toBeInTheDocument();
    expect(screen.getByText("Runs on this device. No API charges.")).toBeInTheDocument();
    expect(screen.getByText("No completed runs yet. Run it once to see an estimate.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "24h" }));
    expect(screen.getByText(/About 30 runs per 30 days/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    const interval = screen.getByRole("spinbutton", { name: "Interval" });
    await user.clear(interval);
    await user.type(interval, "120");
    expect(screen.getByText(/About 360 runs per 30 days/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Automatic runs/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, intervalSeconds: 7200 })));
  });

  it("requires Save interval to change an enabled schedule", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ schedule: { enabled: true, intervalSeconds: 3600 } })} onChange={onChange} />);
    await user.click(await screen.findByRole("radio", { name: "4h" }));
    expect(screen.getByText(/About 180 runs per 30 days/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save interval" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ intervalSeconds: 14400 }));
  });

  for (const providerId of ["azure-openai", "openai", "anthropic"] as const) {
    it(`renders tokens and honest billing for ${providerId}`, async () => {
      const agent = createMockAgent();
      const provider = { ...mockProviders.find((item) => item.id === providerId)!, models: ["test"], defaultModel: "test" };
      const run: RunRecord = {
        id: "usage", agentSlug: agent.slug, status: "completed", queuedAt: new Date().toISOString(), tenantId: "tenant-1", providerId, model: "test", steps: [], logs: [],
        usage: { providerId, model: "test", calls: 2, mixedModels: false, totalTokens: 100, costUsd: 0.01 },
      };
      const state = createMockAppState({ activeProviderId: providerId, activeModelByProviderId: { [providerId]: "test" }, providers: [provider], runs: [run] });
      renderWithAppState(<ScheduleUsageForecast agent={agent} intervalSeconds={86400} />, { bridge: makeMockBridge({}, state) });
      expect(await screen.findByText(/3,000 to 3,000 tokens/)).toBeInTheDocument();
      expect(screen.getByText(/Median to p90, based on 1 completed run/)).toBeInTheDocument();
      if (providerId === "azure-openai") {
        expect(screen.getByText(/reported cost estimate/)).toBeInTheDocument();
        expect(screen.getByText(/Billed by Azure OpenAI per token/)).toBeInTheDocument();
      } else {
        expect(screen.getByText(/subscription limits/)).toBeInTheDocument();
        expect(screen.queryByText(/reported cost estimate/)).not.toBeInTheDocument();
      }
    });
  }
});
