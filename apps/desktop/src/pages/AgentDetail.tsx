import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Avatar } from "../components/Avatar";
import { ManifestPreview } from "../components/ManifestPreview";
import { ConfigureAgentModal } from "../components/ConfigureAgentModal";
import { ShareMenu } from "../components/ShareMenu";
import {
  IconArrowLeft,
  IconBadgeCheck,
  IconBolt,
  IconPlay,
  IconShield,
} from "../components/icons";
import { useAppState } from "../state";
import type { AgentManifestPreview, RunRecord } from "../shared/openAgents";

export default function AgentDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { state, startRun, updateAgentSettings } = useAppState();
  const agent = state.installedAgents.find((a) => a.slug === slug);
  const recentRuns = state.runs.filter((run) => run.agentSlug === slug).slice(0, 3);
  const [preview, setPreview] = useState<AgentManifestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [configureOpen, setConfigureOpen] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const api = window.openAgents;
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
                <Pill tone={preview.kind === "agent-template" ? "accent" : "default"}>
                  {preview.kind === "agent-template" ? "YAML template" : "Code-based"}
                </Pill>
              </>
            )}
          </span>
        }
        actions={
          <>
            <ShareMenu contextLabel="agent" />
            <Button
              variant="secondary"
              disabled={
                !preview ||
                preview.kind !== "agent-template" ||
                (preview.manifest.definition.settings ?? []).length === 0
              }
              onClick={() => setConfigureOpen(true)}
            >
              Configure
            </Button>
            <Button
              variant="primary"
              leadingIcon={<IconPlay size={12} />}
              onClick={() => {
                void startRun(agent.slug).then((run) => navigate(`/runs/${run.id}`));
              }}
            >
              Run agent
            </Button>
          </>
        }
      />
      <PageBody>
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
                          <div className="text-[13px] text-[var(--color-text)]">
                            {run.summary ?? run.status}
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
                <div className="mt-3">
                  <div className="text-[13px] font-medium text-[var(--color-text)]">
                    {agent.preferredModel ?? "Default"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                    Inherited from active provider
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Pill tone="success">Local</Pill>
                  <Pill>$0.00 / run</Pill>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </PageBody>
      {preview && preview.kind === "agent-template" && (
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
