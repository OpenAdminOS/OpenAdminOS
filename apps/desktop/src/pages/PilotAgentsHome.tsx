import { useMemo } from "react";
import { useNavigate } from "react-router";

import { Button } from "../components/Button";
import { IconBolt, IconLock, IconPlay, IconShield } from "../components/icons";
import { SampleSchedulesPausedNotice } from "../components/SampleSchedulesPausedNotice";
import { useToast } from "../components/Toast";
import { StatusDot } from "../components/ui";
import { formatAgentDisplayName } from "../shared/agent-display";
import type { AgentSummary, RegistryAgentSummary } from "../shared/openAdminOS";
import {
  PILOT_AGENT_SLUGS,
  PILOT_COPY,
  isPilotAgentSlug,
} from "../shared/pilot-mode";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { useAppState } from "../state";

type AgentRow = {
  slug: string;
  name: string;
  description: string;
  mode: "read" | "write";
  installed?: AgentSummary;
};

function toRow(agent: AgentSummary | RegistryAgentSummary, installed?: AgentSummary): AgentRow {
  return {
    slug: agent.slug,
    name: formatAgentDisplayName(agent),
    description: agent.description,
    mode: agent.mode,
    ...(installed ? { installed } : {}),
  };
}

/**
 * Agents in pilot mode: the three pilot agents first, every other agent
 * listed as a production feature. Agents added to the registry later land
 * in the production list automatically.
 */
export default function PilotAgentsHome() {
  const navigate = useNavigate();
  const toast = useToast();
  const { state, registryAgents, startRun } = useAppState();
  const { openSetup } = useSetupFlow();

  const installedBySlug = useMemo(
    () => new Map(state.installedAgents.map((agent) => [agent.slug, agent])),
    [state.installedAgents],
  );
  const pilotRows = PILOT_AGENT_SLUGS.flatMap((slug) => {
    const installed = installedBySlug.get(slug);
    const registry = registryAgents.find((agent) => agent.slug === slug);
    const source = installed ?? registry;
    return source ? [toRow(source, installed)] : [];
  });
  const productionRows = useMemo(() => {
    const rows = new Map<string, AgentRow>();
    for (const agent of registryAgents) {
      if (!isPilotAgentSlug(agent.slug)) rows.set(agent.slug, toRow(agent));
    }
    for (const agent of state.installedAgents) {
      if (!isPilotAgentSlug(agent.slug) && !rows.has(agent.slug)) {
        rows.set(agent.slug, toRow(agent));
      }
    }
    return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [registryAgents, state.installedAgents]);
  const showSchedulesPaused =
    state.tenants.some((tenant) => tenant.kind !== "sample") ||
    state.installedAgents.some((agent) => agent.schedule?.enabled === true);

  const run = async (row: AgentRow) => {
    if (!row.installed) return;
    if (row.mode === "write") {
      navigate(`/agents/${encodeURIComponent(row.slug)}/confirm`);
      return;
    }
    try {
      const started = await startRun(row.slug);
      navigate(`/runs/${started.id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="calm-page-column">
      {showSchedulesPaused ? <SampleSchedulesPausedNotice className="mb-5" /> : null}
      <section aria-labelledby="pilot-agents-heading">
        <h2 id="pilot-agents-heading" className="px-0.5 pb-2 text-sm font-medium text-[var(--color-text-muted)]">
          {PILOT_COPY.agentsAvailable}
        </h2>
        <div aria-label={PILOT_COPY.agentsAvailable}>
          {pilotRows.map((row) => (
            <div key={row.slug} className="calm-list-row group">
              <span className="calm-row-icon">
                {row.mode === "write" ? <IconBolt size={16} /> : <IconShield size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block w-full min-w-0 text-left"
                  onClick={() => navigate(`/agents/${encodeURIComponent(row.slug)}`)}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate font-medium text-[var(--color-text)]">{row.name}</span>
                    <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                      <StatusDot tone={row.mode === "write" ? "warning" : "success"} />
                      {row.mode === "write" ? "Makes changes to sample data, with confirmation" : "Read-only"}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-[var(--color-text-muted)]">{row.description}</span>
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<IconPlay size={13} />}
                  disabled={!row.installed}
                  onClick={() => void run(row)}
                  aria-label={`Run ${row.name}`}
                >
                  Run
                </Button>
              </div>
            </div>
          ))}
          {pilotRows.length === 0 ? (
            <div role="status" className="px-6 py-8 text-center text-sm text-[var(--color-text-muted)]">
              The pilot agents are not available in this build. Connect your tenant to install agents from the hub.
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="production-agents-heading" className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-0.5 pb-2">
          <h2 id="production-agents-heading" className="text-sm font-medium text-[var(--color-text-muted)]">
            {PILOT_COPY.agentsProduction}
          </h2>
          <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{productionRows.length} agents</span>
        </div>
        <div aria-label={PILOT_COPY.agentsProduction}>
          {productionRows.map((row) => (
            <div key={row.slug} className="calm-list-row opacity-80">
              <span className="calm-row-icon">
                <IconLock size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate font-medium text-[var(--color-text)]">{row.name}</span>
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {row.mode === "write" ? "Makes changes" : "Read-only"}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-sm text-[var(--color-text-muted)]">{row.description}</span>
              </div>
              <button
                type="button"
                onClick={openSetup}
                aria-label={`${PILOT_COPY.agentConnectToRun} ${row.name}`}
                className="shrink-0 rounded px-1 text-sm text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                {PILOT_COPY.agentConnectToRun}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
