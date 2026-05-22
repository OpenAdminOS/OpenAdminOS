import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Avatar } from "../components/Avatar";
import { AgentScheduleCard } from "../components/AgentScheduleCard";
import { ManifestPreview } from "../components/ManifestPreview";
import { stripMarkdownToPlainText } from "../components/MarkdownPreview";
import { ConfigureAgentModal } from "../components/ConfigureAgentModal";
import { RunWithMenu } from "../components/RunWithMenu";
import { ShareMenu } from "../components/ShareMenu";
import { useToast } from "../components/Toast";
import {
  IconArrowLeft,
  IconBadgeCheck,
  IconBolt,
  IconShield,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  AgentManifestPreview,
  ProviderId,
  RunRecord,
} from "../shared/openAdminOS";

export default function AgentDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const {
    state,
    startRun,
    updateAgentSettings,
    uninstallAgent,
    updateAgent,
    updateAgentSchedule,
  } = useAppState();
  const toast = useToast();
  const agent = state.installedAgents.find((a) => a.slug === slug);
  const recentRuns = state.runs.filter((run) => run.agentSlug === slug).slice(0, 3);
  const [preview, setPreview] = useState<AgentManifestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const handleStartRun = async (choice?: { providerId?: ProviderId; model?: string }) => {
    if (!agent) return;
    setRunError(null);
    try {
      const options =
        choice && (choice.providerId || choice.model)
          ? {
              ...(choice.providerId ? { providerId: choice.providerId } : {}),
              ...(choice.model ? { model: choice.model } : {}),
            }
          : undefined;
      const run = await startRun(agent.slug, options);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const api = window.openAdminOS;
    if (!api) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    api
      .getAgentManifest(slug)
      .then((result) => {
        if (cancelled) return;
        setPreview(result ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!agent) {
    return (
      <PageBody>
        <div className="text-center text-[var(--color-text-muted)]">
          Agent not found.{" "}
          <button
            className="text-[var(--color-accent)] underline"
            onClick={() => navigate("/")}
          >
            Back to agents
          </button>
        </div>
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <button
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <IconArrowLeft size={12} /> Agents
          </button>
        }
        title={agent.name}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Avatar name={agent.author.name} size={16} />
            <span>{agent.author.name}</span>
            {agent.author.verified && (
              <IconBadgeCheck size={12} className="text-[var(--color-accent)]" />
            )}
            <span className="opacity-50">·</span>
            <span className="font-mono">v{agent.version}</span>
            <span className="opacity-50">·</span>
            <span className="capitalize">{agent.category}</span>
            {preview && (
              <>
                <span className="opacity-50">·</span>
                <Pill tone="accent">YAML template</Pill>
              </>
            )}
          </span>
        }
        actions={
          <>
            <ShareMenu
              contextLabel="agent"
              onCopyLink={() => {
                void navigator.clipboard.writeText(`openadminos://agent/${agent.slug}`);
              }}
              copyLinkHint={`openadminos://agent/${agent.slug}`}
              onOpenInBrowser={() => {
                void window.openAdminOS?.openExternal(
                  `https://github.com/OpenAdminOS/OpenAdminOS/tree/main/agents/${agent.slug}`,
                );
              }}
              openInBrowserHint={`github.com/OpenAdminOS/OpenAdminOS · agents/${agent.slug}`}
            />
            <Button
              variant="secondary"
              disabled={
                previewLoading ||
                !preview ||
                (preview.manifest.definition.settings ?? []).length === 0
              }
              onClick={() => setConfigureOpen(true)}
              title={
                previewLoading
                  ? "Loading manifest…"
                  : !preview
                    ? "Manifest unavailable"
                    : (preview.manifest.definition.settings ?? []).length === 0
                      ? "This agent declares no configurable settings"
                      : "Edit per-install settings"
              }
            >
              {previewLoading ? "Loading…" : "Configure"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const confirmed = window.confirm(
                  `Remove ${agent.name}? Run history is kept. User-authored agents are deleted from disk.`,
                );
                if (!confirmed) return;
                void uninstallAgent(agent.slug)
                  .then(() => {
                    toast.success(`${agent.name} uninstalled.`);
                    navigate("/");
                  })
                  .catch((error) => {
                    toast.error(
                      error instanceof Error ? error.message : String(error),
                    );
                  });
              }}
            >
              Uninstall
            </Button>
            <RunWithMenu
              providers={state.providers}
              activeProviderId={state.activeProviderId}
              activeModelByProviderId={state.activeModelByProviderId}
              onRun={(choice) => {
                void handleStartRun(choice);
              }}
            />
          </>
        }
      />
      <PageBody>
        {agent.updateAvailable && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-[var(--color-accent-soft)] px-4 py-3 ring-1 ring-[var(--color-accent)]/30">
            <div className="text-[12.5px] leading-relaxed text-[var(--color-text)]">
              <span className="font-medium">Update available.</span>{" "}
              <span className="font-mono">v{agent.version}</span>
              <span className="opacity-50"> → </span>
              <span className="font-mono">v{agent.updateAvailable.version}</span>
              <span className="opacity-70">
                {" "}
                — fetches the new manifest from GitHub and replaces this agent's local copy. Your settings and schedule are preserved.
              </span>
            </div>
            <Button
              variant="secondary"
              disabled={updating}
              onClick={() => {
                setUpdating(true);
                void updateAgent(agent.slug)
                  .then(() => {
                    toast.success(`${agent.name} updated.`);
                  })
                  .catch((error) => {
                    toast.error(
                      error instanceof Error ? error.message : String(error),
                    );
                  })
                  .finally(() => setUpdating(false));
              }}
            >
              {updating ? "Updating…" : "Update"}
            </Button>
          </div>
        )}
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
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <div className="p-6">
                <SectionLabel>About</SectionLabel>
                <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-text-soft)]">
                  {agent.description}
                </p>
                <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-text-soft)]">
                  This agent runs against your active tenant scope and
                  produces a structured report. The result is saved to your
                  local run history and never transmitted off-device when a
                  local LLM provider is selected.
                </p>
              </div>
            </Card>

            {previewLoading && (
              <Card>
                <div className="p-6 text-[13px] text-[var(--color-text-muted)]">
                  Loading manifest…
                </div>
              </Card>
            )}

            {previewError && (
              <Card>
                <div className="p-6 text-[13px] text-[var(--color-danger)]">
                  Couldn't load manifest: {previewError}
                </div>
              </Card>
            )}

            {!previewLoading && !previewError && preview && (
              <ManifestPreview
                preview={preview}
                settingsOverrides={agent.settings}
              />
            )}

            {!previewLoading && !preview && (
              <FallbackScopesCard scopes={agent.scopes} />
            )}

            <AgentScheduleCard
              schedule={agent.schedule}
              onChange={async (next) => {
                await updateAgentSchedule(agent.slug, next);
                toast.success(
                  next === null
                    ? "Schedule disabled."
                    : `Schedule saved · every ${Math.round(next.intervalSeconds / 60)}m.`,
                );
              }}
            />

            <Card>
              <div className="p-6">
                <SectionLabel>Recent runs</SectionLabel>
                <div className="mt-3 divide-y divide-[var(--color-border-soft)]">
                  {recentRuns.length === 0 ? (
                    <div className="py-3 text-[12px] text-[var(--color-text-muted)]">
                      No runs recorded for this agent yet.
                    </div>
                  ) : (
                    recentRuns.map((run) => (
                      <div
                        key={run.id}
                        className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                      >
                        <div>
                          <div className="text-[13px] text-[var(--color-text)] line-clamp-2">
                            {run.summary ? stripMarkdownToPlainText(run.summary) : run.status}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                            {formatDate(run.queuedAt)} · {formatDuration(run)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/runs/${run.id}`)}
                        >
                          View
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </Card>
          </div>

          {/* Sidebar column */}
          <div className="flex flex-col gap-6">
            <Card>
              <div className="p-5">
                <SectionLabel>Mode</SectionLabel>
                <div className="mt-3 flex items-center gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
                  {agent.mode === "write" ? (
                    <IconBolt
                      size={18}
                      className="text-[var(--color-warning)]"
                    />
                  ) : (
                    <IconShield
                      size={18}
                      className="text-[var(--color-text-soft)]"
                    />
                  )}
                  <div>
                    <div className="text-[13px] font-medium text-[var(--color-text)]">
                      {agent.mode === "write" ? "Write" : "Read-only"}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      {agent.mode === "write"
                        ? "Pauses for diff confirmation before any change."
                        : "Cannot mutate tenant state."}
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-5">
                <SectionLabel>Model</SectionLabel>
                <ModelCardBody
                  agent={agent}
                  providers={state.providers}
                  activeProviderId={state.activeProviderId}
                  activeModelByProviderId={state.activeModelByProviderId}
                />
              </div>
            </Card>
          </div>
        </div>
      </PageBody>
      {preview && (
        <ConfigureAgentModal
          open={configureOpen}
          onClose={() => setConfigureOpen(false)}
          agent={agent}
          manifest={preview.manifest}
          onSave={(values) => updateAgentSettings(agent.slug, values)}
        />
      )}
    </>
  );
}

function ModelCardBody({
  agent,
  providers,
  activeProviderId,
  activeModelByProviderId,
}: {
  agent: { preferredModel?: string };
  providers: { id: ProviderId; name: string; isLocal: boolean; models?: string[]; defaultModel?: string }[];
  activeProviderId: ProviderId;
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
}) {
  const provider = providers.find((p) => p.id === activeProviderId);
  const installed = provider?.models ?? [];
  const userPinned = activeModelByProviderId?.[activeProviderId];
  const preferred = agent.preferredModel;

  let resolved: string | undefined;
  let source: string;
  if (preferred && installed.includes(preferred)) {
    resolved = preferred;
    source = `Agent prefers this model (manifest)`;
  } else if (userPinned && installed.includes(userPinned)) {
    resolved = userPinned;
    source = `Your default for ${provider?.name ?? activeProviderId}`;
  } else if (provider?.defaultModel) {
    resolved = provider.defaultModel;
    source = `Provider default · ${provider.name}`;
  } else {
    resolved = undefined;
    source = "No model installed for the active provider";
  }

  const preferredButMissing =
    preferred && !installed.includes(preferred) && installed.length > 0;

  return (
    <>
      <div className="mt-3">
        <div className="font-mono text-[13px] font-medium text-[var(--color-text)]">
          {resolved ?? "—"}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          {source}
        </div>
      </div>
      {preferredButMissing && (
        <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 ring-1 ring-[var(--color-warning)]/30">
          <div className="text-[11px] leading-relaxed text-[var(--color-text-soft)]">
            <span className="font-medium text-[var(--color-text)]">
              {preferred}
            </span>{" "}
            is the agent's preferred model but isn't installed for{" "}
            {provider?.name ?? activeProviderId}. Pull it with{" "}
            <span className="font-mono">{`ollama pull ${preferred}`}</span> to
            match the author's intent.
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill tone={provider?.isLocal ? "success" : "warning"}>
          {provider?.isLocal ? "Local" : "Hosted"}
        </Pill>
      </div>
    </>
  );
}

function FallbackScopesCard({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return (
    <Card>
      <div className="p-6">
        <SectionLabel>Required Graph scopes</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {scopes.map((scope) => (
            <Pill key={scope}>
              <span className="font-mono text-[11px]">{scope}</span>
            </Pill>
          ))}
        </div>
      </div>
    </Card>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(run: RunRecord) {
  if (!run.startedAt || !run.finishedAt) return "-";
  const durationMs =
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (Number.isNaN(durationMs) || durationMs < 0) return "-";
  return `${(durationMs / 1000).toFixed(1)}s`;
}
