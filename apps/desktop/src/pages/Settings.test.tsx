import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";
import {
  DEFAULT_AZURE_OPENAI_API_VERSION,
  type SetAzureOpenAIProviderConfigInput,
} from "../shared/openAdminOS";

function provider(id: string) {
  const match = mockProviders.find((entry) => entry.id === id);
  if (!match) throw new Error(`Missing provider fixture: ${id}`);
  return match;
}

describe("Settings provider section", () => {
  it("restores a Settings section from its URL", async () => {
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/privacy",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument();
  });

  it("enables the gateway, shows its one-time token, revokes a client, and disables it", async () => {
    const user = userEvent.setup();
    const disabledStatus = {
      enabled: false,
      running: false,
      port: 47_891,
      hasToken: false,
      clients: [],
    };
    const enabledStatus = {
      enabled: true,
      running: true,
      port: 47_891,
      listeningPort: 47_891,
      boundTenantId: "tenant-1",
      hasToken: true,
      clients: [
        {
          id: "client-1",
          name: "Claude Code",
          createdAt: "2026-08-28T10:00:00.000Z",
        },
      ],
    };
    const enableGateway = vi.fn(async () => ({
      status: enabledStatus,
      token: "OAO-Q7R4-LM2C",
    }));
    const revokeGatewayClient = vi.fn(async () => ({
      ...enabledStatus,
      clients: [],
    }));
    const disableGateway = vi.fn(async () => disabledStatus);
    const bridge = makeMockBridge({
      getGatewayStatus: vi.fn(async () => disabledStatus),
      enableGateway,
      regenerateGatewayToken: vi.fn(async () => ({
        status: enabledStatus,
        token: "OAO-REGENERATED",
      })),
      revokeGatewayClient,
      disableGateway,
    });

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/gateway",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Enable gateway" }));

    await waitFor(() => {
      expect(enableGateway).toHaveBeenCalledWith({ boundTenantId: "tenant-1" });
    });
    expect(screen.getAllByText("OAO-Q7R4-LM2C")).toHaveLength(1);
    expect(screen.getByText("http://127.0.0.1:47891/")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revoke Claude Code" }));
    await user.click(screen.getByRole("button", { name: "Revoke client" }));
    await waitFor(() => {
      expect(revokeGatewayClient).toHaveBeenCalledWith("client-1");
    });

    await user.click(screen.getByRole("button", { name: "Disable gateway" }));
    await user.click(screen.getByRole("button", { name: "Disable gateway now" }));
    await waitFor(() => {
      expect(disableGateway).toHaveBeenCalledOnce();
    });
  });

  it("finds a setting from the shared catalog and focuses the rendered row", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge,
    });

    const search = await screen.findByRole("combobox", { name: "Search settings" });
    await user.type(search, "tenant cache");
    const result = screen.getByRole("option", { name: /Tenant cache/ });
    await user.click(result);

    const row = await screen.findByText("Tenant cache");
    await waitFor(() => expect(row.closest(".setting-row")).toHaveFocus());
  });

  it("opens contextual tenant setup before refreshing an empty tenant cache", async () => {
    const user = userEvent.setup();
    const connectedState = createMockAppState();
    const bridge = makeMockBridge(
      { connectTenant: vi.fn(async () => connectedState) },
      createMockAppState({ tenants: [], activeTenantId: undefined }),
    );

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/chat",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).toBeInTheDocument();
    expect(bridge.refreshGraphCache).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    expect(
      await screen.findByRole("button", { name: "Continue refresh" }),
    ).toBeInTheDocument();
    expect(bridge.refreshGraphCache).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue refresh" }));
    await waitFor(() => expect(bridge.refreshGraphCache).toHaveBeenCalledOnce());
  });

  it("renders implemented and coming-soon providers and sets the active provider", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "ollama",
        providers: [
          provider("ollama"),
          provider("lm-studio"),
          provider("openai"),
          provider("anthropic"),
          provider("azure-openai"),
        ],
      }),
    );

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge,
    });

    expect(await screen.findByRole("heading", { name: "LLM Providers" })).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getAllByText("Not installed")).toHaveLength(3);
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.getByText("Hosted via local CLI")).toBeInTheDocument();
    expect(screen.getByText("Hosted via Azure API key")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set active" }));

    await waitFor(() => {
      expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai");
    });
  });

  it("saves Azure OpenAI settings without displaying the stored key", async () => {
    const user = userEvent.setup();
    const getAzureOpenAIConfig = vi.fn(async () => ({
      endpoint: "https://contoso.openai.azure.com",
      deployment: "gpt-4o-admin",
      apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
      hasKey: true,
    }));
    const setAzureOpenAIConfig = vi.fn(
      async (input: SetAzureOpenAIProviderConfigInput) => ({
        endpoint: input.endpoint,
        deployment: input.deployment,
        apiVersion: input.apiVersion,
        hasKey: input.apiKey === null ? false : true,
      }),
    );
    const bridge = makeMockBridge(
      {
        getAzureOpenAIConfig,
        setAzureOpenAIConfig,
      },
      createMockAppState(),
    );

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge,
    });

    expect(
      await screen.findByRole("heading", { name: "Azure OpenAI configuration" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Key stored").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Azure OpenAI" }));

    await waitFor(() => {
      expect(setAzureOpenAIConfig).toHaveBeenCalledTimes(1);
    });
    expect(setAzureOpenAIConfig.mock.calls[0]?.[0]).toEqual({
      endpoint: "https://contoso.openai.azure.com",
      deployment: "gpt-4o-admin",
      apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
    });

    await user.click(screen.getByRole("button", { name: "Replace" }));
    const apiKeyInput = screen.getByLabelText("API key");
    expect(apiKeyInput).toHaveValue("");
    await user.type(apiKeyInput, "replacement-key");
    await user.click(screen.getByRole("button", { name: "Save Azure OpenAI" }));

    await waitFor(() => {
      expect(setAzureOpenAIConfig).toHaveBeenCalledTimes(2);
    });
    expect(setAzureOpenAIConfig).toHaveBeenLastCalledWith({
      endpoint: "https://contoso.openai.azure.com",
      deployment: "gpt-4o-admin",
      apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
      apiKey: "replacement-key",
    });
    expect(screen.queryByDisplayValue("replacement-key")).not.toBeInTheDocument();
  });

  it("renders run-history retention controls and surfaces manual prune results", async () => {
    const user = userEvent.setup();
    const getRunHistoryRetentionSettings = vi.fn(async () => ({
      neverPrune: false,
      keepLastRuns: 500,
      keepDays: 180,
    }));
    const setRunHistoryRetentionSettings = vi.fn(async (input) => ({
      neverPrune: input.neverPrune,
      ...(input.keepLastRuns !== null && input.keepLastRuns !== undefined
        ? { keepLastRuns: input.keepLastRuns }
        : {}),
      ...(input.keepDays !== null && input.keepDays !== undefined
        ? { keepDays: input.keepDays }
        : {}),
      updatedAt: "2026-07-05T10:00:00.000Z",
    }));
    const pruneRunHistoryNow = vi.fn(async () => ({
      prunedAt: "2026-07-05T10:00:00.000Z",
      trigger: "manual" as const,
      policy: {
        neverPrune: false,
        keepLastRuns: 250,
        keepDays: 180,
      },
      beforeCount: 503,
      afterCount: 501,
      eligibleCount: 500,
      prunedCount: 2,
      protectedCount: 3,
      protectedWorkspaceCount: 1,
      protectedActiveCount: 1,
      protectedAwaitingConfirmationCount: 1,
      reason: "Pruned 2 runs older than 180 days.",
    }));
    const getDriftRetentionSettings = vi.fn(async () => ({
      neverPrune: false,
      keepDays: 180,
    }));
    const setDriftRetentionSettings = vi.fn(async (input) => ({
      neverPrune: input.neverPrune,
      ...(input.keepDays !== null && input.keepDays !== undefined
        ? { keepDays: input.keepDays }
        : {}),
      updatedAt: "2026-07-05T10:00:00.000Z",
    }));
    const pruneDriftHistoryNow = vi.fn(async () => ({
      prunedAt: "2026-07-05T10:00:00.000Z",
      trigger: "manual" as const,
      policy: {
        neverPrune: false,
        keepDays: 90,
      },
      snapshotsDeleted: 3,
      versionsDeleted: 7,
      reason: "Pruned 3 snapshots and 7 object versions older than 90 days.",
    }));
    const bridge = makeMockBridge(
      {
        getRunHistoryRetentionSettings,
        setRunHistoryRetentionSettings,
        pruneRunHistoryNow,
        getDriftRetentionSettings,
        setDriftRetentionSettings,
        pruneDriftHistoryNow,
      },
      createMockAppState({
        runs: [
          createAwaitingConfirmationRun({ id: "run-1" }),
          createAwaitingConfirmationRun({ id: "run-2" }),
        ],
      }),
    );

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "General" }));

    expect(await screen.findByText("Run history retention")).toBeInTheDocument();
    expect(await screen.findByText("Change history")).toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.queryByText(/Automatic pruning is planned/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Runs to keep"), {
      target: { value: "250" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setRunHistoryRetentionSettings).toHaveBeenCalledWith({
        neverPrune: false,
        keepLastRuns: 250,
        keepDays: 180,
      });
    });

    await user.click(screen.getByRole("button", { name: "Prune now" }));

    await waitFor(() => {
      expect(pruneRunHistoryNow).toHaveBeenCalledTimes(1);
    });
    expect(screen.getAllByText(/Pruned 2 runs older than 180 days/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/501 run records remain/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Retention days"), {
      target: { value: "90" },
    });
    await user.click(screen.getByRole("button", { name: "Save change-history retention" }));

    await waitFor(() => {
      expect(setDriftRetentionSettings).toHaveBeenCalledWith({
        neverPrune: false,
        keepDays: 90,
      });
    });

    await user.click(screen.getByRole("button", { name: "Prune change history now" }));

    await waitFor(() => {
      expect(pruneDriftHistoryNow).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getAllByText(/Pruned 3 snapshots and 7 object versions older than 90 days/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/10 local history rows removed/i)).toBeInTheDocument();
  });

  it("keeps the disconnect confirmation open and surfaces deletion failures", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => {
      throw new Error("The local state file could not be written.");
    });
    const bridge = makeMockBridge({ disconnectTenant }, createMockAppState());

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    await user.click(
      screen.getByRole("button", { name: "Disconnect and delete local data" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The local state file could not be written.",
    );
    expect(
      screen.getByRole("dialog", { name: /Disconnect Contoso IT/i }),
    ).toBeInTheDocument();
  });
});
