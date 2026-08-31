import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  CapabilityDescriptor,
  CapabilityKind,
  ConnectorChannelRef,
  ConnectorSummary,
  ConnectorTeamRef,
  WhatsAppWebGroupRef,
  WhatsAppWebRecipientType,
  WhatsAppWebStatus,
} from "@openadminos/agent-sdk";

import { PageBody, PageHeader } from "../components/AppShell";
import {
  JiraLogo,
  OutlookLogo,
  ServiceNowLogo,
  SharePointLogo,
  SlackLogo,
  TeamsLogo,
  WebhookLogo,
  WhatsAppLogo,
} from "../components/BrandIcons";
import { Button } from "../components/Button";
import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconConnectors,
  IconExternal,
  IconHash,
  IconRefresh,
  IconShield,
  IconUser,
  IconUsers,
  IconWarning,
} from "../components/icons";
import { extractWhatsAppRecipientInput } from "../shared/whatsappTarget";
import { Select } from "../components/Select";

type BrandIcon = (props: { size?: number }) => ReactElement;
type WhatsAppTargetDraft = {
  type: WhatsAppWebRecipientType;
  recipient: string;
  label: string;
};
type TeamsDefaultDraft = {
  teamId: string;
  channelId: string;
  teamName?: string;
  channelName?: string;
};

const notificationConnectorIds = ["outlook", "slack", "discord", "signal"] as const;

export default function Connectors() {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [testing, setTesting] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const api = window.openAdminOS;
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
      const api = window.openAdminOS;
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
  const whatsappSummary = connectors?.find(
    (c) => c.descriptor.id === "whatsapp-web",
  );
  const notificationSummaries = connectors
    ? notificationConnectorIds
        .map((id) => connectors.find((c) => c.descriptor.id === id))
        .filter(isConnectorSummary)
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Connectors"
        title="Connector routing"
        subtitle="Configure where terminal agent reports are posted. Saved delivery rules use these targets without another prompt, and every send is recorded in the run activity."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              trailingIcon={<IconExternal size={13} />}
              onClick={() =>
                void window.openAdminOS?.openExternal(
                  "https://docs.openadminos.com/connectors",
                )
              }
            >
              Setup guide
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<IconRefresh size={13} />}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          </div>
        }
      />
      <PageBody>
        {error && (
          <div className="mb-5">
            <ConnectorNotice tone="danger" title="Connector refresh failed" body={error} />
          </div>
        )}

        {!connectors ? (
          <ConnectorLoadingState />
        ) : (
          <div className="space-y-6">
            <ConnectorOperationsSummary connectors={connectors} />

            <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_340px]">
              <section className="space-y-4">
                <SectionHeader title="Live connectors" compact />
                {teamsSummary ? (
                  <FeaturedTeamsCard
                    summary={teamsSummary}
                    busy={testing === "teams"}
                    onTest={() => handleTest("teams")}
                  />
                ) : null}
                {whatsappSummary ? (
                  <WhatsAppWebCard summary={whatsappSummary} onRefresh={refresh} />
                ) : null}
                {notificationSummaries.length > 0 ? (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {notificationSummaries.map((summary) => (
                      <NotificationConnectorCard
                        key={summary.descriptor.id}
                        summary={summary}
                        busy={testing === summary.descriptor.id}
                        onRefresh={refresh}
                        onTest={() => handleTest(summary.descriptor.id)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>

              <ConnectorPolicyPanel />
            </div>

            <section>
              <ConnectorDetailsDisclosure
                title="Connector backlog"
                summary={`${roadmap.length} planned connector targets using the same delivery contract.`}
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {roadmap.map((c) => (
                    <RoadmapCard key={c.id} entry={c} />
                  ))}
                </div>
              </ConnectorDetailsDisclosure>
            </section>

            <ConnectorIdeaBar />
          </div>
        )}
      </PageBody>
    </>
  );
}

// ─── Page overview ────────────────────────────────────────────────────────

function ConnectorOperationsSummary({
  connectors,
}: {
  connectors: ConnectorSummary[];
}) {
  const available = connectors;
  const connected = connectors.filter((connector) => connector.status === "connected");
  const notifyCapabilities = connectors.reduce(
    (count, connector) =>
      count +
      connector.descriptor.capabilities.filter((capability) => capability.kind === "notify")
        .length,
    0,
  );

  return (
    <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
      <ConnectorStat
        icon={<IconConnectors size={15} />}
        label="Connectors"
        value={`${connected.length}/${available.length || connectors.length}`}
        detail="connected now"
      />
      <ConnectorStat
        icon={<IconShield size={15} />}
        label="Capabilities"
        value={String(notifyCapabilities)}
        detail="notification routes"
      />
      <div className="rounded-xl bg-[var(--color-surface)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Delivery model
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-text)]">
              {"Terminal run report -> local queue -> connector send -> activity log"}
            </p>
          </div>
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/20">
            <IconCheck size={15} />
          </span>
        </div>
      </div>
    </section>
  );
}

function ConnectorStat({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl bg-[var(--color-surface)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-[18px] font-semibold text-[var(--color-text)]">
              {value}
            </span>
            <span className="text-[12px] text-[var(--color-text-soft)]">{detail}</span>
          </div>
        </div>
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          {icon}
        </span>
      </div>
    </div>
  );
}

function ConnectorPolicyPanel() {
  return (
    <aside className="rounded-xl bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)] 2xl:sticky 2xl:top-0">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          <IconShield size={15} />
        </span>
        <div>
          <h2 className="text-[13px] font-semibold text-[var(--color-text)]">
            Routing flow
          </h2>
          <p className="text-[11.5px] text-[var(--color-text-muted)]">
            Defaults here, delivery rules on each agent.
          </p>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
        Use this page to connect services and set fallback targets. Pick success,
        failure, or all-run delivery on the agent page.
      </p>
      <div className="mt-4">
        <ConnectorDetailsDisclosure
          title="Rule details"
          summary="Queueing, automatic sends, and egress labels."
        >
          <div className="space-y-3">
            <PolicyRow
              icon={<IconCheck size={14} />}
              title="Saved delivery rules post automatically"
              body="Agent-level notification settings are the approval to send terminal reports."
            />
            <PolicyRow
              icon={<IconClock size={14} />}
              title="Delivery is queued locally"
              body="Transient connector failures retry from local state and appear in run activity."
            />
            <PolicyRow
              icon={<IconExternal size={14} />}
              title="External egress is labeled"
              body="WhatsApp delivery leaves Microsoft 365; Teams stays inside the tenant boundary."
            />
          </div>
        </ConnectorDetailsDisclosure>
      </div>
    </aside>
  );
}

function PolicyRow({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3 border-t border-[var(--color-border-soft)] pt-3 first:border-t-0 first:pt-0">
      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-raised)] text-[var(--color-text-soft)]">
        {icon}
      </span>
      <div>
        <p className="text-[12px] font-medium text-[var(--color-text)]">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
          {body}
        </p>
      </div>
    </div>
  );
}

function ConnectorLoadingState() {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="h-[86px] rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]"
        >
          <div className="h-full animate-pulse rounded-xl bg-[var(--color-bg-raised)]/35" />
        </div>
      ))}
    </div>
  );
}

function ConnectorNotice({
  tone,
  title,
  body,
}: {
  tone: "danger" | "warning";
  title: string;
  body: string;
}) {
  const styles =
    tone === "danger"
      ? "border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
      : "border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className={`flex gap-3 rounded-xl border px-3 py-2.5 ${styles}`}
    >
      <IconWarning size={15} className="mt-0.5 shrink-0" />
      <div>
        <p className="text-[12px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed opacity-90">{body}</p>
      </div>
    </div>
  );
}

function ConnectorIdeaBar() {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-[var(--color-surface)] px-5 py-4 ring-1 ring-[var(--color-border-soft)] sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--color-text)]">
          Need another connector?
        </h3>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-soft)]">
          Open a GitHub issue with the target system and the delivery use case.
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        trailingIcon={<IconExternal size={13} />}
        onClick={() =>
          void window.openAdminOS?.openExternal(
            "https://github.com/OpenAdminOS/OpenAdminOS/issues/new?labels=connector",
          )
        }
      >
        Suggest connector
      </Button>
    </div>
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
    <article className="overflow-hidden rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 ring-1 ring-[var(--color-border-soft)]">
              <TeamsLogo size={30} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-[var(--color-text)]">
                  {descriptor.name}
                </h2>
                <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                  v{descriptor.version}
                </span>
                <Tag tone="neutral">Graph delegated</Tag>
              </div>
              <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                Posts channel messages as the signed-in admin via Microsoft
                Graph. Data stays inside the tenant boundary.
              </p>
            </div>
            <StatusPill summary={summary} />
          </div>

          <div className="mt-4">
            <ConnectorDetailsDisclosure
              title="Permissions and capabilities"
              summary="Incremental Graph consent, channel-post capability, and required scopes."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <ConnectorInfoBlock title="Capabilities">
                  <ul className="space-y-1.5">
                    {descriptor.capabilities.map((cap) => (
                      <CapabilityRow key={cap.id} capability={cap} />
                    ))}
                  </ul>
                </ConnectorInfoBlock>
                <ConnectorInfoBlock title="Required Graph scopes">
                  <ul className="space-y-0.5 break-words font-mono text-[11px] text-[var(--color-text-soft)]">
                    {descriptor.scopes.map((scope) => (
                      <li key={scope}>{scope}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10.5px] text-[var(--color-text-muted)]">
                    Incremental consent. Admins who do not use Teams do not grant
                    these scopes.
                  </p>
                </ConnectorInfoBlock>
              </div>
            </ConnectorDetailsDisclosure>
          </div>
        </div>

        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/25 p-5 lg:border-t-0 lg:border-l">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SectionLabel>Default channel</SectionLabel>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Used by agents that post to the connector default.
              </p>
            </div>
            <Tag tone={isConnected ? "success" : "warning"}>
              {isConnected ? "Ready" : "Needs test"}
            </Tag>
          </div>
          {isConnected ? (
            <TeamsDefaultsPicker summary={summary} />
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface)]/55 p-4">
              <p className="text-[12.5px] text-[var(--color-text-soft)]">
                Test Microsoft Teams first, then pick the default team and channel.
              </p>
              <p className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                Agents that declare Teams fail preflight until the connector is
                configured.
              </p>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--color-border-soft)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-[11.5px] text-[var(--color-text-muted)]">
              {summary.lastTestedAt ? (
                <>
                  Last tested {formatRelative(summary.lastTestedAt)}
                  {summary.lastTestMessage ? ` - ${summary.lastTestMessage}` : ""}
                </>
              ) : (
                "Not tested yet. First test can trigger Microsoft sign-in."
              )}
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onTest}
              disabled={busy}
            >
              {busy ? "Testing…" : isConnected ? "Re-test" : "Test connection"}
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── WhatsApp Web card ───────────────────────────────────────────────────

function WhatsAppWebCard({
  summary,
  onRefresh,
}: {
  summary: ConnectorSummary;
  onRefresh: () => Promise<void>;
}) {
  const descriptor = summary.descriptor;
  const initialTarget = readWhatsAppTargetFromConfig(summary.config);
  const [status, setStatus] = useState<WhatsAppWebStatus | null>(null);
  const [targetType, setTargetType] = useState<WhatsAppWebRecipientType>(
    initialTarget.type,
  );
  const [recipient, setRecipient] = useState(initialTarget.recipient);
  const [recipientLabel, setRecipientLabel] = useState(initialTarget.label);
  const [groups, setGroups] = useState<WhatsAppWebGroupRef[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [linking, setLinking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const [sentAt, setSentAt] = useState<string | undefined>(undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastSavedTargetKey = useRef(
    initialTarget.recipient.trim().length > 0
      ? stableWhatsAppTargetKey(initialTarget)
      : undefined,
  );

  const loadStatus = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setLoadingStatus(true);
    try {
      setStatus(await api.getWhatsAppWebStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setLoadingGroups(true);
    setError(undefined);
    try {
      const list = await api.listWhatsAppWebGroups();
      setGroups(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingGroups(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status || !isWhatsAppPollingState(status.state)) return;
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [loadStatus, status]);

  useEffect(() => {
    if (!status?.qrRefreshesAt) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status?.qrRefreshesAt]);

  useEffect(() => {
    if (targetType !== "group" || status?.state !== "connected" || groups.length > 0) {
      return;
    }
    void loadGroups();
  }, [groups.length, loadGroups, status?.state, targetType]);

  const startLogin = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setLinking(true);
    setError(undefined);
    try {
      setStatus(await api.startWhatsAppWebLogin());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  }, [onRefresh]);

  const disconnect = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setDisconnecting(true);
    setError(undefined);
    try {
      setStatus(await api.disconnectWhatsAppWeb());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }, [onRefresh]);

  const sendTest = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setSending(true);
    setError(undefined);
    try {
      const target = buildWhatsAppTarget(targetType, recipient, recipientLabel, groups);
      await api.sendWhatsAppWebTestMessage(target.recipient);
      setSentAt(new Date().toISOString());
      setStatus(await api.getWhatsAppWebStatus());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [groups, onRefresh, recipient, recipientLabel, targetType]);

  const useTargetType = useCallback(
    (type: WhatsAppWebRecipientType) => {
      const currentRecipient = recipient.trim();
      setTargetType(type);
      if (type === "self") {
        setRecipient("self");
        setRecipientLabel("My WhatsApp");
        return;
      }
      if (type === "group") {
        setRecipient(currentRecipient.endsWith("@g.us") ? currentRecipient : "");
        setRecipientLabel(
          currentRecipient.endsWith("@g.us")
            ? recipientLabel || "WhatsApp group"
            : "WhatsApp group",
        );
        return;
      }
      setRecipient(
        targetType === "manual" &&
          currentRecipient !== "self" &&
          !currentRecipient.endsWith("@g.us")
          ? currentRecipient
          : "",
      );
      setRecipientLabel("WhatsApp recipient");
    },
    [recipient, recipientLabel, targetType],
  );

  const applyDroppedRecipient = useCallback((value: string) => {
    const parsed = extractWhatsAppRecipientInput(value);
    if (!parsed) return;
    setTargetType(parsed.endsWith("@g.us") ? "group" : "manual");
    setRecipient(parsed);
    setRecipientLabel(parsed.endsWith("@g.us") ? "WhatsApp group" : "WhatsApp recipient");
  }, []);

  const connected = status?.state === "connected";
  const selectedTarget = buildWhatsAppTarget(
    targetType,
    recipient,
    recipientLabel,
    groups,
  );
  const hasTarget = selectedTarget.recipient.trim().length > 0;
  const selectedTargetKey = hasTarget
    ? stableWhatsAppTargetKey(selectedTarget)
    : undefined;
  const dirty = Boolean(
    selectedTargetKey && selectedTargetKey !== lastSavedTargetKey.current,
  );
  const canTest = connected && hasTarget && !sending;

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !connected || !selectedTargetKey) return;
    if (selectedTargetKey === lastSavedTargetKey.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const target = parseWhatsAppTargetKey(selectedTargetKey);
      setSaving(true);
      setError(undefined);
      void (async () => {
        try {
          await api.setConnectorConfig("whatsapp-web", {
            defaultRecipientType: target.type,
            defaultRecipient: target.recipient,
            defaultRecipientLabel: target.label,
          });
          if (cancelled) return;
          lastSavedTargetKey.current = selectedTargetKey;
          setRecipient(target.recipient);
          setRecipientLabel(target.label);
          setSavedAt(new Date().toISOString());
          await onRefresh();
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (!cancelled) setSaving(false);
        }
      })();
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connected, onRefresh, selectedTargetKey]);

  const qrRefreshAt = status?.qrRefreshesAt
    ? Date.parse(status.qrRefreshesAt)
    : Number.NaN;
  const qrIssuedAt = status?.qrIssuedAt ? Date.parse(status.qrIssuedAt) : Number.NaN;
  const qrRefreshSeconds = Number.isFinite(qrRefreshAt)
    ? Math.max(0, Math.ceil((qrRefreshAt - nowMs) / 1_000))
    : undefined;
  const qrRefreshProgress =
    Number.isFinite(qrIssuedAt) && Number.isFinite(qrRefreshAt) && qrRefreshAt > qrIssuedAt
      ? Math.min(
          100,
          Math.max(0, ((nowMs - qrIssuedAt) / (qrRefreshAt - qrIssuedAt)) * 100),
        )
      : undefined;
  const targetStatusText = saving
    ? "Saving default target…"
    : dirty
      ? "Saving default target automatically."
      : sentAt
        ? `Test sent ${formatRelative(sentAt)}`
        : savedAt
          ? `Saved ${formatRelative(savedAt)}`
          : selectedTarget.recipient
            ? `Default target: ${selectedTarget.label}`
            : "Choose a notification target.";
  const showWhatsAppSetup = !connected || Boolean(status?.qrDataUrl);

  return (
    <article className="overflow-hidden rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]">
      <div className="border-b border-[var(--color-border-soft)] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 ring-1 ring-[var(--color-border-soft)]">
            <WhatsAppLogo size={30} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold text-[var(--color-text)]">
                {descriptor.name}
              </h2>
              <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                v{descriptor.version}
              </span>
              <Tag tone="neutral">External</Tag>
            </div>
            <p className="mt-1.5 max-w-[820px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              Sends outbound run notifications through a WhatsApp Web session
              linked on this device. OpenAdminOS stores the session locally and
              does not read incoming messages.
            </p>
          </div>
          <WhatsAppStatusPill status={status} summary={summary} />
        </div>

        <div className="mt-4">
          <ConnectorDetailsDisclosure
            title="Capabilities and trust boundary"
            summary="Outbound-only notifications through a local WhatsApp Web session."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <ConnectorInfoBlock title="Capabilities">
                <ul className="space-y-1.5">
                  {descriptor.capabilities.map((cap) => (
                    <CapabilityRow key={cap.id} capability={cap} />
                  ))}
                </ul>
              </ConnectorInfoBlock>
              <ConnectorInfoBlock title="Trust boundary">
                <p className="text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  Message content leaves Microsoft 365 and is delivered by WhatsApp.
                  No Microsoft Graph scopes are requested.
                </p>
                <p className="mt-2 font-mono text-[11px] text-[var(--color-text-muted)]">
                  auth: local WhatsApp Web QR
                </p>
              </ConnectorInfoBlock>
            </div>
          </ConnectorDetailsDisclosure>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
        <section className="border-b border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/20 p-5 xl:border-r xl:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SectionLabel>Local link</SectionLabel>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                {connected
                  ? "Linked session used for outbound notifications."
                  : "Pair once with the phone that owns the WhatsApp account."}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<IconRefresh size={13} />}
              onClick={() => void loadStatus()}
              disabled={loadingStatus}
            >
              {loadingStatus ? "Checking…" : "Refresh"}
            </Button>
          </div>

          {showWhatsAppSetup ? (
            <div className="mt-4 grid gap-4 md:grid-cols-[252px_minmax(0,1fr)] xl:grid-cols-1 2xl:grid-cols-[252px_minmax(0,1fr)]">
              <div>
                {status?.qrDataUrl ? (
                  <div>
                    <div className="mx-auto w-fit max-w-full rounded-lg bg-white p-3 ring-1 ring-[var(--color-border-soft)]">
                      <img
                        src={status.qrDataUrl}
                        alt="WhatsApp Web sign-in QR code"
                        width={224}
                        height={224}
                        className="mx-auto h-56 w-56"
                      />
                    </div>
                    <WhatsAppQrStatus
                      refreshSeconds={qrRefreshSeconds}
                      progress={qrRefreshProgress}
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-[var(--color-border-soft)] bg-[var(--color-surface)]/55 p-4">
                    <p className="text-[12.5px] text-[var(--color-text-soft)]">
                      {status?.message ?? "WhatsApp Web is not linked on this device."}
                    </p>
                    <p className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                      Start linking to show the QR code.
                    </p>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => void startLogin()}
                    disabled={linking || connected}
                  >
                    {linking
                      ? "Opening…"
                      : status?.qrDataUrl
                        ? "Refresh QR"
                        : "Link with QR"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void disconnect()}
                    disabled={disconnecting || (!connected && status?.state !== "qr")}
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </div>

              <div className="rounded-lg bg-[var(--color-surface)]/55 p-4 ring-1 ring-[var(--color-border-soft)]">
                <SectionLabel>Phone steps</SectionLabel>
                <ol className="mt-3 space-y-2 text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
                  <li className="flex gap-2">
                    <StepNumber>1</StepNumber>
                    <span>Open WhatsApp on your phone.</span>
                  </li>
                  <li className="flex gap-2">
                    <StepNumber>2</StepNumber>
                    <span>Tap Settings, then tap the QR symbol near your profile.</span>
                  </li>
                  <li className="flex gap-2">
                    <StepNumber>3</StepNumber>
                    <span>
                      Tap Scan. If your app shows Linked Devices instead, choose Link a Device.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <StepNumber>4</StepNumber>
                    <span>Scan the code and approve the new computer prompt.</span>
                  </li>
                </ol>
              </div>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="mt-4 flex flex-col gap-3 rounded-lg bg-[var(--color-success-soft)]/15 p-4 ring-1 ring-[var(--color-success)]/20 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[var(--color-success)]">
                  <IconCheck size={14} />
                  <p className="text-[12.5px] font-medium">Linked locally</p>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                  Session is stored on this device.
                  {status?.lastConnectedAt
                    ? ` Last connected ${formatRelative(status.lastConnectedAt)}.`
                    : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void disconnect()}
                disabled={disconnecting}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          )}
        </section>

        <section className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SectionLabel>Default notification target</SectionLabel>
              <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                Used unless an agent overrides its WhatsApp target.
              </p>
            </div>
            <Tag tone={connected ? "success" : "warning"}>
              {connected ? "Can test" : "Link first"}
            </Tag>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <WhatsAppTargetButton
              active={targetType === "self"}
              icon={<IconUser size={14} />}
              label="Me"
              detail="Linked account"
              onClick={() => useTargetType("self")}
            />
            <WhatsAppTargetButton
              active={targetType === "group"}
              icon={<IconUsers size={14} />}
              label="Group"
              detail="Pick locally"
              onClick={() => useTargetType("group")}
            />
            <WhatsAppTargetButton
              active={targetType === "manual"}
              icon={<IconHash size={14} />}
              label="Number/JID"
              detail="Paste or drop"
              onClick={() => useTargetType("manual")}
            />
          </div>

          {targetType === "self" && (
            <div className="mt-3 rounded-lg bg-[var(--color-success-soft)]/15 px-3 py-2 ring-1 ring-[var(--color-success)]/20">
              <p className="text-[12px] font-medium text-[var(--color-success)]">
                Send to My WhatsApp
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                The linked account is resolved locally when a message sends.
                Your phone number is not shown in the app.
              </p>
            </div>
          )}

          {targetType === "group" && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] text-[var(--color-text-soft)]">
                  WhatsApp group
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  leadingIcon={<IconRefresh size={13} />}
                  onClick={() => void loadGroups()}
                  disabled={!connected || loadingGroups}
                >
                  {loadingGroups ? "Loading…" : "Refresh groups"}
                </Button>
              </div>
              <Select
                aria-label="WhatsApp group"
                name="whatsapp-group"
                value={recipient}
                disabled={!connected || loadingGroups}
                onChange={(event) => {
                  const group = groups.find((entry) => entry.id === event.target.value);
                  setRecipient(event.target.value);
                  setRecipientLabel(group?.subject ?? "WhatsApp group");
                }}
                className="h-9 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
              >
                <option value="">
                  {!connected
                    ? "Link WhatsApp Web first"
                    : loadingGroups
                      ? "Loading groups…"
                      : "Select group"}
                </option>
                {recipient && !groups.some((group) => group.id === recipient) && (
                  <option value={recipient}>{recipientLabel || "Saved group"}</option>
                )}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.subject}
                    {group.participantCount !== undefined
                      ? ` (${group.participantCount})`
                      : ""}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Group names are read from the linked local session.
              </p>
            </div>
          )}

          {targetType === "manual" && (
            <div
              className={`mt-3 rounded-lg border border-dashed px-3 py-2 transition-colors ${
                dropActive
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/25"
                  : "border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/40"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropActive(true);
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDropActive(false);
                applyDroppedRecipient(event.dataTransfer.getData("text"));
              }}
            >
              <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
                <span>Number, wa.me link, or raw JID</span>
                <input
                  type="text"
                  value={recipient}
                  name="whatsapp-recipient"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setRecipient(event.target.value);
                    setRecipientLabel("WhatsApp recipient");
                  }}
                  placeholder="+15551234567…"
                  inputMode="tel"
                  className="h-9 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] focus:border-[var(--color-accent)]"
                />
              </label>
              <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
                Paste or drop a phone number, wa.me link, contact text, or WhatsApp JID.
              </p>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--color-border-soft)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span
              role="status"
              aria-live="polite"
              className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--color-text-muted)]"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  saving || dirty
                    ? "bg-[var(--color-warning)]"
                    : selectedTarget.recipient
                      ? "bg-[var(--color-success)]"
                      : "bg-[var(--color-text-muted)]"
                }`}
              />
              <span className="truncate">
                {targetStatusText}
              </span>
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void sendTest()}
                disabled={!canTest}
              >
                {sending ? "Sending…" : "Send test"}
              </Button>
            </div>
          </div>
        </section>
      </div>

      {(error || status?.lastError) && (
        <div className="border-t border-[var(--color-border-soft)] px-5 py-3">
          {error ? (
            <ConnectorNotice tone="danger" title="WhatsApp delivery error" body={error} />
          ) : status?.lastError ? (
            <ConnectorNotice
              tone="warning"
              title="Latest WhatsApp status"
              body={status.lastError}
            />
          ) : null}
        </div>
      )}
    </article>
  );
}

// ─── Notification connector cards ────────────────────────────────────────

type NotificationConnectorId = (typeof notificationConnectorIds)[number];

interface NotificationFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
}

interface NotificationSecretSpec {
  key: string;
  label: string;
  placeholder: string;
  help: string;
}

interface NotificationConnectorSpec {
  id: NotificationConnectorId;
  Icon: BrandIcon;
  authLabel: string;
  description: string;
  defaultLabel: string;
  defaultHelp: string;
  fields: NotificationFieldSpec[];
  secret?: NotificationSecretSpec;
}

const notificationConnectorSpecs: Record<
  NotificationConnectorId,
  NotificationConnectorSpec
> = {
  outlook: {
    id: "outlook",
    Icon: OutlookLogo,
    authLabel: "Graph delegated",
    description:
      "Sends run reports by email via Microsoft Graph as the signed-in admin.",
    defaultLabel: "Default recipients",
    defaultHelp: "Used by agents that send mail to the connector default.",
    fields: [
      {
        key: "defaultRecipients",
        label: "Recipients",
        placeholder: "ops@example.com\nsecurity@example.com",
        help: "Comma-, semicolon-, or newline-separated email addresses.",
        multiline: true,
      },
      {
        key: "defaultSubjectPrefix",
        label: "Subject prefix",
        placeholder: "[OpenAdminOS]",
      },
    ],
  },
  slack: {
    id: "slack",
    Icon: SlackLogo,
    authLabel: "External bot token",
    description:
      "Posts run reports to a Slack channel through a Slack app bot token.",
    defaultLabel: "Default channel",
    defaultHelp: "Use a Slack channel, user, or conversation id.",
    secret: {
      key: "botToken",
      label: "Bot token",
      placeholder: "xoxb-...",
      help: "Requires a Slack app with chat:write. Blank keeps the existing token.",
    },
    fields: [
      {
        key: "defaultChannel",
        label: "Channel or conversation id",
        placeholder: "C0123456789",
      },
      {
        key: "defaultChannelLabel",
        label: "Target label",
        placeholder: "#intune-alerts",
      },
    ],
  },
  discord: {
    id: "discord",
    Icon: WebhookLogo,
    authLabel: "Webhook secret",
    description:
      "Posts run reports to a Discord channel webhook. Webhook URLs are stored as secrets.",
    defaultLabel: "Default webhook",
    defaultHelp: "Webhook URL is write-only; labels stay in normal config.",
    secret: {
      key: "webhookUrl",
      label: "Webhook URL",
      placeholder: "https://discord.com/api/webhooks/...",
      help: "Blank keeps the existing webhook URL.",
    },
    fields: [
      {
        key: "defaultTargetLabel",
        label: "Target label",
        placeholder: "#admin-alerts",
      },
      {
        key: "username",
        label: "Webhook username",
        placeholder: "OpenAdminOS",
      },
      {
        key: "defaultThreadId",
        label: "Thread id",
        placeholder: "Optional",
      },
    ],
  },
  signal: {
    id: "signal",
    Icon: WebhookLogo,
    authLabel: "Local signal-cli",
    description:
      "Sends run reports through a local signal-cli account or local REST bridge.",
    defaultLabel: "Default recipient",
    defaultHelp: "Signal delivery requires a local sender account.",
    fields: [
      {
        key: "account",
        label: "Sender account",
        placeholder: "+15551234567",
      },
      {
        key: "defaultRecipient",
        label: "Recipient",
        placeholder: "+15557654321",
      },
      {
        key: "defaultRecipientLabel",
        label: "Recipient label",
        placeholder: "Signal recipient",
      },
      {
        key: "httpUrl",
        label: "REST bridge URL",
        placeholder: "http://127.0.0.1:8080",
      },
      {
        key: "cliPath",
        label: "signal-cli path",
        placeholder: "signal-cli",
      },
      {
        key: "configPath",
        label: "signal-cli config directory",
        placeholder: "Optional",
      },
    ],
  },
};

function NotificationConnectorCard({
  summary,
  busy,
  onRefresh,
  onTest,
}: {
  summary: ConnectorSummary;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onTest: () => Promise<void> | void;
}) {
  const spec = notificationConnectorSpecs[
    summary.descriptor.id as NotificationConnectorId
  ];
  const [draft, setDraft] = useState(() =>
    configDraftForFields(summary.config, spec?.fields ?? []),
  );
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState(false);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!spec) return;
    setDraft(configDraftForFields(summary.config, spec.fields));
  }, [spec, summary.config]);

  if (!spec) return null;

  const { Icon } = spec;
  const isConnected = summary.status === "connected";
  const hasSecret = Boolean(spec.secret);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = window.openAdminOS;
    if (!api) return;
    setSaving(true);
    setError(undefined);
    try {
      const config: Record<string, unknown> = {};
      for (const field of spec.fields) {
        const value = draft[field.key]?.trim();
        if (value) config[field.key] = value;
      }
      await api.setConnectorConfig(spec.id, config);
      if (spec.secret && secret.trim()) {
        await api.setConnectorSecret(spec.id, spec.secret.key, secret.trim());
        setSecret("");
      }
      setSavedAt(new Date().toISOString());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearSecret() {
    const api = window.openAdminOS;
    if (!api || !spec.secret) return;
    setClearingSecret(true);
    setError(undefined);
    try {
      await api.setConnectorSecret(spec.id, spec.secret.key, null);
      setSecret("");
      setSavedAt(new Date().toISOString());
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearingSecret(false);
    }
  }

  return (
    <article className="overflow-hidden rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]">
      <form onSubmit={(event) => void save(event)}>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 ring-1 ring-[var(--color-border-soft)]">
              <Icon size={30} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[15px] font-semibold text-[var(--color-text)]">
                  {summary.descriptor.name}
                </h2>
                <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                  v{summary.descriptor.version}
                </span>
                <Tag tone="neutral">{spec.authLabel}</Tag>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                {spec.description}
              </p>
            </div>
            <StatusPill summary={summary} />
          </div>

          <div className="mt-4">
            <SectionLabel>{spec.defaultLabel}</SectionLabel>
            <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
              {spec.defaultHelp}
            </p>
          </div>

          <div className="mt-3 grid gap-3">
            {spec.secret ? (
              <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
                <span>{spec.secret.label}</span>
                <input
                  type="password"
                  value={secret}
                  name={`${spec.id}-${spec.secret.key}`}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder={spec.secret.placeholder}
                  className="h-9 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] focus:border-[var(--color-accent)]"
                />
                <span className="text-[10.5px] text-[var(--color-text-muted)]">
                  {spec.secret.help}
                </span>
              </label>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {spec.fields.map((field) => (
                <label
                  key={field.key}
                  className={field.multiline ? "flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)] sm:col-span-2" : "flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]"}
                >
                  <span>{field.label}</span>
                  {field.multiline ? (
                    <textarea
                      value={draft[field.key] ?? ""}
                      name={`${spec.id}-${field.key}`}
                      spellCheck={false}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      placeholder={field.placeholder}
                      rows={3}
                      className="min-h-[76px] rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 py-2 text-[12.5px] text-[var(--color-text)] focus:border-[var(--color-accent)]"
                    />
                  ) : (
                    <input
                      type="text"
                      value={draft[field.key] ?? ""}
                      name={`${spec.id}-${field.key}`}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      placeholder={field.placeholder}
                      className="h-9 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] focus:border-[var(--color-accent)]"
                    />
                  )}
                  {field.help ? (
                    <span className="text-[10.5px] text-[var(--color-text-muted)]">
                      {field.help}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          </div>

          <ConnectorDetailsDisclosure
            title="Capabilities"
            summary={`${summary.descriptor.capabilities.length} notify capability, ${summary.descriptor.scopes.length} required scope${summary.descriptor.scopes.length === 1 ? "" : "s"}.`}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <ConnectorInfoBlock title="Capabilities">
                <ul className="space-y-1.5">
                  {summary.descriptor.capabilities.map((cap) => (
                    <CapabilityRow key={cap.id} capability={cap} />
                  ))}
                </ul>
              </ConnectorInfoBlock>
              <ConnectorInfoBlock title="Scopes">
                {summary.descriptor.scopes.length > 0 ? (
                  <ul className="space-y-0.5 break-words font-mono text-[11px] text-[var(--color-text-soft)]">
                    {summary.descriptor.scopes.map((scope) => (
                      <li key={scope}>{scope}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11.5px] text-[var(--color-text-muted)]">
                    No Microsoft Graph scopes.
                  </p>
                )}
              </ConnectorInfoBlock>
            </div>
          </ConnectorDetailsDisclosure>
        </div>

        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/25 px-4 py-3">
          {error ? (
            <div className="mb-3">
              <ConnectorNotice
                tone="danger"
                title={`${summary.descriptor.name} setup failed`}
                body={error}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 text-[11.5px] text-[var(--color-text-muted)]">
              {summary.lastTestedAt
                ? `Last tested ${formatRelative(summary.lastTestedAt)}${summary.lastTestMessage ? ` - ${summary.lastTestMessage}` : ""}`
                : savedAt
                  ? `Saved ${formatRelative(savedAt)}`
                  : hasSecret
                    ? "Save config and secret before testing."
                    : "Save config before testing."}
            </span>
            <div className="flex flex-wrap gap-2">
              {spec.secret ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void clearSecret()}
                  disabled={clearingSecret || saving}
                >
                  {clearingSecret ? "Clearing…" : "Clear secret"}
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={saving || clearingSecret}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void onTest()}
                disabled={busy || saving}
              >
                {busy ? "Testing…" : isConnected ? "Re-test" : "Test"}
              </Button>
            </div>
          </div>
        </div>
      </form>
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
  const initialTeamName =
    typeof summary.config.defaultTeamName === "string"
      ? summary.config.defaultTeamName
      : undefined;
  const initialChannelName =
    typeof summary.config.defaultChannelName === "string"
      ? summary.config.defaultChannelName
      : undefined;

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
  const lastSavedDefaultKey = useRef<string | undefined>(
    initialTeamId && initialChannelId
      ? stableTeamsDefaultKey({
          teamId: initialTeamId,
          channelId: initialChannelId,
          ...(initialTeamName ? { teamName: initialTeamName } : {}),
          ...(initialChannelName ? { channelName: initialChannelName } : {}),
        })
      : undefined,
  );

  useEffect(() => {
    const api = window.openAdminOS;
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
    const api = window.openAdminOS;
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

  const selectedTeam = teams?.find((team) => team.id === teamId);
  const selectedChannel = channels?.find((channel) => channel.id === channelId);
  const selectedTeamName =
    selectedTeam?.displayName ??
    (teamId === initialTeamId ? initialTeamName : undefined);
  const selectedChannelName =
    selectedChannel?.displayName ??
    (channelId === initialChannelId ? initialChannelName : undefined);
  const selectedDefault: TeamsDefaultDraft | undefined =
    teamId && channelId
      ? {
          teamId,
          channelId,
          ...(selectedTeamName ? { teamName: selectedTeamName } : {}),
          ...(selectedChannelName ? { channelName: selectedChannelName } : {}),
        }
      : undefined;
  const selectedDefaultKey = selectedDefault
    ? stableTeamsDefaultKey(selectedDefault)
    : undefined;
  const dirty = Boolean(
    selectedDefaultKey && selectedDefaultKey !== lastSavedDefaultKey.current,
  );

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !selectedDefaultKey) return;
    if (selectedDefaultKey === lastSavedDefaultKey.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const target = parseTeamsDefaultKey(selectedDefaultKey);
      setSaving(true);
      setError(undefined);
      void api
        .setConnectorConfig("teams", {
          defaultTeamId: target.teamId,
          defaultChannelId: target.channelId,
          ...(target.teamName ? { defaultTeamName: target.teamName } : {}),
          ...(target.channelName
            ? { defaultChannelName: target.channelName }
            : {}),
        })
        .then(() => {
          if (cancelled) return;
          lastSavedDefaultKey.current = selectedDefaultKey;
          setSavedAt(new Date().toISOString());
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) setSaving(false);
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedDefaultKey]);

  const defaultStatusText =
    !teamId || !channelId
      ? "Choose a team and channel."
      : saving
        ? "Saving default channel…"
        : dirty
          ? "Saving default channel automatically."
          : savedAt
            ? `Saved ${formatRelative(savedAt)}`
            : "Default channel set.";

  return (
    <div className="mt-2 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
          <span>Team</span>
          <Select
            name="teams-team"
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setChannelId("");
            }}
            disabled={loadingTeams}
            className="h-9 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)]"
          >
            <option value="">
              {loadingTeams ? "Loading…" : "Select a team"}
            </option>
            {teams?.map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-[var(--color-text-soft)]">
          <span>Channel</span>
          <Select
            name="teams-channel"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={!teamId || loadingChannels}
            className="h-9 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
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
          </Select>
        </label>
      </div>
      {error && (
        <p className="text-[11.5px] text-[var(--color-danger)]">{error}</p>
      )}
      <div className="flex items-center justify-between">
        <span
          role="status"
          aria-live="polite"
          className="text-[11px] text-[var(--color-text-muted)]"
        >
          {defaultStatusText}
        </span>
      </div>
    </div>
  );
}

// ─── WhatsApp target helpers ──────────────────────────────────────────────

function stableWhatsAppTargetKey(target: WhatsAppTargetDraft): string {
  return JSON.stringify({
    type: target.type,
    recipient: target.recipient,
    label: target.label,
  });
}

function parseWhatsAppTargetKey(key: string): WhatsAppTargetDraft {
  return JSON.parse(key) as WhatsAppTargetDraft;
}

function stableTeamsDefaultKey(target: TeamsDefaultDraft): string {
  return JSON.stringify({
    teamId: target.teamId,
    channelId: target.channelId,
    teamName: target.teamName ?? "",
    channelName: target.channelName ?? "",
  });
}

function parseTeamsDefaultKey(key: string): TeamsDefaultDraft {
  const parsed = JSON.parse(key) as TeamsDefaultDraft;
  return {
    teamId: parsed.teamId,
    channelId: parsed.channelId,
    ...(parsed.teamName ? { teamName: parsed.teamName } : {}),
    ...(parsed.channelName ? { channelName: parsed.channelName } : {}),
  };
}

function readWhatsAppTargetFromConfig(
  config: Record<string, unknown>,
): WhatsAppTargetDraft {
  const type = readWhatsAppRecipientType(config.defaultRecipientType);
  const recipient =
    typeof config.defaultRecipient === "string"
      ? config.defaultRecipient.trim()
      : "";
  const label =
    typeof config.defaultRecipientLabel === "string" &&
    config.defaultRecipientLabel.trim()
      ? config.defaultRecipientLabel.trim()
      : undefined;

  if (type === "self" || recipient === "self" || !recipient) {
    return {
      type: "self",
      recipient: "self",
      label: label ?? "My WhatsApp",
    };
  }
  if (type === "group" || recipient.endsWith("@g.us")) {
    return {
      type: "group",
      recipient,
      label: label ?? "WhatsApp group",
    };
  }
  return {
    type: "manual",
    recipient,
    label: label ?? "WhatsApp recipient",
  };
}

function buildWhatsAppTarget(
  type: WhatsAppWebRecipientType,
  recipient: string,
  label: string,
  groups: WhatsAppWebGroupRef[],
): WhatsAppTargetDraft {
  if (type === "self") {
    return { type, recipient: "self", label: "My WhatsApp" };
  }
  const value = recipient.trim();
  if (type === "group") {
    const group = groups.find((entry) => entry.id === value);
    const fallbackLabel = label.trim() || "WhatsApp group";
    return {
      type,
      recipient: value,
      label: group?.subject ?? fallbackLabel,
    };
  }
  return {
    type,
    recipient: value,
    label: "WhatsApp recipient",
  };
}

function WhatsAppQrStatus({
  refreshSeconds,
  progress,
}: {
  refreshSeconds: number | undefined;
  progress: number | undefined;
}) {
  return (
    <div className="mt-2 rounded-lg bg-[var(--color-bg-raised)]/55 p-2.5 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-soft)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
          <span>QR active</span>
        </div>
        <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
          {refreshSeconds !== undefined
            ? `Refresh in ${refreshSeconds}s`
            : "Auto-refresh on"}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-border-soft)]">
        <div
          className="h-full rounded-full bg-[var(--color-warning)]"
          style={{ width: `${progress ?? 0}%` }}
        />
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">
        If the phone rejects this code, wait for the next automatic refresh and
        scan again.
      </p>
    </div>
  );
}

function readWhatsAppRecipientType(
  value: unknown,
): WhatsAppWebRecipientType | undefined {
  return value === "self" || value === "group" || value === "manual"
    ? value
    : undefined;
}

function WhatsAppTargetButton({
  active,
  icon,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-[58px] rounded-lg px-3 py-2 text-left ring-1 transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-[var(--color-accent)]/40"
          : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            active ? "bg-[var(--color-accent-soft)]" : "bg-[var(--color-surface)]"
          }`}
        >
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-medium">{label}</span>
          <span className="mt-0.5 block truncate text-[10.5px] opacity-75">
            {detail}
          </span>
        </span>
      </div>
    </button>
  );
}

// ─── Reusable primitives ──────────────────────────────────────────────────

function ConnectorDetailsDisclosure({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg bg-[var(--color-bg-raised)]/25 ring-1 ring-[var(--color-border-soft)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:content-none">
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-[var(--color-text)]">
            {title}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
            {summary}
          </span>
        </span>
        <IconChevronDown
          size={14}
          className="shrink-0 text-[var(--color-text-muted)] group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-[var(--color-border-soft)] p-3">{children}</div>
    </details>
  );
}

function ConnectorInfoBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)]/35 p-3 ring-1 ring-[var(--color-border-soft)]">
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-raised)] font-mono text-[10px] font-medium text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]">
      {children}
    </span>
  );
}

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

function WhatsAppStatusPill({
  status,
  summary,
}: {
  status: WhatsAppWebStatus | null;
  summary: ConnectorSummary;
}) {
  const state = status?.state;
  const label =
    state === "connected"
      ? "Connected"
      : state === "qr"
        ? "QR ready"
        : state === "connecting"
          ? "Connecting"
          : state === "reconnecting"
            ? "Reconnecting"
            : state === "logged-out"
              ? "Logged out"
              : state === "error"
                ? "Error"
                : summary.status === "unknown"
                  ? "Untested"
                  : "Needs setup";
  const tone =
    state === "connected"
      ? "ok"
      : state === "error" || state === "logged-out"
        ? "err"
        : state === "qr" || state === "connecting" || state === "reconnecting"
          ? "warn"
          : "neutral";
  const classes =
    tone === "ok"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : tone === "warn"
        ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
        : tone === "err"
          ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function isWhatsAppPollingState(
  state: WhatsAppWebStatus["state"],
): boolean {
  return (
    state === "connecting" ||
    state === "qr" ||
    state === "reconnecting"
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
  children: ReactNode;
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

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </h3>
  );
}

function SectionHeader({
  title,
  tone = "default",
  compact = false,
}: {
  title: string;
  tone?: "default" | "muted";
  compact?: boolean;
}) {
  return (
    <div className={`${compact ? "mt-1" : "mt-8"} mb-3 flex items-center gap-2`}>
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

function isConnectorSummary(
  summary: ConnectorSummary | undefined,
): summary is ConnectorSummary {
  return summary !== undefined;
}

function configDraftForFields(
  config: Record<string, unknown>,
  fields: readonly NotificationFieldSpec[],
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of fields) {
    const value = config[field.key];
    draft[field.key] = typeof value === "string" ? value : "";
  }
  return draft;
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
