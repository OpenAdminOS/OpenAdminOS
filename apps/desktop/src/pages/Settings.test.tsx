import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import {
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
});
