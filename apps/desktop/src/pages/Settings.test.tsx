import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
import { setAnswerFont } from "../styles/answer-font";
import { setDensity } from "../styles/density";

function provider(id: string) {
  const match = mockProviders.find((entry) => entry.id === id);
  if (!match) throw new Error(`Missing provider fixture: ${id}`);
  return match;
}

describe("Settings provider section", () => {
  it("stores the Chat answer font as a device-local General preference", async () => {
    const user = userEvent.setup();
    setAnswerFont("serif");
    setDensity("comfortable");
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/general",
      bridge: makeMockBridge(),
    });

    const picker = await screen.findByRole("radiogroup", { name: "Answer font" });
    expect(within(picker).getByRole("radio", { name: "Serif" })).toBeChecked();
    await user.click(within(picker).getByRole("radio", { name: "Sans" }));
    expect(document.documentElement.dataset.answerFont).toBe("sans");
    expect(localStorage.getItem("openadminos:answer-font:v1")).toBe("sans");

    const density = screen.getByRole("radiogroup", { name: "Density" });
    await user.click(within(density).getByRole("radio", { name: "Compact" }));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("openadminos:density:v1")).toBe("compact");
  });

  it("saves audit exports in the host without resubmitting content through text-file IPC", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/general", bridge });
    await user.click(await screen.findByRole("button", { name: "Export audit log" }));
    expect(await screen.findByText(/Audit log saved locally/)).toBeInTheDocument();
    expect(bridge.exportAuditLog).toHaveBeenCalledWith({ format: "json", saveToFile: true });
    expect(bridge.saveTextFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "csv" }));
    await user.click(screen.getByRole("button", { name: "Export audit log" }));
    await waitFor(() => expect(bridge.exportAuditLog).toHaveBeenLastCalledWith({ format: "csv", saveToFile: true }));
  });

  it("requires a real Gemini test and shows CLI diagnostics before activation", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      testProvider: vi.fn(async () => ({ providerId: "gemini" as const, ok: false, message: "Sign in with Gemini CLI, then test again." })),
    }, createMockAppState({
      activeProviderId: "ollama",
      providers: [{ ...provider("openai"), id: "gemini", name: "Google Gemini", status: "available", models: [], defaultModel: undefined,
        cli: { state: "check-required", version: "0.59.0", binaryPath: "/example/bin/gemini" } }],
    }));
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/providers", bridge });
    expect(await screen.findByText("Test required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show details for Google Gemini" }));
    expect(screen.getByText("/example/bin/gemini")).toBeInTheDocument();
    expect(screen.getByText("0.59.0")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Set Google Gemini active" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledWith("gemini", undefined));
    expect(await screen.findByText("Sign in with Gemini CLI, then test again.")).toBeInTheDocument();
  });

  it("restores a Settings section from its URL", async () => {
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/privacy",
      bridge: makeMockBridge(),
    });

    const heading = await screen.findByRole("heading", { name: "Privacy" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("applies themes immediately and supports arrow-key selection", async () => {
    const user = userEvent.setup();
    const setAppearance = vi.fn(async () => undefined);
    const bridge = makeMockBridge({ setAppearance });
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/appearance",
      bridge,
    });

    const picker = await screen.findByRole("radiogroup", { name: "Color theme" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Appearance" })).toHaveFocus(),
    );
    expect(within(picker).getAllByRole("radio")).toHaveLength(4);
    const system = within(picker).getByRole("radio", { name: "System" });
    system.focus();
    await user.keyboard("{ArrowRight}");

    const light = within(picker).getByRole("radio", { name: "Light" });
    expect(light).toHaveFocus();
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("light");
    expect(setAppearance).toHaveBeenLastCalledWith({
      preference: "light",
      resolvedTheme: "light",
    });

    await user.keyboard("{ArrowRight}");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.mode).toBe("dark");

    await user.click(system);
  });

  it("scrolls deep links inside the Settings content container", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    try {
      renderRoute(<Settings />, {
        path: "/settings/:section?",
        route: "/settings/chat",
        bridge: makeMockBridge(),
      });

      const heading = await screen.findByRole("heading", { name: "Chat" });
      await waitFor(() => {
        expect(heading).toHaveFocus();
        expect(scrollTo).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: "auto" }),
        );
      });
      expect(heading.closest(".app-page-body")).not.toBeNull();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: originalScrollTo,
      });
    }
  });

  it("opens and closes a connector drawer from its URL", async () => {
    const user = userEvent.setup();
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/connectors?connector=jira",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("dialog", { name: "Jira" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Jira" })).not.toBeInTheDocument();
    });
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

    await user.click(await screen.findByRole("switch", { name: "Enable gateway" }));

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
      route: "/settings/data",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).toBeInTheDocument();
    expect(bridge.refreshGraphCache).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: /Approve \d+ read scopes and continue to Microsoft/,
      }),
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

    const providersHeading = await screen.findByRole("heading", { name: "Providers" });
    const providersSection = providersHeading.closest("section");
    expect(providersSection).not.toBeNull();
    const providerView = within(providersSection as HTMLElement);
    expect(providerView.getByText("Ollama")).toBeInTheDocument();
    expect(providerView.getByText("OpenAI")).toBeInTheDocument();
    expect(providerView.getAllByText("Connected")).toHaveLength(2);
    expect(providerView.getAllByText("Active")).toHaveLength(5);
    expect(providerView.getAllByText("Not installed")).toHaveLength(3);
    expect(providerView.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(providerView.getAllByText("Hosted via CLI").length).toBeGreaterThan(0);
    expect(providerView.getByText("Hosted API")).toBeInTheDocument();

    await user.click(providerView.getByRole("radio", { name: "Set OpenAI active" }));

    await waitFor(() => {
      expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai");
    });
  });

  it("renders an available inactive provider with a neutral status", async () => {
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          providers: [provider("ollama"), provider("apple-foundation")],
        }),
      ),
    });

    const available = await screen.findByText("Available");
    expect(available).toHaveClass("text-[var(--color-text-soft)]");
    expect(available).not.toHaveClass("text-[var(--color-warning)]");
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

    await user.click(
      await screen.findByRole("button", { name: "Show details for Azure OpenAI" }),
    );
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

  it("keeps usage telemetry off by default and supports preview and test actions", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/privacy",
      bridge,
    });

    const telemetrySwitch = await screen.findByRole("switch", {
      name: "Usage telemetry",
    });
    expect(telemetrySwitch).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByText("Show exact ping JSON preview"));
    expect(await screen.findByText(/openadminos-usage-1/)).toBeInTheDocument();

    await user.click(telemetrySwitch);

    await waitFor(() => {
      expect(bridge.setUsageTelemetryEnabled).toHaveBeenCalledWith(true);
      expect(telemetrySwitch).toHaveAttribute("aria-checked", "true");
    });

    await user.click(screen.getByRole("button", { name: "Send a test ping" }));

    await waitFor(() => {
      expect(bridge.sendUsageTelemetryTest).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Test ping sent.")).toBeInTheDocument();
  });

  it("switches to nightly builds from About and checks for updates", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      checkForUpdatesNow: vi.fn(async () => ({ status: "not-available" as const })),
    });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/about", bridge });

    const nightly = await screen.findByRole("switch", { name: "Get nightly builds" });
    await waitFor(() => expect(nightly).toBeEnabled());
    expect(nightly).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/moves you back to the current stable release/)).toBeInTheDocument();

    await user.click(nightly);
    await waitFor(() => expect(nightly).toHaveAttribute("aria-checked", "true"));
    expect(bridge.setUpdateChannel).toHaveBeenCalledWith("nightly");

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Up to date on the nightly channel.")).toBeInTheDocument();
    expect(bridge.checkForUpdatesNow).toHaveBeenCalledTimes(1);
  });

  it("shows the update channel in Privacy only once it is known", async () => {
    const nightly = makeMockBridge({
      platform: "macos",
      getUpdateChannel: vi.fn(async () => ({ channel: "nightly" as const })),
    });
    const { unmount } = renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/privacy",
      bridge: nightly,
    });
    expect(
      await screen.findByText(/Nightly prereleases, plus any newer stable release\./),
    ).toBeInTheDocument();
    unmount();

    const failing = makeMockBridge({
      platform: "macos",
      getUpdateChannel: vi.fn(async () => {
        throw new Error("The settings store is locked.");
      }),
    });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/privacy", bridge: failing });
    // Privacy row and the About alert.
    expect(
      await screen.findAllByText(
        "The update channel could not be read. The settings store is locked. Reopen Settings to try again.",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("Stable releases only.", { exact: false })).not.toBeInTheDocument();
  });

  it("updates the Privacy row when nightly builds are turned on in About", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({ platform: "macos" });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/about", bridge });

    expect(await screen.findByText(/Stable releases only\./)).toBeInTheDocument();
    const nightly = await screen.findByRole("switch", { name: "Get nightly builds" });
    await waitFor(() => expect(nightly).toBeEnabled());
    await user.click(nightly);

    expect(await screen.findByText(/Nightly prereleases, plus any newer stable release\./)).toBeInTheDocument();
    expect(screen.queryByText(/Stable releases only\./)).not.toBeInTheDocument();
  });

  it("disables the update channel with an explanation on Linux", async () => {
    const bridge = makeMockBridge({
      getUpdateChannel: vi.fn(async () => ({
        channel: "stable" as const,
        unavailableReason: "linux" as const,
      })),
    });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/about", bridge });

    expect(
      await screen.findByText(/Linux updates come from the apt repository or a manual download/),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Get nightly builds" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  });

  it("shows an unavailable retrieval reason and checks for a refreshed index", async () => {
    const user = userEvent.setup();
    const reason = "The local Microsoft documentation index is not installed.";
    const getRetrievalStatus = vi.fn(async () => ({
      available: false,
      reason,
    }));
    const refreshRetrievalIndex = vi.fn(async () => ({
      available: false,
      reason,
    }));
    const bridge = makeMockBridge({
      getRetrievalStatus,
      refreshRetrievalIndex,
    });

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/privacy",
      bridge,
    });

    expect(await screen.findByText(reason)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for index" }));

    await waitFor(() => {
      expect(refreshRetrievalIndex).toHaveBeenCalledTimes(1);
    });
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

    await user.click(await screen.findByRole("button", { name: "Contoso IT actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
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

  it("shows granted areas and adds a missing area through reviewed consent", async () => {
    const user = userEvent.setup();
    const base = createMockAppState();
    const tenant = {
      ...base.tenants[0]!,
      grantedScopes: [
        "User.Read.All",
        "GroupMember.Read.All",
        "Directory.Read.All",
        "Organization.Read.All",
      ],
    };
    const state = createMockAppState({ tenants: [tenant] });
    const addTenantAccess = vi.fn(async () => state);
    const bridge = makeMockBridge({ addTenantAccess }, state);

    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge,
    });

    expect(await screen.findByText("Users, groups, and directory")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add Devices and configuration access" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Add Devices and configuration access" }),
    ).toBeInTheDocument();
    expect(screen.getByText("6 delegated read scopes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() =>
      expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", "devices"),
    );
  });
});
