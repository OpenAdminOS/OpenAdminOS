import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FIRST_RUN_CHAT_COPY } from "../../copy/chat";
import { createMockAppState, createMockMcpServers, makeMockBridge, mockTenant, renderWithAppState } from "../../test/test-utils";
import { qualifyScope, requestedScopes, type ProviderSummary, type TenantRecord } from "../../shared/openAdminOS";
import { ModelChoice, NoTenantChatHome, NotConnectedCard } from "./ChatFirstRun";

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
    const refreshProviders = vi.fn(async () => undefined);
    const onSelectProvider = vi.fn(async () => undefined);
    const view = renderWithAppState(<ModelChoice providers={[failed]} activeProviderId="ollama" onSelectProvider={onSelectProvider} />, {
      bridge: makeMockBridge({ refreshProviders }),
    });
    const row = await screen.findByText("LM Studio answered HTTP 500.");
    expect(within(row.closest("[data-provider]") as HTMLElement).getByRole("radio")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose a model" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Check LM Studio again" }));
    await waitFor(() => expect(refreshProviders).toHaveBeenCalledTimes(1));

    // The check now succeeds: the row is the normal one and the button uses it.
    view.rerender(<ModelChoice providers={[working]} activeProviderId="ollama" onSelectProvider={onSelectProvider} />);
    expect(screen.queryByRole("button", { name: "Check LM Studio again" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use qwen3-8b" }));
    expect(onSelectProvider).toHaveBeenCalledWith("lm-studio");
  });

  it("never acts on a chosen row whose check then failed, and shows a failed Retry under the row", async () => {
    const refreshProviders = vi.fn(async () => {
      throw new Error("Provider checks could not run. Restart OpenAdminOS.");
    });
    const onSelectProvider = vi.fn(async () => undefined);
    const ollama: ProviderSummary = { id: "ollama", name: "Ollama", description: "", isLocal: true, status: "connected", models: ["llama3"], defaultModel: "llama3" };
    const view = renderWithAppState(<ModelChoice providers={[ollama, working]} activeProviderId="anthropic" onSelectProvider={onSelectProvider} />, {
      bridge: makeMockBridge({ refreshProviders }),
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
