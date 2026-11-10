import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Connections, { REACH_STACK_BELOW, buildReachModel, reachDescription, reachLayout, reachLinks, reachPaths, reachRowAnchor } from "./Connections";
import { reportDestinations, resultDestinations, targetlessDestinations } from "../shared/delivery-destinations";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";
import { promptsGoTo } from "../copy";
import { CONNECTIONS_COPY, ORGANIZATION_COPY, SERVICE_COPY, SETUP_COPY, deriveToolHostsCopy } from "../copy";
import { chatToolHosts, deriveDataBoundary } from "../state";
import { hostedChannel } from "../shared/providers";
import { AppShell } from "../components/AppShell";
import { connectedServiceIds } from "../components/ServiceMark";
import { SERVICE_PARTS, type AppState, type ConnectorSummary } from "../shared/openAdminOS";

function connector(id: string, name: string, status: ConnectorSummary["status"] = "connected", config: Record<string, unknown> = {}): ConnectorSummary {
  return {
    descriptor: { id, name, version: "1.0.0", authSource: "external", scopes: [], capabilities: [], trust: { publisher: "OpenAdminOS", verified: true } } as unknown as ConnectorSummary["descriptor"],
    config,
    status,
  };
}

/** Teams with a saved default team and channel, so the host posts there. */
function teamsConnector(status: ConnectorSummary["status"] = "connected"): ConnectorSummary {
  return connector("teams", "Microsoft Teams", status, { defaultTeamId: "team-1", defaultChannelId: "channel-1" });
}

function render(state: AppState, overrides: Parameters<typeof makeMockBridge>[0] = {}, route = "/connections") {
  const bridge = makeMockBridge(overrides, state);
  renderRoute(<Connections />, { path: "/connections", route, bridge });
  return bridge;
}

/** Every Intune part granted, which also grants the Entra users part they share scopes with. */
const intuneScopes = [
  ...new Set(SERVICE_PARTS.filter((part) => part.service === "intune").flatMap((part) => part.scopes.map((scope) => `graph:${scope.name}`))),
];
const partialTenant = { ...createMockAppState().tenants[0]!, grantedScopes: intuneScopes };

describe("Connections reach map", () => {
  it("lists the same reference hosts as the status strip and the saved delivery rules", () => {
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({
        "kql-search": { installed: true, enabled: true },
        "microsoft-learn": { installed: true, enabled: true },
        // Installed but off: Chat sends it nothing.
        intuneautomation: { installed: true, enabled: false },
      }),
      installedAgents: [
        createMockAgent({ id: "a", slug: "a", delivery: { teams: { enabled: true } } }),
        createMockAgent({ id: "b", slug: "b", delivery: { slack: { enabled: false } } }),
      ],
    });
    const model = buildReachModel(state, [teamsConnector()]);
    expect(model.referenceHosts).toEqual(chatToolHosts(state));
    expect(model.referenceHosts).toEqual(["learn.microsoft.com", "www.kqlsearch.com"]);
    expect(model.reportDestinations).toEqual(["Microsoft Teams"]);
    expect(model.model.kind).toBe("local");
    expect(model.services.map((service) => [service.title, service.status])).toEqual([
      ["Intune", "connected"],
      ["Entra", "partial"],
      ["Defender", "missing"],
    ]);
  });

  it("gives the map a text alternative that names everything that leaves the device", async () => {
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
      installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [teamsConnector()]) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    const description = reachDescription(buildReachModel(state, [teamsConnector()]));
    await waitFor(() => expect(map).toHaveAccessibleDescription(description));
    expect(description).toMatch(
      /^Contoso IT reads Intune, connected, Entra, \d of 6 parts and Defender, not connected into this device\. The model runs on this device: llama3\.1, local\. Words from questions go to www\.kqlsearch\.com\. Run reports and agent messages can go to Microsoft Teams under saved delivery rules and agent steps\.$/,
    );
    expect(within(map).getByText(CONNECTIONS_COPY.map.promptsLocal)).toBeInTheDocument();
  });

  it("shows the logo of each reference host and result connector on its row", async () => {
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true }, "microsoft-learn": { installed: true, enabled: true } }),
      installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [teamsConnector()]) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    await waitFor(() => expect(map.querySelector('[data-link-id="report:Microsoft Teams"]')).not.toBeNull());
    for (const [row, logo] of [
      ["host:learn.microsoft.com", "microsoft"],
      ["host:www.kqlsearch.com", "kqlsearch"],
      ["report:Microsoft Teams", "microsoft-teams"],
    ]) {
      expect(map.querySelector(`[data-link-id="${row}"] .svc-mark [data-reference-logo="${logo}"][data-kind="logo"] img`), row).not.toBeNull();
    }
  });

  it("shows the Splashtop logo for a Splashtop reference host through its listing, not for other hosts", async () => {
    const packr = {
      ...createMockMcpServers()[0]!,
      id: "splashtop-packr-kb",
      name: "Splashtop Agentic Packr Docs MCP",
      publisher: "Splashtop",
      url: "https://support-splashtopagenticpackr.splashtop.com/api/v2/help_center",
      host: "support-splashtopagenticpackr.splashtop.com",
      builtIn: true as const,
      installed: true,
      enabled: true,
      logo: "splashtop" as const,
    };
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: [...createMockMcpServers({ "kql-search": { installed: true, enabled: true } }), packr],
    });
    expect(buildReachModel(state, []).referenceLogos).toEqual({ "support-splashtopagenticpackr.splashtop.com": "splashtop" });
    render(state, { listConnectors: vi.fn(async () => []) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    const row = (host: string) => within(map).getByText(host).closest("li")!;
    await waitFor(() => expect(row("support-splashtopagenticpackr.splashtop.com").querySelector('[data-service-logo="splashtop"][data-kind="logo"]')).not.toBeNull());
    expect(row("www.kqlsearch.com").querySelector("[data-service-logo]")).toBeNull();
  });

  it("names the hosted provider and its documented API location", async () => {
    const hosted = mockProviders.find((provider) => !provider.isLocal && provider.status === "connected")!;
    const state = createMockAppState({ activeProviderId: hosted.id });
    const model = buildReachModel(state);
    expect(model.model.kind).toBe("hosted");
    render(state);
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    // The row names where prompts go and the model; the channel is its hint.
    const row = within(map).getByText("Codex · location set by your account");
    expect(row).toHaveAttribute("title", expect.stringContaining("Codex · location set by your account"));
    expect(within(map).getByText(model.model.modelName!)).toBeInTheDocument();
    // The prompts row carries the provider's own logo, not two letters (step 4).
    expect(map.querySelector(`[data-service="provider"] [data-provider-logo="${hosted.id}"][data-kind="logo"]`)).not.toBeNull();
    // The description uses the same sentence as every other surface (design round review 2).
    expect(reachDescription(model)).toContain(`${promptsGoTo(hosted, true)}.`);
    expect(reachDescription(model)).toContain("Prompts and tenant data leave this device through Codex; location set by your account.");
    expect(reachDescription(model)).not.toMatch(/the Codex CLI to OpenAI|the Claude Code CLI to Anthropic/);
    expect(reachDescription(model)).not.toContain("Region not reported");
    // The documented default sits under the location (design round review).
    expect(within(map).getByText("Codex sends prompts to OpenAI, or to the endpoint its configuration selects. Processing follows your workspace's data residency setting.")).toBeInTheDocument();
    expect(reachDescription(model)).toContain("Processing follows your workspace's data residency setting.");
  });

  it("shows an empty state with Connect Microsoft 365 and no services list when no organization is active", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState({ tenants: [] });
    render({ ...state, tenants: [] });
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.pageTitle })).toBeInTheDocument();
    expect(screen.getByText(CONNECTIONS_COPY.ledeNone)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTIONS_COPY.lede)).not.toBeInTheDocument();
    const empty = screen.getByRole("region", { name: CONNECTIONS_COPY.emptyTitle });
    expect(within(empty).getByText(CONNECTIONS_COPY.emptyBody)).toBeInTheDocument();
    // The figure keeps its text alternative.
    const figure = within(empty).getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(figure).toHaveAccessibleDescription(/^No organization reads no service into this device\./);
    // One way forward: Connect Microsoft 365. There is no sample data.
    expect(within(empty).getAllByRole("button").map((button) => button.textContent)).toEqual([CONNECTIONS_COPY.connectMicrosoft365]);
    expect(screen.queryByRole("button", { name: /sample data/i })).not.toBeInTheDocument();
    // No services list with Not connected rows, and no empty map.
    expect(screen.queryByRole("region", { name: CONNECTIONS_COPY.servicesHeading })).not.toBeInTheDocument();
    expect(screen.queryByText(SERVICE_COPY.status.missing)).not.toBeInTheDocument();
    expect(document.querySelector(".reach-map")).toBeNull();
    const leaves = screen.getByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    expect(within(leaves).getByText(CONNECTIONS_COPY.map.promptsNoOrganization)).toBeInTheDocument();
    expect(within(leaves).getByRole("button", { name: CONNECTIONS_COPY.changeModel })).toBeInTheDocument();
    await user.click(within(empty).getByRole("button", { name: CONNECTIONS_COPY.connectMicrosoft365 }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("names the hosted destination in amber with no organization", async () => {
    const { activeTenantId: _none, ...state } = createMockAppState({
      tenants: [],
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
    });
    render({ ...state, tenants: [] });
    const leaves = await screen.findByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    const prompts = within(leaves).getByText("Codex · location set by your account");
    expect(prompts.className).toContain("--color-warning");
    expect(within(leaves).getByText("www.kqlsearch.com")).toBeInTheDocument();
  });
});

describe("reach map connectors and layout", () => {
  it("makes only the line that carries prompts to a hosted provider amber", () => {
    const hosted = createMockAppState({
      activeProviderId: "openai",
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
      installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })],
    });
    const links = reachLinks(buildReachModel(hosted, [teamsConnector()]));
    expect(links.map((link) => [link.id, link.direction, link.tone])).toEqual([
      ["service:intune", "in", "default"],
      ["service:entra", "in", "default"],
      // A missing service is drawn in the border colour, never amber.
      ["service:defender", "in", "missing"],
      ["prompts", "out", "hosted"],
      ["host:www.kqlsearch.com", "out", "default"],
      ["report:Microsoft Teams", "out", "default"],
    ]);
    expect(links.filter((link) => link.tone === "hosted").map((link) => link.id)).toEqual(["prompts"]);
  });

  it("draws no prompts line for a local model", () => {
    const links = reachLinks(buildReachModel(createMockAppState({ tenants: [partialTenant] }), []));
    expect(links.some((link) => link.id === "prompts" || link.tone === "hosted")).toBe(false);
  });

  it("curves each row to the tile and fans the ends 9 px apart at the tile edge", () => {
    const box = { left: 0, right: 900, top: 0, height: 300 };
    const tile = { left: 400, right: 472, top: 100, height: 72 };
    const rows = new Map([
      ["a", { left: 24, right: 300, top: 40, height: 32 }],
      ["b", { left: 24, right: 300, top: 72, height: 32 }],
      ["c", { left: 600, right: 880, top: 40, height: 32 }],
    ]);
    const paths = reachPaths(box, tile, rows, [
      { id: "a", direction: "in", tone: "default" },
      { id: "b", direction: "in", tone: "missing" },
      { id: "c", direction: "out", tone: "hosted" },
    ]);
    // Each line bends 35% of the way from its row, so it leaves the tile level.
    expect(paths.map((path) => path.d)).toEqual([
      "M310 56 C339.4 56, 339.4 131.5, 394 131.5",
      "M310 88 C339.4 88, 339.4 140.5, 394 140.5",
      "M478 136 C550.8 136, 550.8 56, 590 56",
    ]);
  });

  it("tightens the fan so many lines still end on the tile edge", () => {
    const box = { left: 0, right: 900, top: 0, height: 700 };
    const tile = { left: 400, right: 472, top: 100, height: 72 };
    const ids = Array.from({ length: 16 }, (_, index) => `row-${index}`);
    const rows = new Map(ids.map((id, index) => [id, { left: 600, right: 880, top: 40 + index * 32, height: 22 }]));
    const paths = reachPaths(box, tile, rows, ids.map((id) => ({ id, direction: "out" as const, tone: "default" as const })));
    const ends = paths.map((path) => Number(/^M\S+ (\S+) /.exec(path.d)![1]));
    // The ends stay 8 px inside the tile's top (100) and bottom (172), in row order.
    expect(ends[0]).toBe(108);
    expect(ends.at(-1)).toBe(164);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
  });

  it("meets a row at its mark, and at its own middle when the mark cannot be measured", () => {
    const row = { left: 600, right: 880, top: 40, height: 58 };
    const mark = { left: 600, right: 622, top: 44, height: 22 };
    expect(reachRowAnchor(row, mark)).toEqual({ left: 600, right: 880, top: 44, height: 22 });
    expect(reachRowAnchor(row)).toEqual(row);
    expect(reachRowAnchor(row, { ...mark, height: 0 })).toEqual(row);
    // The line to a row with a detail line ends level with the mark (55), not the middle of the block (69).
    const box = { left: 0, right: 900, top: 0, height: 300 };
    const tile = { left: 428, right: 500, top: 100, height: 72 };
    const [path] = reachPaths(box, tile, new Map([["a", reachRowAnchor(row, mark)]]), [{ id: "a", direction: "out", tone: "hosted" }]);
    expect(path!.d.endsWith(" 590 55")).toBe(true);
  });

  it("keeps every line out of the caption under the tile, however many rows there are", () => {
    // The wide map: a 72 px tile centred in a 128 px column, 76 px gaps, the caption 10 px under the tile and as wide as the column.
    const box = { left: 0, right: 1000, top: 0, height: 1400 };
    const tile = { left: 428, right: 500, top: 600, height: 72 };
    const caption = { left: 400, right: 528, top: 682 };
    const centre = tile.top + tile.height / 2;
    const column = (ids: string[], left: number, right: number) =>
      ids.map((id, index): [string, { left: number; right: number; top: number; height: number }] => [id, { left, right, top: centre - (ids.length * 32) / 2 + index * 32 + 5, height: 22 }]);
    /** Points along a path of M, H and C segments. */
    const samples = (d: string): Array<[number, number]> => {
      const tokens = d.match(/[MHC]|-?[\d.]+/g)!;
      const points: Array<[number, number]> = [];
      let [x, y] = [0, 0];
      for (let at = 0; at < tokens.length; ) {
        const command = tokens[at++];
        const take = (count: number) => tokens.slice(at, (at += count)).map(Number);
        if (command === "M") {
          [x, y] = take(2) as [number, number];
          points.push([x, y]);
        } else if (command === "H") {
          const [to] = take(1) as [number];
          for (let step = 1; step <= 20; step += 1) points.push([x + ((to - x) * step) / 20, y]);
          x = to;
        } else {
          const [x1, y1, x2, y2, x3, y3] = take(6) as [number, number, number, number, number, number];
          for (let step = 1; step <= 200; step += 1) {
            const t = step / 200;
            const u = 1 - t;
            points.push([u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]);
          }
          [x, y] = [x3, y3];
        }
      }
      return points;
    };
    const crossings = (incoming: number, outgoing: number, clear?: { left: number; right: number }) => {
      const ins = Array.from({ length: incoming }, (_, index) => `in-${index}`);
      const outs = Array.from({ length: outgoing }, (_, index) => `out-${index}`);
      const rows = new Map([...column(ins, 124, 324), ...column(outs, 604, 960)]);
      const paths = reachPaths(
        box,
        tile,
        rows,
        [...ins.map((id) => ({ id, direction: "in" as const, tone: "default" as const })), ...outs.map((id) => ({ id, direction: "out" as const, tone: "default" as const }))],
        clear,
      );
      expect(paths).toHaveLength(incoming + outgoing);
      return paths.filter((path) => samples(path.d).some(([x, y]) => x >= caption.left && x <= caption.right && y >= caption.top)).map((path) => path.id);
    };
    expect(crossings(3, 7, caption)).toEqual([]);
    expect(crossings(3, 16, caption)).toEqual([]);
    expect(crossings(30, 30, caption)).toEqual([]);
    // Without the level run past the caption, the lowest rows of a long list cut its corners.
    expect(crossings(30, 30)).toEqual(expect.arrayContaining(["in-29", "out-29"]));
    // Each line runs level from the tile until it is 2 px past the caption, then curves to its row.
    const [path] = reachPaths(box, tile, new Map(column(["out-0"], 604, 960)), [{ id: "out-0", direction: "out", tone: "default" }], caption);
    expect(path!.d).toBe("M506 636 H530 C563.2 636, 563.2 636, 594 636");
  });

  it(`stacks the map below ${REACH_STACK_BELOW} px of content width`, () => {
    expect(reachLayout(REACH_STACK_BELOW - 1)).toBe("stacked");
    expect(reachLayout(630)).toBe("stacked");
    expect(reachLayout(REACH_STACK_BELOW)).toBe("wide");
    expect(reachLayout(938)).toBe("wide");
    // Not laid out yet: keep the wide figure.
    expect(reachLayout(0)).toBe("wide");
  });

  it("renders the wide layout with the device tile and its caption", async () => {
    render(createMockAppState({ tenants: [partialTenant] }));
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAttribute("data-layout", "wide");
    expect(map.querySelector(".device-tile")).not.toBeNull();
    expect(within(map).getByText(CONNECTIONS_COPY.map.deviceStays)).toBeInTheDocument();
    expect(within(map).getByText(/^\d of 6 parts$/)).toBeInTheDocument();
  });
});

describe("Connections services", () => {
  it("shows each service as Connected, Partial or Not connected and names what to add", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [partialTenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso IT") })).toBeInTheDocument();
    const services = screen.getByRole("region", { name: "Contoso IT services" });
    const rows = within(services).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/Intune.*Connected/);
    expect(rows[1]).toHaveTextContent(/Entra.*\d of 6 parts/);
    expect(rows[1]).not.toHaveTextContent("Partial");
    expect(rows[2]).toHaveTextContent(/Defender.*Not connected/);
    // Each row shows Microsoft's icon for the service; a service that is not connected keeps a dashed tile (step 4).
    for (const [row, id] of [[rows[0]!, "intune"], [rows[1]!, "entra"], [rows[2]!, "defender"]] as const) {
      expect(row.querySelector(`.svc-mark [data-service-logo="${id}"][data-kind="logo"] img`), id).not.toBeNull();
    }
    expect(rows[2]!.querySelector(".svc-mark")).toHaveAttribute("data-off", "true");
    // The shared app never offers Check again; consent adds access.
    expect(within(services).queryByRole("button", { name: SERVICE_COPY.checkAgain })).not.toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "Add Defender access" })).toHaveTextContent("Connect");

    await user.click(within(rows[2]!).getByRole("button", { name: "Add Defender access" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender access" });
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", ["defender.incidents", "defender.score"]));
  });

  it("adds a single missing part from its row", async () => {
    const user = userEvent.setup();
    const tenant = {
      ...partialTenant,
      grantedScopes: [
        ...new Set([
          ...intuneScopes,
          ...SERVICE_PARTS.filter((part) => part.service === "entra" && part.id !== "entra.signins").flatMap((part) => part.scopes.map((scope) => `graph:${scope.name}`)),
        ]),
      ],
    };
    const state = createMockAppState({ tenants: [tenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    const entra = within(services).getAllByRole("listitem")[1]!;
    // The missing part is a hollow dot that adds it; the button names what it adds.
    expect(within(entra).getByRole("button", { name: SERVICE_COPY.addPartLabel("Entra sign-in logs") })).toHaveTextContent("Sign-in logs");
    expect(within(entra).getByRole("button", { name: "Add Entra access" })).toHaveTextContent("Add sign-in logs");
    await user.click(within(entra).getByRole("button", { name: "Add Entra access" }));
    const dialog = screen.getByRole("dialog", { name: "Add Entra access" });
    expect(within(dialog).getByRole("checkbox", { name: "Sign-in logs" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", ["entra.signins"]));
  });

  it("adds a missing part from its chip", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [partialTenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    await user.click(await screen.findByRole("button", { name: SERVICE_COPY.addPartLabel("Entra sign-in logs") }));
    const dialog = screen.getByRole("dialog", { name: "Add Entra access" });
    expect(within(dialog).getByRole("checkbox", { name: "Sign-in logs" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Conditional Access and policies" })).not.toBeChecked();
  });

  it("lists missing permissions for an own registration with the extend script and Check again", async () => {
    const user = userEvent.setup();
    const clientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: { kind: "custom" as const, clientId },
      grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"],
    };
    const state = createMockAppState({ tenants: [tenant] });
    const refreshTenantGrants = vi.fn(async () => state);
    const bridge = render(state, { refreshTenantGrants });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    expect(within(services).getByText(/Missing: SecurityAlert\.Read\.All, SecurityIncident\.Read\.All, SecurityEvents\.Read\.All/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: SERVICE_COPY.checkAgain }));
    await waitFor(() => expect(refreshTenantGrants).toHaveBeenCalledWith("tenant-1"));

    await user.click(within(services).getByRole("button", { name: "Add Defender permissions" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender permissions" });
    await user.click(within(dialog).getByRole("button", { name: "Copy script" }));
    const script = vi.mocked(bridge.writeClipboardText).mock.calls.at(-1)?.[0] ?? "";
    expect(script).toContain(`$clientId = '${clientId}'`);
    expect(script).toContain("'SecurityAlert.Read.All'");
  });

  it("keeps the disconnect confirmation open and surfaces deletion failures", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => {
      throw new Error("The local state file could not be written.");
    });
    render(createMockAppState(), { disconnectTenant });

    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    expect(dialog).toHaveTextContent("unassigned, until you assign them to another organization");
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The local state file could not be written.");
    expect(screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ })).toBeInTheDocument();
  });

  it("keeps permissions, rename and disconnect in the Manage menu, with no plain Disconnect button", async () => {
    const user = userEvent.setup();
    const renameOrganization = vi.fn(async (id: string, name: string) => ({
      ...createMockAppState(),
      organizations: [{ id, name, createdAt: "2026-11-01T00:00:00.000Z", connections: { microsoft365: { tenantId: "tenant-1" } } }],
    }));
    render(createMockAppState(), { renameOrganization });
    const manage = await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 });
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permissions" })).not.toBeInTheDocument();
    expect(screen.getByText("contoso.example, signed in as admin@contoso.example")).toBeInTheDocument();

    await user.click(manage);
    const menu = screen.getByRole("menu", { name: CONNECTIONS_COPY.manageMicrosoft365 });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      CONNECTIONS_COPY.permissions,
      CONNECTIONS_COPY.renameOrganization,
      CONNECTIONS_COPY.disconnect,
    ]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: CONNECTIONS_COPY.renameOrganization }));
    const dialog = screen.getByRole("dialog", { name: CONNECTIONS_COPY.renameOrganization });
    const field = within(dialog).getByRole("textbox", { name: ORGANIZATION_COPY.renameLabel });
    // The dialog keeps focus on the field after the menu hands focus back.
    await waitFor(() => expect(field).toHaveFocus());
    await new Promise((done) => window.requestAnimationFrame(() => done(undefined)));
    await waitFor(() => expect(field).toHaveFocus());
    await user.clear(field);
    await user.type(field, "Contoso");
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    await waitFor(() => expect(renameOrganization).toHaveBeenCalledWith("org-tenant-1", "Contoso"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONNECTIONS_COPY.renameOrganization })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    expect(screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from/ })).toBeInTheDocument();
  });

  it("offers the Marketplace for other services and lists public references with their hosts", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
    });
    const bridge = render(state);
    expect(await screen.findByText(CONNECTIONS_COPY.addService)).toBeInTheDocument();
    const references = screen.getByRole("region", { name: CONNECTIONS_COPY.referencesHeading });
    expect(within(references).getByText("KQL Search")).toBeInTheDocument();
    expect(within(references).getByText("www.kqlsearch.com")).toBeInTheDocument();
    // The row shows the logo of the host's owner, not two letters.
    expect(within(references).getByText("KQL Search").closest("li")!.querySelector('.svc-mark [data-reference-logo="kqlsearch"][data-kind="logo"] img')).not.toBeNull();
    expect(within(references).queryByText("Microsoft Learn")).not.toBeInTheDocument();
    await user.click(within(references).getByRole("button", { name: `${CONNECTIONS_COPY.referenceTurnOff} KQL Search` }));
    await waitFor(() => expect(bridge.setMcpServerEnabled).toHaveBeenCalledWith("kql-search", false));
  });

  it("says no reference is added when none is installed", async () => {
    render(createMockAppState({ mcpServers: createMockMcpServers() }));
    expect(await screen.findByText(CONNECTIONS_COPY.referencesEmpty)).toBeInTheDocument();
  });

  it("never promises that nothing leaves the device while a delivery rule sends reports (review round 5)", async () => {
    const state = createMockAppState({
      mcpServers: createMockMcpServers(),
      installedAgents: [createMockAgent({ delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "C999" } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [connector("slack", "Slack", "unknown")]) });
    const references = await screen.findByText(CONNECTIONS_COPY.referencesEmpty);
    expect(references).not.toHaveTextContent(/nothing leaves this device/i);
    expect(await screen.findByTestId("result-destinations")).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Slack"]));
  });
});

describe("Connections results and organizations", () => {
  it("opens and closes a connector drawer from its URL", async () => {
    const user = userEvent.setup();
    render(createMockAppState(), { listConnectors: vi.fn(async () => [teamsConnector()]) }, "/connections?connector=teams");
    const drawer = await screen.findByRole("dialog", { name: "Microsoft Teams" });
    // The connector's card shows the same logo file as its row in the reach map.
    expect(drawer.querySelector('article [data-reference-logo="microsoft-teams"][data-kind="logo"] img')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Microsoft Teams" })).not.toBeInTheDocument());
  });

  it("lists only shipped connectors in Results go to, never planned ones (decision of 2026-11-04)", async () => {
    render(createMockAppState(), { listConnectors: vi.fn(async () => [teamsConnector()]) }, "/connections?connector=jira");
    const results = await screen.findByRole("region", { name: CONNECTIONS_COPY.resultsHeading });
    await waitFor(() => expect(within(results).getByText("Microsoft Teams")).toBeInTheDocument());
    for (const planned of ["Considering", "Planned", "Designed", "View details", "Jira", "ServiceNow", "SharePoint", "Generic webhook"]) {
      expect(within(results).queryByText(planned)).not.toBeInTheDocument();
    }
    // An old link to a planned connector opens nothing.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renames an organization and shows a failed rename next to the field", async () => {
    const user = userEvent.setup();
    const renameOrganization = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:rename-organization': Error: Enter a name for the organization."))
      .mockImplementationOnce(async (id: string, name: string) => ({
        ...createMockAppState(),
        organizations: [{ id, name, createdAt: "2026-11-01T00:00:00.000Z", connections: { microsoft365: { tenantId: "tenant-1" } } }],
      }));
    render(createMockAppState(), { renameOrganization }, "/connections?view=organizations");

    const list = await screen.findByRole("region", { name: CONNECTIONS_COPY.organizationsHeading });
    await user.click(within(list).getByRole("button", { name: "Rename Contoso IT" }));
    const field = within(list).getByRole("textbox", { name: ORGANIZATION_COPY.renameLabel });
    await user.clear(field);
    await user.type(field, "Contoso");
    await user.click(within(list).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    expect(await within(list).findByRole("alert")).toHaveTextContent("The name was not saved. Enter a name for the organization. Try again.");
    await user.click(within(list).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    await waitFor(() => expect(renameOrganization).toHaveBeenLastCalledWith("org-tenant-1", "Contoso"));
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso") })).toBeInTheDocument();
  });

  it("shows each tenant's app registration and removes a saved registration", async () => {
    const user = userEvent.setup();
    const customTenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: { kind: "custom" as const, clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Contoso admin app" },
    };
    const state = createMockAppState({
      tenants: [customTenant],
      savedAppRegistrations: [
        { clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Contoso admin app", lastUsedAt: "2026-11-03T10:00:00.000Z" },
        { clientId: "11111111-2222-4333-8444-555555555555", directoryTenantId: "fabrikam.onmicrosoft.com", lastUsedAt: "2026-11-01T10:00:00.000Z" },
      ],
    });
    const bridge = render(state);

    expect(await screen.findByText(/Own app registration · Contoso admin app/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: CONNECTIONS_COPY.organizationsTab }));
    const saved = screen.getByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle });
    expect(within(saved).getByText("fabrikam.onmicrosoft.com")).toBeInTheDocument();
    await user.click(
      within(saved).getByRole("button", { name: SETUP_COPY.removeSavedRegistration("11111111-2222-4333-8444-555555555555") }),
    );
    expect(bridge.removeSavedAppRegistration).toHaveBeenCalledWith("11111111-2222-4333-8444-555555555555", "fabrikam.onmicrosoft.com");
    await waitFor(() => expect(within(saved).queryByText("fabrikam.onmicrosoft.com")).not.toBeInTheDocument());
  });

  it("surfaces a failed removal of a saved registration with a recovery path", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      savedAppRegistrations: [{ clientId: "11111111-2222-4333-8444-555555555555", lastUsedAt: "2026-11-01T10:00:00.000Z" }],
    });
    render(state, {
      removeSavedAppRegistration: vi.fn(async () => {
        throw new Error("The local state file could not be written.");
      }),
    }, "/connections?view=organizations");
    await user.click(await screen.findByRole("button", { name: SETUP_COPY.removeSavedRegistration("11111111-2222-4333-8444-555555555555") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/The saved registration was not removed\. .*Try again\./);
  });
});

describe("Organizations tab", () => {
  const twoOrganizations = () =>
    createMockAppState({
      tenants: [
        createMockAppState().tenants[0]!,
        { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam", username: "admin@fabrikam.example" },
      ],
      savedAppRegistrations: [{ clientId: "11111111-2222-4333-8444-555555555555", label: "Fabrikam admin app", lastUsedAt: "2026-11-01T10:00:00.000Z" }],
    });

  it("keeps organizations and saved registrations out of the organization's own view", async () => {
    render(twoOrganizations());
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso IT") })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Contoso IT" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: CONNECTIONS_COPY.organizationsHeading })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("Fabrikam admin app")).not.toBeInTheDocument();
    // The organization switcher adds organizations; the page header does not.
    expect(screen.queryByRole("button", { name: ORGANIZATION_COPY.addOrganization })).not.toBeInTheDocument();
  });

  it("lists every organization and saved registration in the Organizations tab, by keyboard too", async () => {
    const user = userEvent.setup();
    render(twoOrganizations());
    const first = await screen.findByRole("tab", { name: "Contoso IT" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    const tab = screen.getByRole("tab", { name: CONNECTIONS_COPY.organizationsTab });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    const panel = screen.getByRole("tabpanel", { name: CONNECTIONS_COPY.organizationsTab });
    const list = within(panel).getByRole("region", { name: CONNECTIONS_COPY.organizationsHeading });
    expect(within(list).getByText("Contoso IT")).toBeInTheDocument();
    expect(within(list).getByText("Fabrikam")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: `${CONNECTIONS_COPY.makeActive}, Fabrikam` })).toBeInTheDocument();
    const saved = within(panel).getByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle });
    expect(within(saved).getByText("Fabrikam admin app")).toBeInTheDocument();
    expect(screen.queryByRole("figure", { name: CONNECTIONS_COPY.map.label })).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label })).toBeInTheDocument();
  });

  it("opens the Organizations tab from its URL", async () => {
    render(twoOrganizations(), {}, "/connections?view=organizations");
    expect(await screen.findByRole("tab", { name: CONNECTIONS_COPY.organizationsTab })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: CONNECTIONS_COPY.organizationsHeading })).toBeInTheDocument();
  });
});

describe("one destination list for the map and Results (review round 1)", () => {
  it("lists connectors a rule or a step may send to, and names rules with no destination", () => {
    const agents = [
      createMockAgent({ id: "a", slug: "a", delivery: { slack: { enabled: true }, teams: { enabled: true } } }),
      createMockAgent({ id: "b", slug: "b", connectors: [{ id: "discord" }] as never }),
      createMockAgent({ id: "c", slug: "c", delivery: { outlook: { enabled: false } } }),
    ];
    const connectors = [teamsConnector(), connector("discord", "Discord"), connector("slack", "Slack", "needs-setup"), connector("outlook", "Outlook")];
    const destinations = resultDestinations(agents, connectors);
    // Slack's rule uses the default channel and none is saved, so the host sends nothing there.
    expect(reportDestinations(destinations)).toEqual(["Microsoft Teams", "Discord"]);
    expect(targetlessDestinations(destinations)).toEqual(["Slack"]);
    // Before the connector list loads, a saved default channel is not ruled out.
    expect(reportDestinations(resultDestinations(agents, undefined))).toEqual(["Microsoft Teams", "Slack", "Discord"]);
  });

  it("shows the same destinations in the map and the Results section", async () => {
    const state = createMockAppState({
      installedAgents: [
        createMockAgent({ id: "a", slug: "a", delivery: { slack: { enabled: true }, teams: { enabled: true } } }),
        createMockAgent({ id: "b", slug: "b", connectors: [{ id: "discord" }] as never }),
      ],
    });
    render(state, {
      listConnectors: vi.fn(async () => [teamsConnector(), connector("discord", "Discord"), connector("slack", "Slack", "needs-setup")]),
    });
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Microsoft Teams", "Discord"]));
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsUnset(["Slack"]));
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Microsoft Teams and Discord under saved delivery rules and agent steps\./);
    expect(map).not.toHaveAccessibleDescription(/Slack/);
    await waitFor(() => expect(map.querySelector('[data-link-id="report:Discord"] [data-reference-logo="discord"] img')).not.toBeNull());
  });

  it("dedupes reference hosts in the map, its text alternative and the strip", async () => {
    const state = createMockAppState({
      mcpServers: createMockMcpServers({
        "release-communications": { installed: true, enabled: true, host: "www.microsoft.com" },
        "microsoft-learn": { installed: true, enabled: true, host: "www.microsoft.com" },
      }),
    });
    expect(chatToolHosts(state)).toEqual(["www.microsoft.com"]);
    render(state);
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getAllByText("www.microsoft.com")).toHaveLength(1);
    expect(map).toHaveAccessibleDescription(/Words from questions go to www\.microsoft\.com\./);
  });
});

describe("map and status strip agree (review rounds 1 and 2)", () => {
  // Every case feeds the same state to the strip's own function and to the
  // reach model; nothing is compared against hard-coded values.
  const unready = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, status: "error" as const } : provider));
  const cases: Array<[string, AppState]> = [
    ["local model", createMockAppState({ tenants: [partialTenant] })],
    ["hosted model", createMockAppState({ activeProviderId: "openai", tenants: [partialTenant] })],
    ["no model ready", createMockAppState({ providers: unready })],
    ["hosted model with references", createMockAppState({
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true }, "microsoft-learn": { installed: true, enabled: true } }),
    })],
    ["no organization", (() => { const { activeTenantId: _none, ...state } = createMockAppState(); return state; })()],
  ];
  for (const [label, state] of cases) {
    it(`names the same model, provider, hosts and services for ${label}`, () => {
      const strip = deriveDataBoundary(state);
      const model = buildReachModel(state);
      expect(model.model.kind).toBe(strip.kind);
      if (strip.kind !== "none") {
        const provider = state.providers.find((entry) => entry.id === state.activeProviderId)!;
        // A hosted strip names where prompts go; a local one names the runtime.
        expect(strip.label).toContain(strip.kind === "hosted" ? model.model.location! : model.model.providerName!);
        expect(model.model.providerName).toBe(provider.name);
        expect(model.model.name).toBe(`${strip.model ?? provider.name}, ${strip.kind}`);
      }
      // The strip names its first host and a count; the map lists the same set.
      expect(model.referenceHosts).toEqual(chatToolHosts(state));
      const stripHosts = strip.kind === "none" ? undefined : strip.toolHosts;
      if (model.referenceHosts.length > 0 && strip.kind !== "none") {
        expect(stripHosts).toBe(deriveToolHostsCopy(model.referenceHosts)?.strip);
      } else {
        expect(stripHosts).toBeUndefined();
      }
      // Services the map reads are the ones the organization switcher marks.
      const tenant = state.tenants.find((entry) => entry.id === state.activeTenantId);
      expect(model.services.filter((service) => service.status !== "missing").map((service) => service.serviceId)).toEqual(
        connectedServiceIds(tenant),
      );
    });
  }

  it("shows the strip's provider in the rendered map next to the rendered strip", async () => {
    const state = createMockAppState({ activeProviderId: "openai", tenants: [partialTenant] });
    renderRoute(
      <AppShell>
        <Connections />
      </AppShell>,
      { path: "*", route: "/connections", bridge: makeMockBridge({}, state) },
    );
    const strip = deriveDataBoundary(state);
    const rendered = await screen.findByRole("status", { name: new RegExp(strip.label) });
    expect(rendered).toHaveAccessibleName(expect.stringContaining(strip.model!));
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(new RegExp(`The model is hosted: ${strip.model}, hosted\\.`));
  });
});

describe("hosted channel per provider type (review round 1)", () => {
  it("names a vendor CLI or an API, never a CLI for an API provider", () => {
    expect(hostedChannel({ id: "anthropic", name: "Anthropic" })).toBe("the Claude Code CLI to Anthropic");
    expect(hostedChannel({ id: "openai", name: "OpenAI Codex" })).toBe("the Codex CLI to OpenAI");
    expect(hostedChannel({ id: "azure-openai", name: "Azure OpenAI" })).toBe("the Azure OpenAI API to your deployment");
    expect(hostedChannel({ id: "azure-openai", name: "Azure OpenAI" })).not.toMatch(/CLI/);
  });

  it("shows the Azure OpenAI API in the map, not a CLI", () => {
    const azure = { ...mockProviders.find((provider) => provider.id === "azure-openai")!, status: "available" as const, models: ["gpt-4o"], defaultModel: "gpt-4o" };
    const state = createMockAppState({
      activeProviderId: "azure-openai",
      providers: mockProviders.map((provider) => (provider.id === "azure-openai" ? azure : provider)),
    });
    const model = buildReachModel(state);
    expect(reachDescription(model)).toContain(`${promptsGoTo(azure, true)}.`);
    expect(reachDescription(model)).toContain("Prompts and tenant data go to Azure OpenAI · location set by your deployment type.");
    expect(reachDescription(model)).not.toMatch(/CLI/);
  });
});

describe("hosted reach copy with no organization (Muse round 2)", () => {
  it("says prompts and agent context leave and no tenant data is included", async () => {
    const { activeTenantId: _none, ...state } = createMockAppState({ activeProviderId: "openai" });
    const model = buildReachModel(state);
    const description = reachDescription(model);
    expect(description).toContain("Prompts leave this device through Codex; location set by your account. No tenant data is included, because no organization is active.");
    expect(description).not.toContain("tenant data go");
    render(state);
    const leaves = await screen.findByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    expect(within(leaves).getByText(CONNECTIONS_COPY.map.promptsNoOrganization)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTIONS_COPY.map.prompts)).not.toBeInTheDocument();
  });

  it("keeps the tenant wording when an organization is active", () => {
    const description = reachDescription(buildReachModel(createMockAppState({ activeProviderId: "openai" })));
    expect(description).toContain("Prompts and tenant data leave this device through Codex; location set by your account.");
    expect(description).not.toContain("No tenant data is included");
  });
});

describe("report destinations while connectors load (Muse round 2)", () => {
  it("says the destinations are being checked until the connector list resolves", async () => {
    let resolve!: (value: ConnectorSummary[]) => void;
    const pending = new Promise<ConnectorSummary[]>((done) => (resolve = done));
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    render(state, { listConnectors: vi.fn(() => pending) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getByText(CONNECTIONS_COPY.map.reportsLoading)).toBeInTheDocument();
    expect(map).toHaveAccessibleDescription(new RegExp(CONNECTIONS_COPY.map.reportsLoadingSentence));
    expect(map).not.toHaveAccessibleDescription(/Run reports and agent messages go nowhere/);
    resolve([teamsConnector()]);
    await waitFor(() => expect(within(map).getByText("Microsoft Teams")).toBeInTheDocument());
    expect(within(map).queryByText(CONNECTIONS_COPY.map.reportsLoading)).not.toBeInTheDocument();
  });

  it("says the destinations could not be checked when the connector list fails", async () => {
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    render(state, { listConnectors: vi.fn(async () => { throw new Error("The connector list could not be read."); }) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    await waitFor(() => expect(within(map).getByText(CONNECTIONS_COPY.map.reportsFailed)).toBeInTheDocument());
    expect(map).not.toHaveAccessibleDescription(/Run reports and agent messages go nowhere/);
  });

  it("reports nowhere only once the list is known", () => {
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { slack: { enabled: true } } })] });
    expect(buildReachModel(state).reportDestinations).toBeNull();
    expect(buildReachModel(state, []).reportDestinations).toEqual([]);
  });
});

describe("destinations follow what the host sends (review round 4)", () => {
  it("lists Slack for a saved token with no global configuration and a channel on the agent rule", async () => {
    const state = createMockAppState({
      installedAgents: [createMockAgent({ delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "C999" } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [connector("slack", "Slack", "unknown")]) });
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Slack"]));
    expect(results).not.toHaveTextContent(CONNECTIONS_COPY.resultsNone);
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getByText("Slack")).toBeInTheDocument();
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Slack/);
  });

  it("keeps a connector with a stale error or needs-setup status in the list", () => {
    const agents = [createMockAgent({ delivery: { slack: { enabled: true }, discord: { enabled: true } } })];
    const destinations = resultDestinations(agents, [
      connector("slack", "Slack", "error", { defaultChannel: "C123" }),
      connector("discord", "Discord", "needs-setup"),
    ]);
    expect(reportDestinations(destinations)).toEqual(["Slack", "Discord"]);
    expect(targetlessDestinations(destinations)).toEqual([]);
  });
});

describe("hosted voice in the map (review round 5)", () => {
  it("shows hosted Nova voice as leaving the device while the Chat model stays local, like the strip", () => {
    const state = createMockAppState({ mcpServers: createMockMcpServers() });
    const strip = deriveDataBoundary(state, true);
    expect(strip.isVoiceHosted).toBe(true);
    const model = buildReachModel(state, [], true);
    // The provider is structured data on the boundary, never parsed from its label (Muse round 6).
    expect(strip.kind === "hosted" ? strip.voiceProvider : undefined).toBe("OpenAI");
    expect(model.voice?.provider).toBe("OpenAI");
    expect(reachDescription(model)).toContain("Voice audio, prompts and tenant data go to OpenAI. Processing follows your OpenAI workspace's data residency setting. Nova's web searches also go to OpenAI.");
    expect(reachDescription(model)).toContain("The voice model is GPT-Live-1.");
    const quiet = buildReachModel(state, [], false);
    expect(quiet.voice).toBeUndefined();
    expect(reachDescription(quiet)).not.toContain("Nova voice");
  });
});

describe("saving a Teams default updates every disclosure (review round 7)", () => {
  it("lists Microsoft Teams in the map and Results after the first default team and channel are saved", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    let saved: Record<string, unknown> = {};
    render(
      state,
      {
        listConnectors: vi.fn(async () => [connector("teams", "Microsoft Teams", "connected", saved)]),
        listConnectorTeams: vi.fn(async () => [{ id: "team-1", displayName: "IT Ops" }] as never),
        listConnectorChannels: vi.fn(async () => [{ id: "channel-1", displayName: "Device alerts" }] as never),
        setConnectorConfig: vi.fn(async (_id: string, config: Record<string, unknown>) => {
          saved = { ...saved, ...config };
        }) as never,
      },
      "/connections?connector=teams",
    );
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsUnset(["Microsoft Teams"]));
    const team = await screen.findByRole("combobox", { name: "Team" });
    await waitFor(() => expect(within(team).getByRole("option", { name: "IT Ops" })).toBeInTheDocument());
    await user.selectOptions(team, "team-1");
    const channel = screen.getByRole("combobox", { name: "Channel" });
    await waitFor(() => expect(within(channel).getByRole("option", { name: "Device alerts" })).toBeInTheDocument());
    await user.selectOptions(channel, "channel-1");
    await waitFor(() => expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Microsoft Teams"])), { timeout: 3000 });
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Microsoft Teams/);
  });
});

describe("disconnect confirmation (enterprise round)", () => {
  it("names what is deleted and what stays in Entra, links the revoke steps, and needs explicit consent to delete local data", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => createMockAppState({ tenants: [] }));
    const bridge = render(createMockAppState(), { disconnectTenant });
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    for (const item of ORGANIZATION_COPY.disconnectDeletes(0)) expect(dialog).toHaveTextContent(item);
    expect(dialog).toHaveTextContent(ORGANIZATION_COPY.disconnectAuditKept);
    expect(dialog).toHaveTextContent(ORGANIZATION_COPY.disconnectNoOrganizationAfter);
    expect(dialog).toHaveTextContent("The OpenAdminOS enterprise application and the admin consent granted to it stay in the tenant.");
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectRevokeLink }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://docs.openadminos.com/trust-model/authentication#disconnecting-and-revoking");
    const confirm = within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(disconnectTenant).toHaveBeenCalledWith("tenant-1"));
  });
});

describe("hosted voice with a local chat model (design round review, Muse D)", () => {
  it("names the voice destination, keeps the local chat model local, and drops tenant data without an organization", async () => {
    const { activeTenantId: _none, ...noOrg } = createMockAppState();
    const strip = deriveDataBoundary(noOrg, true);
    // Voice goes to OpenAI's own service, never through Codex, in PR #175's words.
    expect(strip.kind === "hosted" ? strip.voiceLocation : undefined).toBe("OpenAI");
    expect(strip.tooltip).toContain("Voice audio and prompts go to OpenAI. No organization is active, so no tenant data is sent.");
    expect(strip.tooltip).toContain("Processing follows your OpenAI workspace's data residency setting.");
    expect(strip.tooltip).toContain("Nova's web searches also go to OpenAI.");
    expect(strip.tooltip).toMatch(/The chat model, Ollama, stays on this device\./);
    expect(strip.tooltip).not.toMatch(/Codex|Tenant context will be sent/);
    const withOrg = deriveDataBoundary(createMockAppState(), true);
    expect(withOrg.tooltip).toContain("Voice audio, prompts and tenant data go to OpenAI.");
  });
});

describe("disconnect names the registration and what goes (design round review)", () => {
  it("names an own app registration with its client ID and links its revoke steps", async () => {
    const user = userEvent.setup();
    const base = createMockAppState();
    const tenant = {
      ...base.tenants[0]!,
      appRegistration: { kind: "custom" as const, clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Contoso admin tools", authority: "https://login.microsoftonline.com/contoso.example" },
    };
    const bridge = render(createMockAppState({ tenants: [tenant] }));
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    expect(dialog).toHaveTextContent("Your app registration Contoso admin tools (client ID aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee) and the admin consent granted to it stay in the tenant.");
    expect(dialog).not.toHaveTextContent("OpenAdminOS enterprise application");
    // The tenant domain shows in the destructive dialog.
    expect(dialog).toHaveTextContent(`${tenant.username.split("@")[1]}, signed in as ${tenant.username}`);
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectRevokeLink }));
    expect(bridge.openExternal).toHaveBeenCalledWith(ORGANIZATION_COPY.disconnectRevokeOwnUrl);
  });

  it("counts the runs it deletes and keeps the recovery steps in a failure", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({ status: "completed", tenantId: "tenant-1" });
    const disconnectTenant = vi.fn(async () => { throw new Error("Secure storage is not available."); });
    render(createMockAppState({ runs: [run, { ...run, id: "run-2" }] }), { disconnectTenant });
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    expect(dialog).toHaveTextContent("Its run history (2 runs) and queued report deliveries");
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Secure storage is not available\..*Restart OpenAdminOS/);
  });

  it("offers Disconnect on each row of the Organizations tab", async () => {
    const user = userEvent.setup();
    const base = createMockAppState().tenants[0]!;
    render(createMockAppState({ tenants: [base, { ...base, id: "tenant-2", displayName: "Fabrikam", username: "admin@fabrikam.example" }] }), {}, "/connections?view=organizations");
    await user.click(await screen.findByRole("button", { name: `${CONNECTIONS_COPY.disconnect}, Fabrikam` }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Fabrikam/ });
    // Fabrikam is not active, so the active organization stays.
    expect(dialog).not.toHaveTextContent(ORGANIZATION_COPY.disconnectNoOrganizationAfter);
  });
});

it("opens this organization's granted permissions from the Manage menu, not the connect flow (design round review, Muse M)", async () => {
  const user = userEvent.setup();
  const base = createMockAppState().tenants[0]!;
  render(createMockAppState({ tenants: [{ ...base, grantedScopes: intuneScopes }] }));
  await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
  await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.permissions }));
  const dialog = screen.getByRole("dialog", { name: CONNECTIONS_COPY.permissionsTitle("Contoso IT") });
  expect(within(dialog).getAllByText(CONNECTIONS_COPY.permissionGranted).length).toBeGreaterThan(0);
  expect(within(dialog).getAllByText(CONNECTIONS_COPY.permissionNotGranted).length).toBeGreaterThan(0);
  expect(within(dialog).getByText(/DeviceManagementManagedDevices\.Read\.All/)).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "OpenAdminOS app" })).not.toBeInTheDocument();
});

it("says report destinations could not be checked on the No organization page (design round review, Muse Q)", async () => {
  const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents: [createMockAgent({ delivery: { slack: { enabled: true } } })] });
  render(state, { listConnectors: vi.fn(async () => { throw new Error("The connector list could not be read."); }) });
  const leaves = await screen.findByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
  expect(await within(leaves).findByText(CONNECTIONS_COPY.map.reportsFailedSentence)).toBeInTheDocument();
});

it("says a missing part is not granted in words, on a 24 px target (design round review, Muse U)", async () => {
  const base = createMockAppState().tenants[0]!;
  render(createMockAppState({ tenants: [{ ...base, grantedScopes: intuneScopes }] }));
  const services = await screen.findByRole("region", { name: CONNECTIONS_COPY.servicesHeading });
  const missing = within(services).getAllByRole("button").filter((button) => button.getAttribute("data-missing") === "true");
  expect(missing.length).toBeGreaterThan(0);
  for (const button of missing) expect(button).toHaveTextContent(/, not granted$/);
});

it("says multi-tenant jobs are deleted whole, with other organizations' results (design round review 2)", () => {
  expect(ORGANIZATION_COPY.disconnectDeletes(1)).toContain(
    "Multi-tenant chats and jobs that include it, deleted whole, with the results for the other organizations in them",
  );
});

describe("hosted voice with a hosted chat model and references (design round review 2, Muse A)", () => {
  it("keeps the chat provider and the reference count in the strip and the composer", async () => {
    const { hostedComposerSentence } = await import("./IntuneChat");
    const state = createMockAppState({
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true }, "kql-search": { installed: true, enabled: true } }),
    });
    const strip = deriveDataBoundary(state, true);
    expect(strip.label).toBe("Voice · OpenAI and Codex");
    expect(strip.kind !== "none" ? strip.toolHosts : undefined).toBeTruthy();
    expect(strip.tooltip).toContain("Prompts and tenant data leave this device through Codex; location set by your account.");
    const provider = state.providers.find((entry) => entry.id === "openai");
    const composer = hostedComposerSentence(strip, provider, true);
    expect(composer).toContain("Voice audio, prompts and tenant data go to OpenAI.");
    expect(composer).toContain("Prompts and tenant data leave this device through Codex; location set by your account while this model is selected.");
    expect(composer).toContain("learn.microsoft.com and www.kqlsearch.com");
  });
});

describe("Disconnect redesign: a partial outcome is a warning (Muse 1)", () => {
  it("says the organization was removed and what is pending, then offers Retry cleanup until it finishes", async () => {
    const user = userEvent.setup();
    const pending = { tenantId: "tenant-1", displayName: "Contoso IT", removedAt: "2026-11-09T10:00:00.000Z", error: "Its Agent Team data could not be deleted. The database is locked." };
    const disconnectTenant = vi.fn(async () => createMockAppState({ tenants: [], tenantCleanups: [pending] }));
    const bridge = render(createMockAppState(), { disconnectTenant });
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    // Not "Disconnecting failed": a warning with what was done and what is pending.
    expect(await screen.findByText(ORGANIZATION_COPY.disconnectedCleanupPending("Contoso IT", pending.error))).toBeInTheDocument();
    expect(screen.queryByText(/Disconnecting failed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ })).not.toBeInTheDocument();
    const notice = await screen.findByRole("region", { name: ORGANIZATION_COPY.cleanupHeading });
    expect(notice).toHaveTextContent(ORGANIZATION_COPY.cleanupBody("Contoso IT", pending.error));
    await user.click(within(notice).getByRole("button", { name: `${ORGANIZATION_COPY.retryCleanup}, Contoso IT` }));
    await waitFor(() => expect(bridge.retryTenantCleanup).toHaveBeenCalledWith("tenant-1"));
    expect(await screen.findByText(ORGANIZATION_COPY.cleanupFinished("Contoso IT"))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: ORGANIZATION_COPY.cleanupHeading })).not.toBeInTheDocument());
  });

  it("reloads the state after a failed disconnect, so the page shows what changed on the host", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => {
      throw new Error("The local state file could not be written.");
    });
    const bridge = render(createMockAppState(), { disconnectTenant });
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    const reads = vi.mocked(bridge.getAppState).mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The local state file could not be written.");
    await waitFor(() => expect(vi.mocked(bridge.getAppState).mock.calls.length).toBeGreaterThan(reads));
  });
});
