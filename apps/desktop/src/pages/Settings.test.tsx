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
      path: "/settings",
      route: "/settings",
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
      path: "/settings",
      route: "/settings",
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
    const bridge = makeMockBridge(
      {
        getRunHistoryRetentionSettings,
        setRunHistoryRetentionSettings,
        pruneRunHistoryNow,
      },
      createMockAppState({
        runs: [
          createAwaitingConfirmationRun({ id: "run-1" }),
          createAwaitingConfirmationRun({ id: "run-2" }),
        ],
      }),
    );

    renderRoute(<Settings />, {
      path: "/settings",
      route: "/settings",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "General" }));

    expect(await screen.findByText("Run history retention")).toBeInTheDocument();
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
  });
});
