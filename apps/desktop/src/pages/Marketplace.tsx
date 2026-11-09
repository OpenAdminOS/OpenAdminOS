import { useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { PageBody, PageHeader } from "../components/AppShell";
import { IconCloud, IconExternal, IconRefresh, IconSearch, IconShield, IconWarning } from "../components/icons";
import { AgentHubList, matchesAgentQuery } from "../components/marketplace/AgentHubList";
import { CoverArt, inkFor } from "../components/marketplace/CoverArt";
import { ListingTags, McpServerDialog } from "../components/marketplace/McpServerDialog";
import { usePilotMode } from "../components/PilotMode";
import { useToast } from "../components/Toast";
import { IconButton } from "../components/ui";
import type { McpServerSummary } from "../shared/openAdminOS";
import { useAppState } from "../state";

type Kind = "discover" | "agents" | "mcp";

function matchesServer(server: McpServerSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [server.name, server.publisher, server.pitch, server.description, server.host, ...server.tools.map((tool) => tool.name)]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

export default function Marketplace() {
  const { state, registryAgents, refreshRegistry } = useAppState();
  const toast = useToast();
  const pilot = usePilotMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [spot, setSpot] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const kindParam = searchParams.get("kind");
  const kind: Kind = kindParam === "agents" || kindParam === "mcp" ? kindParam : "discover";
  const servers = state.mcpServers ?? [];
  const openServerId = searchParams.get("server");
  const openServer = servers.find((server) => server.id === openServerId);
  const filtering = kind !== "discover" || query.trim() !== "";
  const shownServers = servers.filter((server) => matchesServer(server, query));
  const showSplashtopApi = matchesListing(SPLASHTOP_API_LISTING.terms, query);
  const toolUse = state.chatToolUse;

  const setParams = (update: (next: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      update(next);
      return next;
    });
  };
  const setKind = (next: Kind) => setParams((params) => {
    if (next === "discover") params.delete("kind");
    else params.set("kind", next);
  });
  const openListing = (id: string, install = false) => setParams((params) => {
    params.set("server", id);
    if (install) params.set("install", "1");
    else params.delete("install");
  });
  const closeListing = () => setParams((params) => {
    params.delete("server");
    params.delete("install");
  });
  const refresh = () => {
    setRefreshing(true);
    void refreshRegistry()
      .catch((caught) => toast.error(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setRefreshing(false));
  };

  const kinds: Array<{ id: Kind; label: string; count?: number }> = [
    { id: "discover", label: "Discover" },
    { id: "agents", label: "Agents", count: registryAgents.length },
    { id: "mcp", label: "MCP tools", count: servers.length },
  ];
  const featured = servers[Math.min(spot, Math.max(0, servers.length - 1))];
  const searching = query.trim() !== "";
  const agentMatches = registryAgents.filter((agent) => matchesAgentQuery(agent, query)).length;

  return (
    <>
      <PageHeader
        wide
        title="Marketplace"
        subtitle="Agents and MCP tools for Intune and Entra. Each listing shows what it reads, where queries go and where it runs before you install it."
        actions={
          <>
            <label className="relative w-[280px] max-w-full">
              <span className="sr-only">Search the Marketplace</span>
              <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="search"
                name="marketplace-search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search listings, publishers, scopes"
                className="h-8 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
              />
            </label>
            <IconButton
              label="Refresh agent catalog"
              icon={<IconRefresh size={14} className={refreshing ? "animate-spin" : ""} />}
              disabled={refreshing}
              onClick={refresh}
            />
          </>
        }
      />
      <PageBody>
        <div className="calm-page-column-wide pb-14">
          {!filtering && featured ? (
            <Spotlight
              servers={servers}
              featured={featured}
              onSelect={setSpot}
              onOpen={(id) => openListing(id)}
              onInstall={(id) => openListing(id, true)}
            />
          ) : null}

          <div role="group" aria-label="Listing kind" className="mb-7 flex flex-wrap items-baseline gap-x-7 gap-y-2 border-b border-[var(--color-border-soft)]">
            {kinds.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={kind === entry.id}
                onClick={() => setKind(entry.id)}
                className={`relative pb-3 font-serif text-[24px] tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
                  kind === entry.id
                    ? "text-[var(--color-text)] after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[var(--color-text)]"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-soft)]"
                }`}
              >
                {entry.label}
                {entry.count !== undefined ? <sup className="ml-1 font-sans text-[11px] text-[var(--color-text-muted)]">{entry.count}</sup> : null}
              </button>
            ))}
          </div>

          {query.trim() ? (
            <h2 className="mb-4 font-serif text-2xl font-normal text-[var(--color-text)]">Results for "{query.trim()}"</h2>
          ) : null}

          {kind !== "agents" ? (
            <Shelf
              title="MCP tools"
              note="Public, read-only servers. Chat calls their tools with any provider."
              hidden={searching && shownServers.length === 0 && !showSplashtopApi}
            >
              {toolUse?.available === false && toolUse.notice ? (
                <div role="note" className="mb-4 flex gap-2.5 rounded-xl bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                  <IconWarning size={16} className="mt-0.5 shrink-0" />
                  <span>{toolUse.notice}</span>
                </div>
              ) : null}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
                {shownServers.map((server) => (
                  <McpCard
                    key={server.id}
                    server={server}
                    toolUseNotice={toolUse?.available === false ? toolUse.notice : undefined}
                    onOpen={() => openListing(server.id)}
                  />
                ))}
                {showSplashtopApi ? <ConnectionListingCard /> : null}
              </div>
              {servers.length === 0 ? (
                <p role="status" className="text-sm text-[var(--color-text-muted)]">The MCP catalog is not available in this build.</p>
              ) : null}
            </Shelf>
          ) : null}

          {kind !== "mcp" ? (
            <Shelf
              title="Agents"
              note="From the community registry. Reviewed in pull requests on GitHub."
              hidden={searching && agentMatches === 0}
            >
              <AgentHubList query={query} pilot={pilot} />
            </Shelf>
          ) : null}

          {searching && (kind === "agents" ? 0 : shownServers.length) + (kind === "mcp" ? 0 : agentMatches) === 0 ? (
            <div role="status" className="rounded-2xl border border-dashed border-[var(--color-border)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              No listings match. Try a publisher name, a Graph scope such as User.Read.All or a host such as learn.microsoft.com.
            </div>
          ) : null}
        </div>
      </PageBody>
      {openServer ? (
        <McpServerDialog
          key={openServer.id}
          server={openServer}
          toolUse={toolUse}
          startWithInstall={searchParams.get("install") === "1"}
          onClose={closeListing}
        />
      ) : null}
    </>
  );
}

/**
 * A vendor service built into OpenAdminOS that needs the customer's own
 * credentials. It is connected per organization on Connections, so the
 * listing opens that connect step instead of installing anything here.
 */
const SPLASHTOP_API_LISTING = {
  id: "splashtop-open-api",
  name: "Splashtop",
  publisher: "Splashtop",
  pitch: "Read computers, inventory, users, sessions and audit logs, and plan changes such as reboots, each applied only after your typed confirmation.",
  terms: ["splashtop", "splashtop open api", "splashtop api", "remote access", "remote support", "connection"],
};

function matchesListing(terms: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return terms.some((term) => term.includes(needle) || needle.includes(term));
}

function ConnectionListingCard() {
  const navigate = useNavigate();
  const listing = SPLASHTOP_API_LISTING;
  return (
    <button
      type="button"
      aria-label={`${listing.name}, connection by ${listing.publisher}. Connect on Connections`}
      onClick={() => navigate("/connections?connect=splashtop")}
      className="flex flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] text-left ring-1 ring-[var(--color-border-soft)] transition-shadow hover:ring-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
    >
      <span className="relative block aspect-[16/10]">
        <CoverArt id={listing.id} className="absolute inset-0 h-full w-full" />
        <span className="absolute left-3 top-3"><ListingTags tags={["Connection", "Built in"]} /></span>
      </span>
      <span className="flex flex-1 flex-col gap-2.5 px-4 pb-4 pt-3.5">
        <span>
          <span className="block text-[15px] font-semibold leading-tight text-[var(--color-text)]">{listing.name}</span>
          <span className="text-sm text-[var(--color-text-muted)]">{listing.publisher}</span>
        </span>
        <span className="text-sm text-[var(--color-text-soft)]">{listing.pitch}</span>
        <span className="grid gap-1.5 text-sm text-[var(--color-text-muted)]">
          <span className="flex items-center gap-2"><IconShield size={13} className="shrink-0" /><span>Needs a Splashtop Enterprise API token</span></span>
          <span className="flex items-center gap-2"><IconShield size={13} className="shrink-0" /><span>The token stays in this device's secure storage</span></span>
          <span className="flex items-center gap-2 text-[var(--color-warning)]"><IconCloud size={13} className="shrink-0" /><span>Requests go only to webapi.splashtop.com, .eu or .nr</span></span>
        </span>
        <span className="mt-auto flex items-center justify-between gap-2 pt-1 text-sm">
          <span className="text-[var(--color-text-soft)]">Connect on Connections</span>
          <span className="whitespace-nowrap text-xs text-[var(--color-text-muted)]">Per organization</span>
        </span>
      </span>
    </button>
  );
}

function Shelf({ title, note, hidden = false, children }: { title: string; note: string; hidden?: boolean; children: ReactNode }) {
  if (hidden) return null;
  return (
    <section aria-label={title} className="mb-10">
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="font-serif text-2xl font-normal tracking-[-0.01em] text-[var(--color-text)]">{title}</h2>
        <p className="text-sm text-[var(--color-text-muted)]">{note}</p>
      </div>
      {children}
    </section>
  );
}

function serverState(server: McpServerSummary): { label: string; tone: string } | undefined {
  if (!server.installed) return undefined;
  if (server.missingTools?.length) return { label: "Installed · tools missing", tone: "text-[var(--color-warning)]" };
  return server.enabled
    ? { label: "Installed", tone: "text-[var(--color-success)]" }
    : { label: "Installed · off", tone: "text-[var(--color-text-muted)]" };
}

function Ledger({ server, onDark = false }: { server: McpServerSummary; onDark?: boolean }) {
  const muted = onDark ? "" : "text-[var(--color-text-muted)]";
  const outbound = onDark ? "" : "text-[var(--color-warning)]";
  return (
    <div className={`grid gap-1.5 text-sm ${muted}`}>
      <div className="flex items-center gap-2"><IconShield size={13} className="shrink-0" /><span>No tenant access · read only</span></div>
      <div className={`flex items-center gap-2 ${outbound}`}><IconCloud size={13} className="shrink-0" /><span>Sends tool queries to {server.host}</span></div>
      <div className="flex items-center gap-2"><IconExternal size={13} className="shrink-0" /><span>Tool calls run at {server.publisher}</span></div>
    </div>
  );
}

function McpCard({ server, toolUseNotice, onOpen }: { server: McpServerSummary; toolUseNotice?: string; onOpen: () => void }) {
  const status = serverState(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${server.name}, MCP tool by ${server.publisher}`}
      className="flex flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] text-left ring-1 ring-[var(--color-border-soft)] transition-shadow hover:ring-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
    >
      <span className="relative block aspect-[16/10]">
        <CoverArt id={server.id} className="absolute inset-0 h-full w-full" />
        <span className="absolute left-3 top-3"><ListingTags tags={["MCP tool", "Read only"]} /></span>
      </span>
      <span className="flex flex-1 flex-col gap-2.5 px-4 pb-4 pt-3.5">
        <span>
          <span className="block text-[15px] font-semibold leading-tight text-[var(--color-text)]">{server.name}</span>
          <span className="text-sm text-[var(--color-text-muted)]">{server.publisher}</span>
        </span>
        <span className="text-sm text-[var(--color-text-soft)]">{server.pitch}</span>
        <Ledger server={server} />
        {toolUseNotice ? <span className="text-xs leading-5 text-[var(--color-warning)]">{toolUseNotice}</span> : null}
        <span className="mt-auto flex items-center justify-between gap-2 pt-1 text-sm">
          <span className="text-[var(--color-text-soft)]">No sign-in needed</span>
          {status ? <span className={`whitespace-nowrap text-xs ${status.tone}`}>{status.label}</span> : null}
        </span>
      </span>
    </button>
  );
}

function Spotlight({
  servers,
  featured,
  onSelect,
  onOpen,
  onInstall,
}: {
  servers: McpServerSummary[];
  featured: McpServerSummary;
  onSelect: (index: number) => void;
  onOpen: (id: string) => void;
  onInstall: (id: string) => void;
}) {
  const ink = inkFor(featured.id);
  return (
    <section aria-label="Spotlight" className="mb-9 grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_236px]">
      <article className="relative isolate min-h-[320px] overflow-hidden rounded-[18px]" style={{ background: ink.ground, color: ink.highlight }}>
        <CoverArt id={featured.id} className="absolute inset-0 -z-20 h-full w-full" />
        <div
          className="absolute inset-0 -z-10"
          style={{ background: `linear-gradient(90deg, ${ink.ground} 0%, ${ink.ground} 28%, ${ink.ground}8c 55%, transparent 80%)` }}
        />
        <div className="flex h-full max-w-[470px] flex-col justify-end gap-3.5 px-7 py-7">
          <ListingTags tags={["MCP tool", "Read only"]} />
          <h2 className="font-serif text-[42px] font-normal leading-[1.02] tracking-[-0.02em]">{featured.name}</h2>
          <p className="max-w-[40ch] text-[15px] opacity-80">{featured.pitch}</p>
          <div className="opacity-80"><Ledger server={featured} onDark /></div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => (featured.installed ? onOpen(featured.id) : onInstall(featured.id))}
              className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#121418] hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              {featured.installed ? "Open" : "Install"}
            </button>
            <button
              type="button"
              onClick={() => onOpen(featured.id)}
              className="inline-flex items-center rounded-full bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Details
            </button>
            <small className="basis-full text-xs opacity-60">No sign-in needed · {featured.publisher}</small>
          </div>
        </div>
      </article>
      <div className="grid content-start gap-2 sm:grid-cols-3 lg:grid-cols-1">
        {servers.map((server, index) => (
          <button
            key={server.id}
            type="button"
            aria-pressed={server.id === featured.id}
            onClick={() => onSelect(index)}
            className={`grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3 rounded-xl p-2 text-left ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${
              server.id === featured.id
                ? "bg-[var(--color-surface)] ring-[var(--color-border)]"
                : "ring-transparent hover:bg-[var(--color-hover)]"
            }`}
          >
            <span className="h-12 w-16 overflow-hidden rounded-lg"><CoverArt id={server.id} variant="icon" className="h-full w-full" /></span>
            <span className="min-w-0">
              <b className="block truncate text-sm font-medium text-[var(--color-text)]">{server.name}</b>
              <span className="block truncate text-xs text-[var(--color-text-muted)]">{server.publisher}</span>
            </span>
          </button>
        ))}
        <p className="px-2 pt-1 text-xs text-[var(--color-text-muted)]">Spotlight is picked by maintainers. Listings cannot pay for placement.</p>
      </div>
    </section>
  );
}
