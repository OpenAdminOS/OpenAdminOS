import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  CapabilityDescriptor,
  CapabilityKind,
  ConnectorChannelRef,
  ConnectorSummary,
  ConnectorTeamRef,
} from "@openagents/agent-sdk";

import { PageBody, PageHeader } from "../components/AppShell";
import {
  JiraLogo,
  OutlookLogo,
  ServiceNowLogo,
  SharePointLogo,
  SlackLogo,
  TeamsLogo,
  WebhookLogo,
} from "../components/BrandIcons";

type BrandIcon = (props: { size?: number }) => ReactElement;

export default function Connectors() {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [testing, setTesting] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const api = window.openAgents;
    if (!api) return;
    try {
      const summaries = await api.listConnectors();
      setConnectors(summaries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleTest = useCallback(
    async (id: string) => {
      const api = window.openAgents;
      if (!api) return;
      setTesting(id);
      setError(undefined);
      try {
        await api.testConnector(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTesting(undefined);
      }
    },
    [refresh],
  );

  const teamsSummary = connectors?.find(
    (c) => c.descriptor.id === "teams",
  );

  return (
    <>
      <PageHeader
        eyebrow="Connectors"
        title="Push agent results where your team works"
        subtitle="Connectors are pluggable egress integrations. Agents declare what they need; the runtime handles consent, audit, and the preview-and-send gate. Built on a versioned capability contract so connectors and agents can evolve independently."
      />
      <PageBody>
        {error && (
          <div className="mb-5 rounded-lg border border-[var(--color-danger-soft)] bg-[var(--color-danger-soft)]/30 px-3 py-2 text-[12.5px] text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {!connectors ? (
          <div className="text-[13px] text-[var(--color-text-muted)]">
            Loading…
          </div>
        ) : teamsSummary ? (
          <FeaturedTeamsCard
            summary={teamsSummary}
            busy={testing === "teams"}
            onTest={() => handleTest("teams")}
          />
        ) : null}

        <SectionHeader title="On the roadmap" tone="muted" />
        <p className="-mt-1 mb-4 text-[12.5px] text-[var(--color-text-soft)]">
          Each of these slots into the same contract: capability-versioned, audit-logged,
          and gated by the same preview-and-send confirmation as Teams. Star the project on
          GitHub if you'd like a specific one prioritised.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roadmap.map((c) => (
            <RoadmapCard key={c.id} entry={c} />
          ))}
        </div>

        <div className="mt-10 flex items-center justify-between rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-5 py-4">
          <div>
            <h3 className="text-[13px] font-semibold text-[var(--color-text)]">
              Have a connector idea?
            </h3>
            <p className="mt-0.5 text-[12px] text-[var(--color-text-soft)]">
              Open a GitHub discussion. The contract is documented in
              <code className="ml-1 rounded bg-[var(--color-bg-raised)] px-1 py-0.5 font-mono text-[11px]">
                docs/SPEC.md §2
              </code>{" "}
              — anyone can author one.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              void window.openAgents?.openExternal(
                "https://github.com/ugurlabs/openagents/issues/new?labels=connector",
              )
            }
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-raised)]"
          >
            Suggest a connector
          </button>
        </div>
      </PageBody>
    </>
  );
}

// ─── Featured Teams card ──────────────────────────────────────────────────

function FeaturedTeamsCard({
  summary,
  busy,
  onTest,
}: {
  summary: ConnectorSummary;
  busy: boolean;
  onTest: () => void;
}) {
  const descriptor = summary.descriptor;
  const isConnected = summary.status === "connected";

  return (
    <article className="overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-surface)]/40">
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1.4fr_1fr]">
        {/* Left: identity + capabilities */}
        <div className="border-b border-[var(--color-border-soft)] p-6 lg:border-b-0 lg:border-r">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 ring-1 ring-[var(--color-border-soft)]">
              <TeamsLogo size={36} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[17px] font-semibold text-[var(--color-text)]">
                  {descriptor.name}
                </h2>
                <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                  v{descriptor.version}
                </span>
                <Tag tone="neutral">Graph delegated</Tag>
                <Tag tone="success">Available now</Tag>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
                Posts channel messages and chat messages as the signed-in admin
                via Microsoft Graph. Tenant data never leaves your boundary;
                consent is incremental — Teams scopes are only requested the
                first time you opt in.
              </p>
            </div>
            <StatusPill summary={summary} />
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <SectionLabel>Capabilities</SectionLabel>
              <ul className="mt-1.5 space-y-1.5">
                {descriptor.capabilities.map((cap) => (
                  <CapabilityRow key={cap.id} capability={cap} />
                ))}
              </ul>
            </div>
            <div>
              <SectionLabel>Microsoft Graph scopes</SectionLabel>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-[var(--color-text-soft)]">
                {descriptor.scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
              <p className="mt-2 text-[10.5px] text-[var(--color-text-muted)]">
                Requested at first use, never up-front. Users who don't
                use Teams never grant these scopes.
              </p>
            </div>
          </div>
        </div>

        {/* Right: configure / test */}
        <div className="p-6">
          <SectionLabel>Default channel for posts</SectionLabel>
          {isConnected ? (
            <TeamsDefaultsPicker summary={summary} />
          ) : (
            <div className="mt-2 rounded-lg border border-dashed border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/40 p-4">
              <p className="text-[12.5px] text-[var(--color-text-soft)]">
                Connect Microsoft Teams to pick a default team and channel.
              </p>
              <p className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                Agents that declare the Teams connector will fail preflight
                until this is configured.
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border-soft)] pt-4">
            <div className="text-[11.5px] text-[var(--color-text-muted)]">
              {summary.lastTestedAt ? (
                <>
                  Last tested {formatRelative(summary.lastTestedAt)}
                  {summary.lastTestMessage ? ` — ${summary.lastTestMessage}` : ""}
                </>
              ) : (
                "Not tested yet. First test triggers Microsoft sign-in."
              )}
            </div>
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-on-accent)] disabled:opacity-60"
            >
              {busy ? "Testing…" : isConnected ? "Re-test" : "Test connection"}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── Roadmap cards ────────────────────────────────────────────────────────

interface RoadmapEntry {
  id: string;
  name: string;
  category: string;
  authSource: "graph-delegated" | "external" | "webhook";
  description: string;
  Icon: BrandIcon;
  status: "designed" | "planned" | "considering";
}

const roadmap: RoadmapEntry[] = [
  {
    id: "servicenow",
    name: "ServiceNow",
    category: "Ticketing",
    authSource: "external",
    description:
      "Create and update incidents from agent findings. Stale-device reports become tracked tickets routed to the right assignment group.",
    Icon: ServiceNowLogo,
    status: "designed",
  },
  {
    id: "outlook",
    name: "Microsoft Outlook",
    category: "Email",
    authSource: "graph-delegated",
    description:
      "Send run summaries as email. Same MSAL flow as Teams; no new credentials to store.",
    Icon: OutlookLogo,
    status: "planned",
  },
  {
    id: "jira",
    name: "Jira",
    category: "Ticketing",
    authSource: "external",
    description:
      "File issues against a project board with structured fields populated from the agent's structured output.",
    Icon: JiraLogo,
    status: "planned",
  },
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    authSource: "external",
    description:
      "Webhook or app-token posts to a channel. Useful for orgs whose IT comms live in Slack rather than Teams.",
    Icon: SlackLogo,
    status: "planned",
  },
  {
    id: "sharepoint",
    name: "SharePoint",
    category: "Documents",
    authSource: "graph-delegated",
    description:
      "Drop generated reports as documents in a site library. Run outputs become a permanent compliance trail.",
    Icon: SharePointLogo,
    status: "considering",
  },
  {
    id: "webhook",
    name: "Generic webhook",
    category: "Custom",
    authSource: "webhook",
    description:
      "POST run results to any HTTPS endpoint. Escape hatch for tools that don't have a first-class connector yet.",
    Icon: WebhookLogo,
    status: "considering",
  },
];

function RoadmapCard({ entry }: { entry: RoadmapEntry }) {
  const statusLabel: Record<RoadmapEntry["status"], string> = {
    designed: "Designed",
    planned: "Planned",
    considering: "Considering",
  };
  const authLabel: Record<RoadmapEntry["authSource"], string> = {
    "graph-delegated": "Graph delegated",
    external: "External auth",
    webhook: "Webhook",
  };
  const { Icon } = entry;
  return (
    <article className="group flex flex-col rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)]/40 p-4 transition-opacity">
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] p-1.5 ring-1 ring-[var(--color-border-soft)]"
          // Desaturate the brand icon so the roadmap row reads as
          // "not available yet" at a glance. Hovering nudges the
          // grayscale off slightly to hint at the underlying brand
          // without making the card look interactive.
          style={{
            filter: "grayscale(1)",
            opacity: 0.55,
          }}
        >
          <Icon size={26} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[13.5px] font-semibold text-[var(--color-text-soft)]">
              {entry.name}
            </h3>
            <Tag tone="muted">{entry.category}</Tag>
          </div>
          <p className="mt-0.5 text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)]">
            {authLabel[entry.authSource]}
          </p>
        </div>
        <Tag tone="warning">{statusLabel[entry.status]}</Tag>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
        {entry.description}
      </p>
    </article>
  );
}

// ─── Teams defaults picker ────────────────────────────────────────────────

function TeamsDefaultsPicker({ summary }: { summary: ConnectorSummary }) {
  const initialTeamId =
    typeof summary.config.defaultTeamId === "string"
      ? summary.config.defaultTeamId
      : "";
  const initialChannelId =
    typeof summary.config.defaultChannelId === "string"
      ? summary.config.defaultChannelId
      : "";

  const [teams, setTeams] = useState<ConnectorTeamRef[] | undefined>(undefined);
  const [channels, setChannels] = useState<ConnectorChannelRef[] | undefined>(
    undefined,
  );
  const [teamId, setTeamId] = useState<string>(initialTeamId);
  const [channelId, setChannelId] = useState<string>(initialChannelId);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);

  useEffect(() => {
    const api = window.openAgents;
    if (!api) return;
    setLoadingTeams(true);
    setError(undefined);
    api
      .listConnectorTeams("teams")
      .then((list) => setTeams(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoadingTeams(false));
  }, []);

  useEffect(() => {
    const api = window.openAgents;
    if (!api || !teamId) {
      setChannels(undefined);
      return;
    }
    setLoadingChannels(true);
    setError(undefined);
    api
      .listConnectorChannels("teams", teamId)
      .then((list) => setChannels(list))
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoadingChannels(false));
  }, [teamId]);

  const handleSave = useCallback(async () => {
    const api = window.openAgents;
    if (!api) return;
    setSaving(true);
    setError(undefined);
    try {
      const teamName = teams?.find((t) => t.id === teamId)?.displayName;
      const channelName = channels?.find((c) => c.id === channelId)?.displayName;
      await api.setConnectorConfig("teams", {
        defaultTeamId: teamId,
        defaultChannelId: channelId,
        ...(teamName ? { defaultTeamName: teamName } : {}),
        ...(channelName ? { defaultChannelName: channelName } : {}),
      });
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [teamId, channelId, teams, channels]);

  const dirty = teamId !== initialTeamId || channelId !== initialChannelId;

  return (
    <div className="mt-2 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
          <span>Team</span>
          <select
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setChannelId("");
            }}
            disabled={loadingTeams}
            className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-[12.5px] text-[var(--color-text)]"
          >
            <option value="">
              {loadingTeams ? "Loading…" : "Select a team"}
            </option>
            {teams?.map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
          <span>Channel</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={!teamId || loadingChannels}
            className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-1.5 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
          >
            <option value="">
              {!teamId
                ? "Pick a team first"
                : loadingChannels
                  ? "Loading…"
                  : "Select a channel"}
            </option>
            {channels?.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.displayName}
                {channel.membershipType && channel.membershipType !== "standard"
                  ? ` (${channel.membershipType})`
                  : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {savedAt
            ? `Saved ${formatRelative(savedAt)}`
            : initialTeamId && initialChannelId
              ? "Default channel set."
              : "No default channel saved yet."}
        </span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || !teamId || !channelId || saving}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-on-accent)] disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save default"}
        </button>
      </div>
    </div>
  );
}

// ─── Reusable primitives ──────────────────────────────────────────────────

function StatusPill({ summary }: { summary: ConnectorSummary }) {
  const { status } = summary;
  const map: Record<
    ConnectorSummary["status"],
    { label: string; tone: "ok" | "warn" | "err" | "neutral" }
  > = {
    connected: { label: "Connected", tone: "ok" },
    "needs-setup": { label: "Needs setup", tone: "warn" },
    "needs-scope": { label: "Needs consent", tone: "warn" },
    error: { label: "Error", tone: "err" },
    unknown: { label: "Untested", tone: "neutral" },
  };
  const entry = map[status];
  const classes =
    entry.tone === "ok"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : entry.tone === "warn"
        ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
        : entry.tone === "err"
          ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {entry.label}
    </span>
  );
}

function CapabilityRow({ capability }: { capability: CapabilityDescriptor }) {
  return (
    <li className="flex items-center justify-between gap-2 text-[12px]">
      <span className="font-mono text-[11px] text-[var(--color-text)]">
        {capability.id}@{capability.version}
      </span>
      <KindTag kind={capability.kind} />
    </li>
  );
}

function KindTag({ kind }: { kind: CapabilityKind }) {
  const styles: Record<CapabilityKind, string> = {
    read: "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]",
    notify: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
    mutating: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    destructive: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider ${styles[kind]}`}
    >
      {kind}
    </span>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "neutral" | "muted" | "success" | "warning";
}) {
  const styles: Record<typeof tone, string> = {
    neutral: "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)]",
    muted: "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]",
    success: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </h3>
  );
}

function SectionHeader({
  title,
  tone = "default",
}: {
  title: string;
  tone?: "default" | "muted";
}) {
  return (
    <div className="mt-8 mb-3 flex items-center gap-2">
      <h3
        className={`text-[12px] font-medium uppercase tracking-wider ${
          tone === "muted" ? "text-[var(--color-text-soft)]" : "text-[var(--color-text)]"
        }`}
      >
        {title}
      </h3>
      <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
