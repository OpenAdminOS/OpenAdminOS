import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import {
  IconActivity,
  IconArrowRight,
  IconBolt,
  IconChat,
  IconCheck,
  IconHardDrive,
  IconHub,
  IconPlay,
  IconSettings,
  IconShield,
  IconTrend,
} from "../components/icons";
import {
  deriveTrustState,
  resolveProviderDefaultModel,
  type AgentSummary,
  type IntuneChatMessage,
  type OpenAdminOSApi,
  type RunRecord,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

export default function Home() {
  const navigate = useNavigate();
  const { state, registryAgents, startRun, installAgent, loading } = useAppState();
  const [runError, setRunError] = useState<string | null>(null);
  const [quickAsk, setQuickAsk] = useState("");
  const [hasAnsweredChat, setHasAnsweredChat] = useState(false);
  const [chatActivityLoaded, setChatActivityLoaded] = useState(false);
  const offboardingAgentId = "offboarding-agent";
  const offboardingInstalled = state.installedAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );
  const offboardingAvailable = registryAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const activeModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const activeTrust = deriveTrustState({
    provider: activeProvider,
    activeTenant,
    model: activeModel,
  });
  const runsThisWeek = countRecentRuns(state.runs.map((run) => run.queuedAt), 7);
  const completedRuns = state.runs.filter((run) => run.status === "completed").length;
  const hasCompletedRun = completedRuns > 0;
  const providerLabel = activeTrust.label;
  const visibleAgents = state.installedAgents.slice(0, 4);
  const firstReadOnlyAgent = state.installedAgents.find((agent) => agent.mode === "read");
  const providerConnected = activeProvider?.status === "connected";
  const providerName = activeProvider?.name ?? state.activeProviderId;
  const firstRunGateLoaded = !loading && (hasCompletedRun || chatActivityLoaded);
  const hasFirstSuccess = hasCompletedRun || hasAnsweredChat;

  useEffect(() => {
    let cancelled = false;

    if (loading) {
      setChatActivityLoaded(false);
      setHasAnsweredChat(false);
      return () => {
        cancelled = true;
      };
    }

    if (hasCompletedRun) {
      setChatActivityLoaded(true);
      setHasAnsweredChat(false);
      return () => {
        cancelled = true;
      };
    }

    const api = window.openAdminOS;
    if (!api) {
      setChatActivityLoaded(true);
      setHasAnsweredChat(false);
      return () => {
        cancelled = true;
      };
    }

    setChatActivityLoaded(false);
    void hasReceivedChatAnswer(api)
      .then((answered) => {
        if (cancelled) return;
        setHasAnsweredChat(answered);
        setChatActivityLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setHasAnsweredChat(false);
        setChatActivityLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [hasCompletedRun, loading]);

  const handleStartRun = async (agent: AgentSummary) => {
    setRunError(null);
    if (agent.mode === "write") {
      navigate(`/agents/${agent.slug}/confirm`);
      return;
    }

    try {
      const run = await startRun(agent.slug);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleQuickAsk = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const initialQuestion = quickAsk.trim();
    if (!initialQuestion) return;
    navigate("/chat", { state: { initialQuestion } });
  };

  const handleTryWriteAgent = async () => {
    setRunError(null);
    try {
      if (!offboardingInstalled) {
        if (!offboardingAvailable) return;
        await installAgent(offboardingAgentId);
      }
      const run = await startRun(offboardingAgentId);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{activeTenant?.displayName ?? "No active tenant"}</span>
            <span className="opacity-50">·</span>
            <Pill tone={activeTrust.isLocal ? "success" : "warning"}>
              <IconHardDrive size={10} /> {providerLabel}
            </Pill>
          </span>
        }
      />
      <PageBody>
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
              ×
            </button>
          </div>
        )}

        {!firstRunGateLoaded ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <HomeLoadingCard />
            <aside>
              <TrustCard activeTrust={activeTrust} onReviewProviders={() => navigate("/settings")} />
            </aside>
          </div>
        ) : !hasFirstSuccess ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="flex flex-col gap-6">
              <FirstRunChecklist
                tenantName={activeTenant?.displayName ?? "No active tenant"}
                providerConnected={providerConnected}
                providerSummary={`${providerName} · ${activeModel ?? "default model"}`}
                quickAsk={quickAsk}
                suggestedAgent={firstReadOnlyAgent}
                onQuickAskChange={setQuickAsk}
                onQuickAsk={handleQuickAsk}
                onReviewProviders={() => navigate("/settings")}
                onRunSuggestedAgent={(agent) => void handleStartRun(agent)}
              />
              <YourAgentsCard
                installedCount={state.installedAgents.length}
                visibleAgents={visibleAgents}
                onAllAgents={() => navigate("/agents")}
                onBrowseHub={() => navigate("/agents/hub")}
                onOpenAgent={(agent) => navigate(`/agents/${agent.slug}`)}
                onRunAgent={(agent) => void handleStartRun(agent)}
              />
            </section>
            <aside>
              <TrustCard activeTrust={activeTrust} onReviewProviders={() => navigate("/settings")} />
            </aside>
          </div>
        ) : (
          <>
            <div className="mb-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatTile
                label="Runs this week"
                value={String(runsThisWeek)}
                change="from local run history"
                icon={<IconActivity size={14} className="text-[var(--color-accent)]" />}
                mono
              />
              <StatTile
                label="Items resolved"
                value={String(completedRuns)}
                change="completed runs"
                icon={<IconTrend size={14} className="text-[var(--color-info)]" />}
                mono
              />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section>
                <YourAgentsCard
                  installedCount={state.installedAgents.length}
                  visibleAgents={visibleAgents}
                  onAllAgents={() => navigate("/agents")}
                  onBrowseHub={() => navigate("/agents/hub")}
                  onOpenAgent={(agent) => navigate(`/agents/${agent.slug}`)}
                  onRunAgent={(agent) => void handleStartRun(agent)}
                />
              </section>

              <aside className="flex flex-col gap-4">
                <RecentRunsCard
                  runs={state.runs}
                  onOpenRun={(run) => navigate(`/runs/${run.id}`)}
                  onViewAll={() => navigate("/activity")}
                />
                <TrustCard activeTrust={activeTrust} onReviewProviders={() => navigate("/settings")} />
                <TryWriteAgentCard
                  offboardingAvailable={offboardingAvailable}
                  offboardingInstalled={offboardingInstalled}
                  onTryWriteAgent={() => void handleTryWriteAgent()}
                />
              </aside>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

function FirstRunChecklist({
  tenantName,
  providerConnected,
  providerSummary,
  quickAsk,
  suggestedAgent,
  onQuickAskChange,
  onQuickAsk,
  onReviewProviders,
  onRunSuggestedAgent,
}: {
  tenantName: string;
  providerConnected: boolean;
  providerSummary: string;
  quickAsk: string;
  suggestedAgent?: AgentSummary;
  onQuickAskChange: (value: string) => void;
  onQuickAsk: (event: FormEvent<HTMLFormElement>) => void;
  onReviewProviders: () => void;
  onRunSuggestedAgent: (agent: AgentSummary) => void;
}) {
  return (
    <Card className="bg-[var(--color-bg-raised)] ring-[var(--color-border)]">
      <div className="p-5 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              First-run checklist
            </div>
            <h2 className="mt-2 text-[18px] font-semibold tracking-tight text-[var(--color-text)]">
              Start with one result
            </h2>
            <p className="mt-2 max-w-[620px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              One completed chat answer or read-only run is enough.
            </p>
          </div>
          <Pill tone="accent">
            <IconChat size={11} /> First result
          </Pill>
        </div>

        <div className="mt-6 divide-y divide-[var(--color-border-soft)] rounded-lg bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]">
          <ChecklistRow
            checked
            title="Tenant connected"
            detail={tenantName}
            badge={<Pill tone="success"><IconCheck size={11} /> Connected</Pill>}
          />
          <ChecklistRow
            checked={providerConnected}
            title="Local model active"
            detail={providerConnected ? providerSummary : "Provider is not connected."}
            badge={
              providerConnected ? (
                <Pill tone="success"><IconCheck size={11} /> Connected</Pill>
              ) : (
                <Pill tone="warning">Not connected</Pill>
              )
            }
            action={
              providerConnected ? undefined : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<IconSettings size={12} />}
                  trailingIcon={<IconArrowRight size={12} />}
                  onClick={onReviewProviders}
                >
                  Review providers
                </Button>
              )
            }
          />
          <div className="p-4 md:p-5">
            <div className="flex items-start gap-3">
              <StatusDot tone="info" className="mt-2" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--color-text)]">
                      Ask your first question
                    </div>
                    <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                      Chat creates the first result fastest.
                    </div>
                  </div>
                  <Pill tone="info">Next</Pill>
                </div>
                <form onSubmit={onQuickAsk} className="mt-4">
                  <label htmlFor="home-first-question" className="sr-only">
                    Ask your first question
                  </label>
                  <div className="flex flex-col gap-2 rounded-lg bg-[var(--color-bg)] p-2 ring-1 ring-[var(--color-border)] focus-within:ring-[var(--color-accent)] sm:flex-row">
                    <input
                      id="home-first-question"
                      value={quickAsk}
                      onChange={(event) => onQuickAskChange(event.target.value)}
                      placeholder="Ask about devices, users, policies, or sign-ins"
                      className="min-h-9 flex-1 bg-transparent px-2 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={quickAsk.trim().length === 0}
                      trailingIcon={<IconArrowRight size={12} />}
                    >
                      Ask
                    </Button>
                  </div>
                </form>
                {suggestedAgent && (
                  <button
                    type="button"
                    onClick={() => onRunSuggestedAgent(suggestedAgent)}
                    className="mt-3 inline-flex items-center gap-2 text-[12px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                  >
                    <IconPlay size={12} />
                    or run {suggestedAgent.name}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ChecklistRow({
  checked,
  title,
  detail,
  badge,
  action,
}: {
  checked: boolean;
  title: string;
  detail: string;
  badge: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <StatusDot tone={checked ? "success" : "muted"} className="mt-2" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-[var(--color-text)]">
              {title}
            </span>
            {badge}
          </div>
          <div className="mt-1 truncate text-[12px] text-[var(--color-text-muted)]">
            {detail}
          </div>
        </div>
      </div>
      {action}
    </div>
  );
}

function HomeLoadingCard() {
  return (
    <Card>
      <div className="flex items-center gap-3 p-5">
        <StatusDot tone="info" />
        <div>
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            Loading local history
          </div>
          <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Home will show the right starting point after local state is ready.
          </div>
        </div>
      </div>
    </Card>
  );
}

function YourAgentsCard({
  installedCount,
  visibleAgents,
  onAllAgents,
  onBrowseHub,
  onOpenAgent,
  onRunAgent,
}: {
  installedCount: number;
  visibleAgents: AgentSummary[];
  onAllAgents: () => void;
  onBrowseHub: () => void;
  onOpenAgent: (agent: AgentSummary) => void;
  onRunAgent: (agent: AgentSummary) => void;
}) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-medium text-[var(--color-text)]">
              Your agents
            </h2>
            <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
              {installedCount} installed
            </p>
          </div>
          <button
            onClick={onAllAgents}
            className="text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            All agents →
          </button>
        </div>

        {visibleAgents.length === 0 ? (
          <div className="mt-4 rounded-lg bg-[var(--color-bg-raised)] p-4 text-[12.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            No agents installed. Browse the hub to add one.
          </div>
        ) : (
          <div className="mt-4 divide-y divide-[var(--color-border-soft)]">
            {visibleAgents.map((agent) => (
              <AgentRow
                key={agent.slug}
                agent={agent}
                onOpen={() => onOpenAgent(agent)}
                onRun={() => onRunAgent(agent)}
              />
            ))}
          </div>
        )}

        {visibleAgents.length === 0 && (
          <Button
            variant="secondary"
            leadingIcon={<IconHub size={14} />}
            className="mt-4"
            onClick={onBrowseHub}
          >
            Browse hub
          </Button>
        )}
      </div>
    </Card>
  );
}

function RecentRunsCard({
  runs,
  onOpenRun,
  onViewAll,
}: {
  runs: RunRecord[];
  onOpenRun: (run: RunRecord) => void;
  onViewAll: () => void;
}) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Recent runs
          </div>
          <button
            onClick={onViewAll}
            className="text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            View all
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-2.5">
          {runs.length === 0 && (
            <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
              No runs recorded yet.
            </div>
          )}
          {runs.slice(0, 4).map((run) => (
            <button
              key={run.id}
              onClick={() => onOpenRun(run)}
              className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-raised)] p-3 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <StatusDot tone={runStatusTone(run.status)} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                  {run.agentSlug}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                  {run.summary ?? run.status}
                </div>
              </div>
              <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
                {formatShortDate(run.queuedAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function TrustCard({
  activeTrust,
  onReviewProviders,
}: {
  activeTrust: ReturnType<typeof deriveTrustState>;
  onReviewProviders: () => void;
}) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center gap-2">
          <IconShield size={14} className="text-[var(--color-success)]" />
          <span className="text-[12.5px] font-medium text-[var(--color-text)]">
            {activeTrust.label}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
          {activeTrust.detail}
        </p>
        <button
          onClick={onReviewProviders}
          className="mt-3 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
        >
          Review providers →
        </button>
      </div>
    </Card>
  );
}

function TryWriteAgentCard({
  offboardingAvailable,
  offboardingInstalled,
  onTryWriteAgent,
}: {
  offboardingAvailable: boolean;
  offboardingInstalled: boolean;
  onTryWriteAgent: () => void;
}) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center gap-2">
          <IconBolt size={14} className="text-[var(--color-warning)]" />
          <span className="text-[12.5px] font-medium text-[var(--color-text)]">
            Try a write agent
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
          Pair "Find inactive devices" with the "Offboarding agent" to see the diff
          confirmation flow.
        </p>
        <button
          onClick={onTryWriteAgent}
          disabled={!offboardingAvailable}
          className="mt-3 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {offboardingInstalled ? "Run offboarding" : "Add + run offboarding"} →
        </button>
      </div>
    </Card>
  );
}

function AgentRow({
  agent,
  onOpen,
  onRun,
}: {
  agent: AgentSummary;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
      <button onClick={onOpen} className="min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]">
            {agent.name}
          </span>
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read-only"}
          </Pill>
        </div>
        <p className="mt-1 line-clamp-1 text-[12px] text-[var(--color-text-muted)]">
          {agent.description}
        </p>
      </button>
      <Button variant="secondary" size="sm" onClick={onRun}>
        Run
      </Button>
    </div>
  );
}

function StatTile({
  label,
  value,
  change,
  icon,
  mono = false,
  valueClass = "text-[var(--color-text)]",
}: {
  label: string;
  value: string;
  change: string;
  icon: ReactNode;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </span>
          {icon}
        </div>
        <div
          className={`mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums ${valueClass} ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </div>
        <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          {change}
        </div>
      </div>
    </Card>
  );
}

function countRecentRuns(startedAtValues: string[], days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  return startedAtValues.filter((value) => {
    const timestamp = new Date(value).getTime();
    return !Number.isNaN(timestamp) && timestamp >= cutoff;
  }).length;
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function runStatusTone(status: RunRecord["status"]) {
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running" || status === "awaiting-confirmation") {
    return "warning";
  }
  return "success";
}

async function hasReceivedChatAnswer(api: OpenAdminOSApi) {
  const conversations = await api.listIntuneChatConversations();
  for (const conversation of conversations) {
    const messages = await api.getIntuneChatMessages(conversation.id);
    // Conversation timestamps can move for rename, pin, failed, or stopped flows.
    // A completed assistant message is the persisted signal that an answer was received.
    if (messages.some(isCompletedAssistantAnswer)) return true;
  }
  return false;
}

function isCompletedAssistantAnswer(message: IntuneChatMessage) {
  return (
    message.role === "assistant" &&
    message.status === "completed" &&
    message.content.trim().length > 0
  );
}
