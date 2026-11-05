import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { AGENT_COPY } from "../../copy";
import { formatAgentDisplayName, type AgentDisplay } from "../../shared/agent-display";
import {
  agentServiceIds,
  type AgentSummary,
  type InvalidAgentManifest,
  type RegistryAgentSummary,
} from "../../shared/openAdminOS";
import { PILOT_COPY } from "../../shared/pilot-mode";
import { useAppState } from "../../state";
import { IconShield } from "../icons";
import { NewAgentModal } from "../NewAgentModal";
import { ServiceChips } from "../ServiceAccess";
import { Badge, Button } from "../ui";
import { CoverArt } from "./CoverArt";

export function hasLicenseShortfall(
  required: "free" | "p1" | "p2",
  actual: "free" | "p1" | "p2" | "unknown" | undefined,
) {
  if (!actual || actual === "unknown") return false;
  const rank = { free: 0, p1: 1, p2: 2 } as const;
  return rank[actual] < rank[required];
}

function toRegistryDisplay(agent: RegistryAgentSummary, installed?: AgentSummary): AgentDisplay {
  return {
    ...agent,
    installed: Boolean(installed),
    lastRunAt: installed?.lastRunAt,
    updateAvailable: installed?.updateAvailable,
    author: {
      name: agent.author.name,
      handle: agent.author.handle ?? "community",
      verified: agent.author.verified ?? false,
    },
  };
}

export function matchesAgentQuery(agent: RegistryAgentSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [agent.name, agent.description, agent.author.name, agent.category, ...agent.scopes]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

/**
 * The registry agent catalog, formerly the Agents page hub tab. Install
 * and details stay on /agents/:slug; pilot mode lists agents without
 * install because agent install is a production feature.
 */
export function AgentHubList({ query, pilot }: { query: string; pilot: boolean }) {
  const navigate = useNavigate();
  const { state, registryAgents } = useAppState();
  const activeTenant = state.tenants.find((tenant) => tenant.id === state.activeTenantId);
  const installedBySlug = useMemo(
    () => new Map(state.installedAgents.map((agent) => [agent.slug, agent])),
    [state.installedAgents],
  );
  const rows = registryAgents.filter((agent) => matchesAgentQuery(agent, query));
  const invalidAgents = state.invalidAgents ?? [];
  const [editingInvalid, setEditingInvalid] = useState<InvalidAgentManifest | null>(null);

  const openAgent = (slug: string, action?: "install") => {
    const search = new URLSearchParams({ from: "marketplace" });
    if (action) search.set("action", action);
    navigate({ pathname: `/agents/${encodeURIComponent(slug)}`, search: `?${search.toString()}` });
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
        <span>{rows.length} of {registryAgents.length} agents</span>
        {pilot ? <span>{PILOT_COPY.featureInProduction("Agent install")}</span> : null}
      </div>
      <div aria-label="Agent catalog" className="grid grid-cols-1 gap-x-7 lg:grid-cols-2">
        {rows.map((agent) => {
          const installed = installedBySlug.get(agent.slug);
          const display = toRegistryDisplay(agent, installed);
          const licenseMissing = hasLicenseShortfall(agent.requiresEntraTier, activeTenant?.entraTier);
          return (
            <div key={agent.id} className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-[var(--color-border-soft)] py-3">
              <span className="h-12 w-12 overflow-hidden rounded-xl">
                <CoverArt id={agent.slug} variant="icon" className="h-full w-full" />
              </span>
              <button type="button" className="group min-w-0 text-left" onClick={() => openAgent(agent.slug)}>
                <span className="block truncate font-medium text-[var(--color-text)] group-hover:underline group-hover:underline-offset-2">
                  {formatAgentDisplayName(display)}
                </span>
                <span className="block truncate text-sm text-[var(--color-text-muted)]">{agent.description}</span>
                <span className="mt-1 block"><ServiceChips services={agentServiceIds(display)} /></span>
                <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
                  Agent · <span className={agent.mode === "write" ? "text-[var(--color-warning)]" : ""}>{agent.mode === "write" ? "Makes changes after your approval" : "Read only"}</span>
                  {installed ? " · Installed" : ""}
                  {licenseMissing ? <span className="text-[var(--color-warning)]"> · License required</span> : null}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {installed ? (
                  <Button size="sm" variant="ghost" onClick={() => openAgent(agent.slug)}>Open</Button>
                ) : pilot ? (
                  <Button size="sm" variant="ghost" onClick={() => openAgent(agent.slug)}>Details</Button>
                ) : (
                  <>
                    <Button size="sm" variant="secondary" disabled={agent.compatibility?.supported === false} onClick={() => openAgent(agent.slug, "install")}>Install</Button>
                    <Button size="sm" variant="ghost" onClick={() => openAgent(agent.slug)}>Details</Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {invalidAgents.length > 0 ? (
        <div aria-label="Invalid agent manifests" className="mt-3">
          {invalidAgents.map((entry) => (
            <InvalidAgentRow
              key={`invalid-${entry.registryPath}`}
              entry={entry}
              onEdit={entry.source === "user" && entry.sourceText !== undefined ? () => setEditingInvalid(entry) : undefined}
            />
          ))}
        </div>
      ) : null}
      {rows.length === 0 && invalidAgents.length === 0 ? (
        <div role="status" className="px-6 py-10 text-center">
          <div className="font-medium text-[var(--color-text)]">No agents match</div>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {registryAgents.length === 0
              ? state.registryRefreshError ?? "The agent catalog has not loaded yet. Refresh the catalog to load it."
              : "Clear the search or try a Graph scope such as User.Read.All."}
          </p>
        </div>
      ) : null}
      {editingInvalid ? (
        <NewAgentModal
          open
          onClose={() => setEditingInvalid(null)}
          initialYamlSource={editingInvalid.sourceText}
          editingSlug={editingInvalid.folder}
        />
      ) : null}
    </div>
  );
}

/** A local manifest that failed validation, listed as unavailable. */
function InvalidAgentRow({
  entry,
  onEdit,
}: {
  entry: InvalidAgentManifest;
  onEdit?: () => void;
}) {
  return (
    <div className="calm-list-row group" aria-label={`${entry.id} ${AGENT_COPY.invalidBadge.toLowerCase()}`}>
      <span className="calm-row-icon text-[var(--color-danger)]">
        <IconShield size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-medium text-[var(--color-text)]">{entry.id}</span>
          <Badge tone="danger">{AGENT_COPY.invalidBadge}</Badge>
        </span>
        <span className="mt-0.5 block text-sm text-[var(--color-danger)]">
          {AGENT_COPY.invalidTitle}. {entry.reason}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-[var(--color-text-muted)]" title={entry.manifestPath}>
          {entry.manifestPath}
        </span>
      </div>
      {onEdit ? (
        <div className="calm-row-actions flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onEdit}>{AGENT_COPY.invalidEditAction}</Button>
        </div>
      ) : null}
    </div>
  );
}
