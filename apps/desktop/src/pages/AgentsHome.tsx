import { useState } from "react";
import { useNavigate } from "react-router";
import { AgentCard } from "../components/AgentCard";
import { Button } from "../components/Button";
import { NewAgentModal } from "../components/NewAgentModal";
import { IconHub, IconPlus, IconSearch } from "../components/icons";
import type { AgentDisplay } from "../shared/agent-display";
import {
  resolveProviderDefaultModel,
  type AgentSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { createPendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";

export default function AgentsHome() {
  const navigate = useNavigate();
  const { state, startRun } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [query, setQuery] = useState("");
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const activeModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const displayAgents = state.installedAgents.map((agent) =>
    toDisplayAgent(agent, state.runs, activeModel),
  );

  const filtered = displayAgents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(query.toLowerCase()) ||
      agent.description.toLowerCase().includes(query.toLowerCase()),
  );

  const handleStartRun = async (slug: string) => {
    setRunError(null);
    try {
      const run = await startRun(slug);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      {runError && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 ring-1 ring-[var(--color-danger)]/30">
          <div className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">
            {runError}
          </div>
          <button
            onClick={() => setRunError(null)}
            aria-label="Dismiss"
            className="text-[var(--color-danger)]/70 hover:text-[var(--color-danger)]"
          >
            x
          </button>
        </div>
      )}

      <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-[13px] font-medium text-[var(--color-text)]">
            Installed
          </h2>
          <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
            {filtered.length} of {state.installedAgents.length} shown
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <IconSearch
              size={14}
              aria-hidden="true"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <label htmlFor="installed-agents-search" className="sr-only">
              Search installed agents
            </label>
            <input
              id="installed-agents-search"
              name="installed-agents-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search installed agents"
              autoComplete="off"
              className="h-9 w-[260px] rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-[var(--color-accent)]/50"
            />
          </div>
          <Button
            variant="secondary"
            leadingIcon={<IconHub size={14} />}
            onClick={() => navigate("/agents/hub")}
          >
            Browse hub
          </Button>
          <Button
            variant="primary"
            leadingIcon={<IconPlus size={14} />}
            onClick={() => setNewAgentOpen(true)}
          >
            Build your own Agent
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState hasAgents={state.installedAgents.length > 0} />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onRun={(selected) => {
                if (
                  !requireTenantAndProvider(
                    createPendingIntent({
                      kind: "agent-run",
                      slug: selected.slug,
                      returnTo: `/agents/${encodeURIComponent(selected.slug)}`,
                    }),
                  )
                ) {
                  return;
                }
                if (selected.mode === "write") {
                  navigate(`/agents/${selected.slug}/confirm`);
                  return;
                }

                void handleStartRun(selected.slug);
              }}
            />
          ))}
        </div>
      )}

      <NewAgentModal
        open={newAgentOpen}
        onClose={() => setNewAgentOpen(false)}
      />
    </>
  );
}

function EmptyState({ hasAgents }: { hasAgents: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--color-surface)] py-16 ring-1 ring-[var(--color-border-soft)]">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <IconSearch size={20} />
      </div>
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        {hasAgents ? "No agents match that search" : "No agents installed"}
      </div>
      <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
        {hasAgents
          ? "Try a different query, or browse the hub for community agents."
          : "Add an agent from the hub once registry support is wired."}
      </div>
    </div>
  );
}

function toDisplayAgent(
  agent: AgentSummary,
  runs: { agentSlug: string; queuedAt: string }[],
  defaultModel?: string,
): AgentDisplay {
  const lastRunAt = runs.find((run) => run.agentSlug === agent.slug)?.queuedAt;

  return {
    ...agent,
    category: agent.category,
    author: {
      name: agent.author.name,
      handle: agent.author.handle ?? "local",
      verified: agent.author.verified ?? false,
    },
    installed: true,
    lastRunAt,
    preferredModel: defaultModel,
  };
}
