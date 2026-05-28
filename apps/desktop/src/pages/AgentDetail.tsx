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
import { Modal, ModalHeader } from "../components/Modal";
import { ConfigureAgentModal } from "../components/ConfigureAgentModal";
import { RunWithMenu } from "../components/RunWithMenu";
import { ShareMenu } from "../components/ShareMenu";
import { useToast } from "../components/Toast";
import {
  IconArrowLeft,
  IconBadgeCheck,
  IconBolt,
  IconClock,
  IconConnectors,
  IconShield,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  AgentManifestPreview,
  AgentTeamsDelivery,
  ConnectorChannelRef,
  ConnectorSummary,
  ConnectorTeamRef,
  ProviderId,
  RequestedScope,
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
    updateAgentTeamsDelivery,
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
  const [requestedScopes, setRequestedScopes] = useState<RequestedScope[]>([]);
  const [pendingRunChoice, setPendingRunChoice] = useState<
    { providerId?: ProviderId; model?: string } | null
  >(null);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const pendingProviderId = pendingRunChoice?.providerId ?? state.activeProviderId;
  const pendingProvider = state.providers.find(
    (provider) => provider.id === pendingProviderId,
  );

  const queueRunPreflight = (choice?: { providerId?: ProviderId; model?: string }) => {
    setRunError(null);
    setPendingRunChoice(choice ?? {});
  };

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
      setPendingRunChoice(null);
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

  useEffect(() => {
    window.openAdminOS
      ?.getRequestedScopes()
      .then(setRequestedScopes)
      .catch(() => setRequestedScopes([]));
  }, []);

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
              leadingIcon={<IconClock size={12} />}
              onClick={() =>
                document
                  .getElementById("agent-schedule")
                  ?.scrollIntoView({ block: "center", behavior: "smooth" })
              }
            >
              Schedule
            </Button>
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
                queueRunPreflight(choice);
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
            <div id="agent-schedule" />
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

            <AgentTeamsDeliveryCard
              delivery={agent.delivery?.teams}
              onOpenConnectors={() => navigate("/connectors")}
              onChange={async (next) => {
                await updateAgentTeamsDelivery(agent.slug, next);
                toast.success(
                  next?.enabled ? "Teams delivery saved." : "Teams delivery disabled.",
                );
              }}
            />

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
      {agent && (
        <RunPreflightModal
          open={pendingRunChoice !== null}
          agent={agent}
          activeTenantName={activeTenant?.displayName}
          providerName={pendingProvider?.name ?? pendingProviderId}
          providerIsLocal={pendingProvider?.isLocal === true}
          requestedScopes={requestedScopes}
          model={
            pendingRunChoice?.model ??
            state.activeModelByProviderId?.[pendingProviderId] ??
            agent.preferredModel ??
            pendingProvider?.defaultModel
          }
          onClose={() => setPendingRunChoice(null)}
          onConfirm={() => {
            void handleStartRun(pendingRunChoice ?? undefined);
          }}
        />
      )}
    </>
  );
}

function AgentTeamsDeliveryCard({
  delivery,
  onChange,
  onOpenConnectors,
}: {
  delivery: AgentTeamsDelivery | undefined;
  onChange: (delivery: AgentTeamsDelivery | null) => Promise<void>;
  onOpenConnectors: () => void;
}) {
  const [summary, setSummary] = useState<ConnectorSummary | null>(null);
  const [teams, setTeams] = useState<ConnectorTeamRef[]>([]);
  const [channels, setChannels] = useState<ConnectorChannelRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(delivery?.enabled === true);
  const [useDefaultTarget, setUseDefaultTarget] = useState(
    delivery?.useDefaultTarget !== false,
  );
  const [teamId, setTeamId] = useState(delivery?.teamId ?? "");
  const [channelId, setChannelId] = useState(delivery?.channelId ?? "");
  const [includeManualRuns, setIncludeManualRuns] = useState(
    delivery?.includeManualRuns ?? true,
  );
  const [includeScheduledRuns, setIncludeScheduledRuns] = useState(
    delivery?.includeScheduledRuns ?? true,
  );
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(
    delivery?.notifyOnSuccess ?? true,
  );
  const [notifyOnFailure, setNotifyOnFailure] = useState(
    delivery?.notifyOnFailure ?? false,
  );
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(
    delivery?.notifyOnChangeOnly ?? false,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectors()
      .then((connectors) => {
        if (cancelled) return;
        setSummary(
          connectors.find((connector) => connector.descriptor.id === "teams") ?? null,
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (useDefaultTarget || !enabled || teams.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectorTeams("teams")
      .then((list) => {
        if (!cancelled) setTeams(list);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, teams.length, useDefaultTarget]);

  useEffect(() => {
    if (useDefaultTarget || !enabled || !teamId) {
      setChannels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.openAdminOS
      ?.listConnectorChannels("teams", teamId)
      .then((list) => {
        if (!cancelled) setChannels(list);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, teamId, useDefaultTarget]);

  const defaultTargetLabel =
    typeof summary?.config.defaultTeamName === "string" &&
    typeof summary?.config.defaultChannelName === "string"
      ? `${summary.config.defaultTeamName} → #${summary.config.defaultChannelName}`
      : "Connector default";
  const hasDefaultTarget =
    typeof summary?.config.defaultTeamId === "string" &&
    typeof summary?.config.defaultChannelId === "string";
  const connected = summary?.status === "connected";
  const canSave =
    !saving &&
    (!enabled ||
      (useDefaultTarget ? hasDefaultTarget : Boolean(teamId && channelId)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!enabled) {
        await onChange(null);
        return;
      }
      const selectedTeam = teams.find((team) => team.id === teamId);
      const selectedChannel = channels.find((channel) => channel.id === channelId);
      await onChange({
        enabled: true,
        useDefaultTarget,
        includeManualRuns,
        includeScheduledRuns,
        notifyOnSuccess,
        notifyOnFailure,
        notifyOnChangeOnly,
        ...(!useDefaultTarget
          ? {
              teamId,
              channelId,
              ...(selectedTeam ? { teamName: selectedTeam.displayName } : {}),
              ...(selectedChannel
                ? { channelName: selectedChannel.displayName }
                : {}),
            }
          : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Delivery</SectionLabel>
          <Pill tone={enabled ? "success" : "default"}>
            {enabled ? "Teams on" : "Manual only"}
          </Pill>
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
          <IconConnectors
            size={18}
            className={enabled ? "text-[var(--color-success)]" : "text-[var(--color-text-soft)]"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--color-text)]">
              Microsoft Teams
            </div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              Send terminal run reports to a Teams channel. Saved delivery
              rules post without another prompt.
            </div>
          </div>
        </div>

        {!connected && (
          <div className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            Connect and test Microsoft Teams before enabling delivery.
            <button
              type="button"
              className="ml-1 font-medium underline"
              onClick={onOpenConnectors}
            >
              Open Connectors
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Send to Teams"
            checked={enabled}
            onChange={setEnabled}
            disabled={!connected}
          />

          {enabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ChoiceButton
                  active={useDefaultTarget}
                  label="Default channel"
                  detail={defaultTargetLabel}
                  onClick={() => setUseDefaultTarget(true)}
                />
                <ChoiceButton
                  active={!useDefaultTarget}
                  label="Custom channel"
                  detail="Per-agent target"
                  onClick={() => setUseDefaultTarget(false)}
                />
              </div>

              {!useDefaultTarget && (
                <div className="grid gap-2">
                  <select
                    value={teamId}
                    onChange={(event) => {
                      setTeamId(event.target.value);
                      setChannelId("");
                    }}
                    className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-[12px] text-[var(--color-text)]"
                  >
                    <option value="">{loading ? "Loading teams…" : "Select team"}</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.displayName}
                      </option>
                    ))}
                  </select>
                  <select
                    value={channelId}
                    disabled={!teamId}
                    onChange={(event) => setChannelId(event.target.value)}
                    className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-[12px] text-[var(--color-text)] disabled:opacity-60"
                  >
                    <option value="">
                      {!teamId
                        ? "Pick a team first"
                        : loading
                          ? "Loading channels…"
                          : "Select channel"}
                    </option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid gap-2">
                <ToggleRow
                  label="Manual runs"
                  checked={includeManualRuns}
                  onChange={setIncludeManualRuns}
                />
                <ToggleRow
                  label="Scheduled runs"
                  checked={includeScheduledRuns}
                  onChange={setIncludeScheduledRuns}
                />
                <ToggleRow
                  label="Completed runs"
                  checked={notifyOnSuccess}
                  onChange={setNotifyOnSuccess}
                />
                <ToggleRow
                  label="Failed runs"
                  checked={notifyOnFailure}
                  onChange={setNotifyOnFailure}
                />
                <ToggleRow
                  label="Only when scheduled findings changed"
                  checked={notifyOnChangeOnly}
                  onChange={setNotifyOnChangeOnly}
                />
              </div>
            </>
          )}
        </div>

        {enabled && useDefaultTarget && !hasDefaultTarget && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[11.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            Set a default Teams channel on the Connectors page, or choose a
            custom channel for this agent.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 text-[11.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canSave}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "Saving…" : "Save delivery"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--color-text-soft)]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[var(--color-accent)] disabled:opacity-60"
      />
    </label>
  );
}

function ChoiceButton({
  active,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-left ring-1 transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-[var(--color-accent)]/30"
          : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)]"
      }`}
    >
      <div className="text-[12px] font-medium">{label}</div>
      <div className="mt-0.5 truncate text-[10.5px] opacity-75">{detail}</div>
    </button>
  );
}

function RunPreflightModal({
  open,
  agent,
  activeTenantName,
  providerName,
  providerIsLocal,
  requestedScopes,
  model,
  onClose,
  onConfirm,
}: {
  open: boolean;
  agent: { name: string; mode: "read" | "write"; scopes: string[]; schedule?: unknown };
  activeTenantName: string | undefined;
  providerName: string;
  providerIsLocal: boolean;
  requestedScopes: RequestedScope[];
  model: string | undefined;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const requestedScopeNames = new Set(requestedScopes.map((scope) => scope.name));
  const mayNeedConsent = agent.scopes.some((scope) => !requestedScopeNames.has(scope));
  const canStart = Boolean(activeTenantName);
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Review run"
        subtitle={agent.name}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        {!activeTenantName && (
          <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            Connect or select a Microsoft 365 tenant before starting this run.
            OpenAdminOS never runs an agent without an active tenant scope.
          </div>
        )}
        {!providerIsLocal && (
          <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            Hosted provider selected. Tenant prompts and agent context are sent
            through {providerName}'s local CLI and leave this device.
          </div>
        )}
        {mayNeedConsent && (
          <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            This agent declares scopes that may require Microsoft incremental
            consent the first time it runs for this tenant.
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <PreflightFact label="Tenant" value={activeTenantName ?? "No tenant selected"} />
          <PreflightFact
            label="Provider"
            value={`${providerName}${providerIsLocal ? " · local" : " · hosted"}`}
          />
          <PreflightFact label="Model" value={model ?? "Provider default"} />
          <PreflightFact
            label="Mode"
            value={agent.mode === "write" ? "Write with confirmation" : "Read-only"}
          />
        </div>
        <div className="rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            What happens
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            OpenAdminOS runs this agent against the active tenant and saves the
            result to local run history. {agent.mode === "write"
              ? "If the agent proposes changes, it will pause for a diff and typed confirmation before anything is applied."
              : "This agent cannot change tenant state."}
          </p>
        </div>
        {agent.scopes.length > 0 && (
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Graph scopes
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {agent.scopes.map((scope) => (
                <Pill key={scope}>
                  <span className="font-mono text-[10.5px]">
                    {scopeLabel(scope, requestedScopes)}
                  </span>
                </Pill>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canStart} onClick={onConfirm}>
            Start run
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function scopeLabel(scope: string, requestedScopes: RequestedScope[]): string {
  const requested = requestedScopes.find((entry) => entry.name === scope);
  if (requested) return `${scope} · ${requested.mode}`;
  const known = GRAPH_SCOPE_LABELS[scope];
  return known ? `${scope} · ${known}` : scope;
}

const GRAPH_SCOPE_LABELS: Record<string, string> = {
  "Application.Read.All": "Read applications",
  "AuditLog.Read.All": "Read audit logs",
  "Device.Read.All": "Read devices",
  "DeviceManagementManagedDevices.Read.All": "Read Intune devices",
  "DeviceManagementManagedDevices.PrivilegedOperations.All": "Privileged Intune device actions",
  "Directory.Read.All": "Read directory",
  "Group.Read.All": "Read groups",
  "IdentityRiskyUser.Read.All": "Read risky users",
  "Organization.Read.All": "Read organization",
  "Policy.Read.All": "Read policies",
  "SecurityEvents.Read.All": "Read security events",
  "User.Read.All": "Read users",
  "User.ReadWrite.All": "Read and write users",
};

function PreflightFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate text-[13px] text-[var(--color-text)]">
        {value}
      </div>
    </div>
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
