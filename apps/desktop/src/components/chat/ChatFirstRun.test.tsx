import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FIRST_RUN_CHAT_COPY } from "../../copy/chat";
import { createMockAppState, createMockMcpServers, makeMockBridge, mockTenant, renderWithAppState } from "../../test/test-utils";
import { qualifyScope, requestedScopes, type ProviderSummary, type TenantRecord } from "../../shared/openAdminOS";
import { useAppState } from "../../state";
import { ModelChoice, NoTenantChatHome, NotConnectedCard } from "./ChatFirstRun";

/** Checks one provider again; the rows come from app state afterwards. */
const recheck = () => vi.fn(async (_id: ProviderSummary["id"]) => undefined);
const grants = (partIds: string[]) => requestedScopes(partIds).map((scope) => qualifyScope(scope.name));
const notConnected = { reason: "service-missing" as const, partIds: ["entra.signins", "defender.incidents"], tenantId: mockTenant.id };

function renderCard(tenant: TenantRecord, onAskAgain = vi.fn()) {
  renderWithAppState(
    <>
      <NotConnectedCard notConnected={notConnected} tenants={[tenant]} activeTenant={tenant} onAskAgain={onAskAgain} />
      <NotConnectedCard notConnected={notConnected} tenants={[tenant]} activeTenant={tenant} onAskAgain={onAskAgain} />
    </>,
    { bridge: makeMockBridge({}, createMockAppState({ tenants: [tenant], activeTenantId: tenant.id })) },
  );
  return onAskAgain;
}

describe("NotConnectedCard (review round 1, findings 8 and N)", () => {
  it("offers one action per service still missing, then Ask again once both are granted", () => {
    const none = { ...mockTenant, grantedScopes: grants(["intune.devices"]) };
    renderCard(none);
    expect(screen.getAllByRole("button", { name: "Add Entra" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Add Defender" })).toHaveLength(2);
  });

  it("drops a service once it is granted", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins"]) });
    expect(screen.queryByRole("button", { name: "Add Entra" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add Defender" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Ask again" })).not.toBeInTheDocument();
  });

  it("offers Ask again when every needed service is granted", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins", "defender.incidents"]) });
    expect(screen.getAllByRole("button", { name: "Ask again" })).toHaveLength(2);
  });

  it("gives each card its own heading id", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices"]) });
    const sections = document.querySelectorAll("section[aria-labelledby]");
    const ids = [...sections].map((section) => section.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("NotConnectedCard after the tenant changed (Muse round 2, P)", () => {
  const render = (card: Parameters<typeof NotConnectedCard>[0], tenants: TenantRecord[]) =>
    renderWithAppState(<NotConnectedCard {...card} />, {
      bridge: makeMockBridge({}, createMockAppState({ tenants, ...(tenants[0] ? { activeTenantId: tenants[0].id } : {}) })),
    });

  it("offers Add per missing service on the tenant a no-tenant card connected, not Connect again", () => {
    const partial = { ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins"]) };
    render({ notConnected: { reason: "no-tenant", partIds: ["entra.signins", "defender.incidents"] }, tenants: [partial], activeTenant: partial }, [partial]);
    expect(screen.getByRole("heading", { name: `Defender is not connected for ${mockTenant.displayName}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Defender" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Entra" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect / })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign-in")).not.toBeInTheDocument();
  });

  it("still offers Connect when the tenant the card was about was removed", () => {
    render(
      { notConnected: { reason: "service-missing", partIds: ["entra.signins", "defender.incidents"], tenantId: "removed-tenant" }, tenants: [], activeTenant: undefined },
      [],
    );
    expect(screen.getByText(/The organization this question was about is no longer in OpenAdminOS/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Connect Entra.+Defender$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use our own app registration" })).toBeInTheDocument();
  });
});

describe("NoTenantChatHome reference suggestions", () => {
  it("shows the logo of each suggested reference's owner", () => {
    const state = createMockAppState({ mcpServers: createMockMcpServers() });
    renderWithAppState(<NoTenantChatHome state={state} disabled={false} onAsk={vi.fn()} />, { bridge: makeMockBridge({}, state) });
    const suggestions = screen.getByRole("region", { name: FIRST_RUN_CHAT_COPY.referencesTitle });
    const row = (name: string) => within(suggestions).getByText(name).closest("li")!;
    expect(row("Microsoft Learn").querySelector('.svc-mark [data-reference-logo="microsoft"][data-kind="logo"] img')).not.toBeNull();
    expect(row("KQL Search").querySelector('.svc-mark [data-reference-logo="kqlsearch"][data-kind="logo"] img')).not.toBeNull();
  });
});

describe("ModelChoice with a provider whose check failed (PR #191 follow-up)", () => {
  const failed: ProviderSummary = { id: "lm-studio", name: "LM Studio", description: "", isLocal: true, status: "error", checkFailed: true, detail: "LM Studio answered HTTP 500.", models: [] };
  const working: ProviderSummary = { ...failed, status: "connected", checkFailed: undefined, detail: undefined, models: ["qwen3-8b"], defaultModel: "qwen3-8b" };

  it("shows the reason and Retry, cannot be chosen, and checks again on Retry", async () => {
    const onSelectProvider = vi.fn(async () => undefined);
    // Chat passes the providers from app state, so Retry's new rows arrive the same way.
    function FromAppState() {
      const { state } = useAppState();
      return <ModelChoice providers={state.providers} activeProviderId="ollama" onSelectProvider={onSelectProvider} />;
    }
    const bridge = makeMockBridge({ refreshProviders: vi.fn(async () => undefined), recheckProvider: recheck() }, createMockAppState({ providers: [failed] }));
    renderWithAppState(<FromAppState />, { bridge });
    const row = await screen.findByText("LM Studio answered HTTP 500.");
    const rowElement = row.closest("[data-provider]") as HTMLElement;
    expect(within(rowElement).getByRole("radio")).toBeDisabled();
    // The state stays in view next to Retry: Chat has no check list beside it.
    expect(within(rowElement).getByText("Could not check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a model" })).toBeDisabled();

    // The check now succeeds: the row is the normal one, the outcome is announced and focus returns to the row.
    vi.mocked(bridge.getAppState).mockResolvedValueOnce(createMockAppState({ providers: [working] }));
    await userEvent.click(screen.getByRole("button", { name: "Check LM Studio again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("LM Studio: Ready."));
    // Only this provider, never a full refresh that would contact an endpoint outside this device.
    expect(bridge.recheckProvider).toHaveBeenCalledWith("lm-studio");
    expect(bridge.refreshProviders).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Check LM Studio again" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /LM Studio/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Use qwen3-8b" }));
    expect(onSelectProvider).toHaveBeenCalledWith("lm-studio");
  });

  it("never acts on a chosen row whose check then failed, and shows a failed Retry under the row", async () => {
    const recheckProvider = vi.fn(async (): Promise<void> => {
      throw new Error("Provider checks could not run. Restart OpenAdminOS.");
    });
    const onSelectProvider = vi.fn(async () => undefined);
    const ollama: ProviderSummary = { id: "ollama", name: "Ollama", description: "", isLocal: true, status: "connected", models: ["llama3"], defaultModel: "llama3" };
    const view = renderWithAppState(<ModelChoice providers={[ollama, working]} activeProviderId="anthropic" onSelectProvider={onSelectProvider} />, {
      bridge: makeMockBridge({ recheckProvider }),
    });
    await userEvent.click(await screen.findByRole("radio", { name: /LM Studio/ }));
    expect(screen.getByRole("button", { name: "Use qwen3-8b" })).toBeEnabled();

    // LM Studio's check fails on the next refresh: the choice falls back to a row that works.
    view.rerender(<ModelChoice providers={[ollama, failed]} activeProviderId="anthropic" onSelectProvider={onSelectProvider} />);
    await userEvent.click(screen.getByRole("button", { name: "Use llama3" }));
    expect(onSelectProvider).toHaveBeenCalledWith("ollama");
    expect(onSelectProvider).not.toHaveBeenCalledWith("lm-studio");

    await userEvent.click(screen.getByRole("button", { name: "Check LM Studio again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider checks could not run. Restart OpenAdminOS.");
  });
});

describe("ModelChoice when checking again fails (PR #204 review round 1)", () => {
  const failed: ProviderSummary = { id: "lm-studio", name: "LM Studio", description: "", isLocal: true, status: "error", checkFailed: true, detail: "LM Studio answered HTTP 500.", models: [] };

  it("writes a failed app state read under the row, not only in the app error", async () => {
    const bridge = makeMockBridge({ refreshProviders: vi.fn(async () => undefined), recheckProvider: recheck() });
    renderWithAppState(<ModelChoice providers={[failed]} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />, { bridge });
    await screen.findByText("LM Studio answered HTTP 500.");
    vi.mocked(bridge.getAppState).mockRejectedValueOnce(new Error("The app state could not be read. Restart OpenAdminOS."));
    await userEvent.click(screen.getByRole("button", { name: "Check LM Studio again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The app state could not be read. Restart OpenAdminOS.");
    // Focus goes back to the Retry it was asked from (GPT-6.2-Sol round 6, P3).
    await waitFor(() => expect(screen.getByRole("button", { name: "Check LM Studio again" })).toHaveFocus());
  });

  it("announces a Retry whose check still fails and returns focus to its Retry", async () => {
    function FromAppState() {
      const { state } = useAppState();
      return <ModelChoice providers={state.providers} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />;
    }
    const bridge = makeMockBridge({ refreshProviders: vi.fn(async () => undefined), recheckProvider: recheck() }, createMockAppState({ providers: [failed] }));
    renderWithAppState(<FromAppState />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Check LM Studio again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("LM Studio: Could not check."));
    expect(screen.getByRole("button", { name: "Check LM Studio again" })).toHaveFocus();
  });

  it("announces a second Retry with the same outcome again", async () => {
    function FromAppState() {
      const { state } = useAppState();
      return <ModelChoice providers={state.providers} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />;
    }
    const bridge = makeMockBridge({ recheckProvider: recheck() }, createMockAppState({ providers: [failed] }));
    renderWithAppState(<FromAppState />, { bridge });
    await userEvent.click(await screen.findByRole("button", { name: "Check LM Studio again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("LM Studio: Could not check."));
    let release: (() => void) | undefined;
    vi.mocked(bridge.recheckProvider!).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(); }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Check LM Studio again" }));
    // Cleared while checking, so the same words are spoken again when it finishes.
    expect(screen.getByRole("status")).toHaveTextContent("");
    release?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("LM Studio: Could not check."));
  });

  it("announces a Retry whose provider is no longer offered and keeps focus in the choice (Muse round 2)", async () => {
    const claude: ProviderSummary = {
      id: "anthropic", name: "Claude Code", description: "", isLocal: false, status: "error", detail: "claude auth status failed", models: [],
      cli: { state: "request-failed" },
    };
    function FromAppState() {
      const { state } = useAppState();
      return <ModelChoice providers={state.providers} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />;
    }
    const bridge = makeMockBridge({ recheckProvider: recheck() }, createMockAppState({ providers: [claude] }));
    renderWithAppState(<FromAppState />, { bridge });
    // The check now completes: installed, signed out, which Chat does not offer.
    vi.mocked(bridge.getAppState).mockResolvedValueOnce(createMockAppState({ providers: [{ ...claude, status: "available", detail: undefined, cli: { state: "signed-out" } }] }));
    await userEvent.click(await screen.findByRole("button", { name: "Check Claude Code again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Claude Code was checked again and is not offered here. All providers shows its state."));
    expect(screen.getByRole("heading", { name: FIRST_RUN_CHAT_COPY.modelChoiceTitle })).toHaveFocus();
  });

  it("writes a failed Scan again under its row", async () => {
    const bridge = makeMockBridge({ refreshProviders: vi.fn(async () => undefined), recheckProvider: recheck() });
    const noModel: ProviderSummary = { id: "lm-studio", name: "LM Studio", description: "", isLocal: true, status: "connected", models: [] };
    renderWithAppState(<ModelChoice providers={[noModel]} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />, { bridge });
    await screen.findByText("On this device. Load a model in LM Studio, then scan again.");
    vi.mocked(bridge.getAppState).mockRejectedValueOnce(new Error("The app state could not be read. Restart OpenAdminOS."));
    await userEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The app state could not be read. Restart OpenAdminOS.");
  });

  it("offers no Retry for an endpoint outside this device that was not contacted", async () => {
    const served: ProviderSummary = {
      id: "lm-studio", name: "LM Studio", description: "", isLocal: false, status: "error", checkFailed: true, notContacted: true, models: [],
      detail: "LM Studio is set to http://10.0.0.5:1234/v1. The scan only checks this device. Check it in Settings, Providers.",
    };
    renderWithAppState(<ModelChoice providers={[served]} activeProviderId="ollama" onSelectProvider={vi.fn(async () => undefined)} />);
    await screen.findByText(served.detail!);
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check LM Studio again" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /LM Studio/ })).toBeDisabled();
  });
});
