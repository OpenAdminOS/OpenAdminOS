import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IconActivity,
  IconArrowRight,
  IconChat,
  IconCheck,
  IconClock,
  IconClose,
  IconHardDrive,
  IconPlay,
  IconRefresh,
  IconSettings,
  IconShield,
  IconWarning,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  AppState,
  CompanionSnapshot,
  IntuneChatSource,
  ProviderId,
  SendIntuneChatMessageInput,
} from "../shared/openAdminOS";

type ChatPhase = "idle" | "working" | "complete" | "failed" | "cancelled";

interface CompanionChatState {
  phase: ChatPhase;
  conversationId?: string;
  assistantMessageId?: string;
  content: string;
  status: string;
  sources: IntuneChatSource[];
  error?: string;
}

const EMPTY_CHAT: CompanionChatState = {
  phase: "idle",
  content: "",
  status: "Ready",
  sources: [],
};

export default function MenuBarCompanion() {
  const { state } = useAppState();
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>(() =>
    fallbackSnapshot(state),
  );
  const [prompt, setPrompt] = useState("");
  const [chat, setChat] = useState<CompanionChatState>(EMPTY_CHAT);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"refresh" | "run-due" | null>(null);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<Date | null>(null);
  const sendingRef = useRef(false);
  const hasBridge = Boolean(window.openAdminOS);

  const loadSnapshot = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api?.getCompanionSnapshot) {
      setSnapshot(fallbackSnapshot(state));
      setLastSnapshotAt(new Date());
      return;
    }
    try {
      const next = await api.getCompanionSnapshot();
      setSnapshot(next);
      setLastSnapshotAt(new Date());
    } catch {
      setSnapshot(fallbackSnapshot(state));
      setLastSnapshotAt(new Date());
    }
  }, [state]);

  useEffect(() => {
    void loadSnapshot();
    const id = window.setInterval(() => {
      void loadSnapshot();
    }, 4000);
    return () => window.clearInterval(id);
  }, [loadSnapshot]);

  const dueReadCount = useMemo(() => {
    const now = Date.now();
    return snapshot.upcomingSchedules.filter(
      (item) => item.mode === "read" && Date.parse(item.nextRunAt) <= now,
    ).length;
  }, [snapshot.upcomingSchedules]);

  const canUseTenantActions = hasBridge && Boolean(snapshot.activeTenant);
  const providerReady = Boolean(snapshot.provider && snapshot.provider.status === "connected");
  const canAsk = canUseTenantActions && providerReady;
  const askBlocker = !hasBridge
    ? "Open the Electron app to use tenant chat."
    : !snapshot.activeTenant
      ? "Connect a tenant before using Chat."
      : !providerReady
        ? "Configure a connected LLM provider before using Chat."
        : undefined;

  const openMain = async (route = "/chat") => {
    const api = window.openAdminOS;
    if (api?.openMainWindow) {
      await api.openMainWindow(route);
      return;
    }
    window.location.hash = route;
  };

  const sendPrompt = async () => {
    const content = prompt.trim();
    const api = window.openAdminOS;
    if (!api || sendingRef.current || !content) return;
    if (!snapshot.activeTenant) {
      setNotice("Open the full app to finish tenant setup.");
      await openMain("/chat");
      return;
    }
    if (!snapshot.provider || snapshot.provider.status !== "connected") {
      setNotice("Open provider settings and connect an LLM before using Chat.");
      await openMain("/settings");
      return;
    }
    if (
      !snapshot.provider.isLocal &&
      !rememberedHostedProviderConsent(snapshot.activeTenant.id, snapshot.provider.id)
    ) {
      setNotice("Hosted-provider confirmation is required in the full app.");
      await openMain("/chat");
      return;
    }

    const hostedProviderConsent = rememberedHostedProviderConsent(
      snapshot.activeTenant.id,
      snapshot.provider.id,
    );
    const input: SendIntuneChatMessageInput = {
      content,
      refreshIfStale: true,
      ...(hostedProviderConsent ? { hostedProviderConsent } : {}),
    };

    sendingRef.current = true;
    setPrompt("");
    setNotice(null);
    setChat({
      phase: "working",
      content: "",
      status: "Checking tenant cache",
      sources: [],
    });

    try {
      await api.streamIntuneChatMessage(input, (event) => {
        if (event.type === "started") {
          setChat((current) => ({
            ...current,
            conversationId: event.conversation.id,
            assistantMessageId: event.assistantMessage.id,
            status: "Preparing answer pack",
          }));
        }
        if (event.type === "status") {
          setChat((current) => ({
            ...current,
            status: event.message,
          }));
        }
        if (event.type === "delta") {
          setChat((current) => ({
            ...current,
            phase: "working",
            assistantMessageId: event.assistantMessageId,
            content: event.content,
            status: event.model ? `Generating with ${event.model}` : "Generating answer",
          }));
        }
        if (event.type === "completed") {
          setChat({
            phase: "complete",
            conversationId: event.result.conversation.id,
            assistantMessageId: event.result.assistantMessage.id,
            content: event.result.assistantMessage.content,
            status: "Answer saved locally",
            sources: event.result.assistantMessage.sources ?? [],
          });
          void loadSnapshot();
        }
        if (event.type === "failed") {
          setChat({
            phase: "idle",
            conversationId: event.result.conversation.id,
            assistantMessageId: event.result.assistantMessage.id,
            content: "",
            status: "Continue in app",
            sources: event.result.assistantMessage.sources ?? [],
          });
          setNotice("Continue in the full app to review this chat.");
          void loadSnapshot();
        }
        if (event.type === "cancelled") {
          setChat({
            phase: "cancelled",
            conversationId: event.result.conversation.id,
            assistantMessageId: event.result.assistantMessage.id,
            content: "",
            status: "Stopped",
            sources: event.result.assistantMessage.sources ?? [],
          });
          void loadSnapshot();
        }
      });
    } catch {
      setChat({
        phase: "idle",
        content: "",
        status: "Continue in app",
        sources: [],
      });
      setNotice("Continue in the full app to use Chat.");
    } finally {
      sendingRef.current = false;
    }
  };

  const stopChat = async () => {
    await window.openAdminOS?.cancelIntuneChatStream();
  };

  const refreshCache = async () => {
    const api = window.openAdminOS;
    if (!api) return;
    setBusyAction("refresh");
    setNotice(null);
    try {
      await api.refreshGraphCache();
      setNotice("Tenant cache refreshed.");
      await loadSnapshot();
    } catch {
      setNotice("Open Settings in the full app for cache refresh details.");
      await openMain("/settings");
    } finally {
      setBusyAction(null);
    }
  };

  const runDueReadSchedules = async () => {
    const api = window.openAdminOS;
    if (!api?.runDueReadSchedules) return;
    setBusyAction("run-due");
    setNotice(null);
    try {
      const result = await api.runDueReadSchedules();
      setNotice(`${result.queued} read schedule${result.queued === 1 ? "" : "s"} queued.`);
      if (result.errors.length > 0) {
        await openMain("/agents/schedules");
      }
      await loadSnapshot();
    } catch {
      setNotice("Open Schedules in the full app for queue details.");
      await openMain("/agents/schedules");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <main className="companion-shell flex h-full w-full flex-col overflow-hidden text-[var(--color-text)]">
      <section className="relative z-10 flex min-h-0 flex-1 flex-col gap-2.5 p-3">
        <CompanionHeader
          snapshot={snapshot}
          bridgeAvailable={hasBridge}
          lastSnapshotAt={lastSnapshotAt}
          onOpenMain={() => void openMain("/chat")}
          onOpenSettings={() => void openMain("/settings")}
        />

        {notice && (
          <div className="companion-break-text animate-companion-rise min-w-0 max-w-full rounded-lg bg-[var(--color-info-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25">
            {notice}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <div className="flex min-h-full flex-col gap-2.5">
            <AskPanel
              chat={chat}
              prompt={prompt}
              sending={chat.phase === "working"}
              canAsk={canAsk}
              blocker={askBlocker}
              onPromptChange={setPrompt}
              onSend={() => void sendPrompt()}
              onStop={() => void stopChat()}
              onOpenChat={() => void openMain(canAsk ? "/chat" : "/settings")}
            />

            <QuickActions
              snapshot={snapshot}
              dueReadCount={dueReadCount}
              busyAction={busyAction}
              canUseTenantActions={canUseTenantActions}
              onRunDue={() => void runDueReadSchedules()}
              onRefresh={() => void refreshCache()}
            />

            <SchedulesSection snapshot={snapshot} onOpen={(route) => void openMain(route)} />
            {(snapshot.inFlight.length > 0 || snapshot.recentActivity.length > 0) && (
              <ActivitySection snapshot={snapshot} onOpen={(route) => void openMain(route)} />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function CompanionHeader({
  snapshot,
  bridgeAvailable,
  lastSnapshotAt,
  onOpenMain,
  onOpenSettings,
}: {
  snapshot: CompanionSnapshot;
  bridgeAvailable: boolean;
  lastSnapshotAt: Date | null;
  onOpenMain: () => void;
  onOpenSettings: () => void;
}) {
  const providerTone = snapshot.provider?.isLocal ? "success" : "warning";
  const providerLabel = snapshot.provider
    ? `${snapshot.provider.label} - ${snapshot.provider.isLocal ? "local" : "hosted"}`
    : "Provider missing";
  const cacheLabel = snapshot.cache.latestRefreshAt
    ? `Cache ${formatRelative(snapshot.cache.latestRefreshAt)}`
    : "No cache";
  const schedulerLabel = snapshot.scheduler.nextDueAt
    ? formatFuture(snapshot.scheduler.nextDueAt)
    : snapshot.scheduler.enabled
      ? "Scheduler on"
      : "Scheduler off";

  return (
    <div className="companion-panel animate-companion-rise p-3">
      <div className="flex items-start justify-between gap-3">
        <button
          className="min-w-0 flex-1 text-left"
          onClick={onOpenMain}
          title="Open OpenAdminOS"
        >
          <div className="flex items-center gap-2">
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-raised)] text-[var(--color-accent)] ring-1 ring-[var(--color-border-soft)]">
              <IconShield size={17} />
              <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-elevated)] ${snapshot.activeTenant ? "bg-[var(--color-success)]" : "bg-[var(--color-text-muted)]"}`} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-semibold text-[var(--color-text)]">
                {snapshot.activeTenant?.displayName ?? "No tenant connected"}
              </span>
              <span className="block truncate text-[10.5px] text-[var(--color-text-muted)]">
                {bridgeAvailable ? `Updated ${lastSnapshotAt ? formatTime(lastSnapshotAt) : "now"}` : "Desktop bridge unavailable"}
              </span>
            </span>
          </div>
        </button>
        <button
          className="companion-icon-button"
          aria-label="Open settings"
          title="Open settings"
          onClick={onOpenSettings}
        >
          <IconSettings size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <StatusChip
          tone={providerTone}
          icon={snapshot.provider?.isLocal ? <IconHardDrive size={12} /> : <IconWarning size={12} />}
          label={providerLabel}
        />
        <StatusChip
          tone={snapshot.cache.stale ? "warning" : "success"}
          icon={<IconRefresh size={12} />}
          label={cacheLabel}
        />
        <StatusChip
          tone={snapshot.scheduler.enabled ? "success" : "neutral"}
          icon={<IconClock size={12} />}
          label={schedulerLabel}
        />
      </div>
    </div>
  );
}

function AskPanel({
  chat,
  prompt,
  sending,
  canAsk,
  blocker,
  onPromptChange,
  onSend,
  onStop,
  onOpenChat,
}: {
  chat: CompanionChatState;
  prompt: string;
  sending: boolean;
  canAsk: boolean;
  blocker?: string;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenChat: () => void;
}) {
  const disabled = sending || !canAsk;
  return (
    <div className="companion-panel animate-companion-rise p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text)]">
            <IconChat size={13} />
            Chat
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]">
            {blocker ?? chat.status}
          </div>
        </div>
        {sending && (
          <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-[var(--color-info)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-info)]" />
            streaming
          </span>
        )}
      </div>

      {chat.phase !== "idle" && (
        <div className="companion-break-text mb-2 max-h-[132px] min-w-0 overflow-auto rounded-lg bg-black/12 px-3 py-2.5 text-[var(--color-text-soft)] ring-1 ring-white/[0.05]">
          {chat.phase === "working" && chat.content.length === 0 ? (
            <div className="space-y-2">
              <ProgressLine label="Checking cache" active />
              <ProgressLine label="Building answer pack" active />
              <ProgressLine label="Generating response" active />
            </div>
          ) : chat.error ? (
            <p className="text-[12px] leading-relaxed">Continue in the full app to review this chat.</p>
          ) : chat.content ? (
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{chat.content}</p>
          ) : (
            <p className="text-[12px] leading-relaxed">{chat.status}</p>
          )}
          {chat.sources.length > 0 && (
            <div className="mt-2 grid gap-1">
              {chat.sources.slice(0, 3).map((source) => (
                <div
                  key={`${source.resource}-${source.refreshedAt ?? "none"}`}
                  className="flex items-center justify-between gap-2 rounded-md bg-black/10 px-2 py-1 text-[10px] ring-1 ring-white/[0.05]"
                >
                  <span className="truncate text-[var(--color-text-soft)]">{source.label}</span>
                  <span className="shrink-0 font-mono text-[var(--color-text-muted)]">
                    {source.rows} rows
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="sr-only" htmlFor="companion-prompt">Ask about this tenant</label>
      <textarea
        id="companion-prompt"
        value={prompt}
        disabled={disabled}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder={canAsk ? "Ask about devices, users, apps, policies, sign-ins, or identity…" : "Open setup in the full app first"}
        className="companion-textarea"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          className="companion-quiet-button"
          onClick={onOpenChat}
        >
          {canAsk ? "Continue in app" : "Open setup"}
        </button>
        {sending ? (
          <button className="companion-danger-button" onClick={onStop}>
            <IconClose size={12} /> Stop
          </button>
        ) : (
          <button
            className="companion-primary-button"
            disabled={!canAsk || prompt.trim().length === 0}
            onClick={onSend}
          >
            Send <IconArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function QuickActions({
  snapshot,
  dueReadCount,
  busyAction,
  canUseTenantActions,
  onRunDue,
  onRefresh,
}: {
  snapshot: CompanionSnapshot;
  dueReadCount: number;
  busyAction: "refresh" | "run-due" | null;
  canUseTenantActions: boolean;
  onRunDue: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        className="companion-action-card"
        disabled={busyAction !== null || dueReadCount === 0 || !canUseTenantActions}
        onClick={onRunDue}
        title={dueReadCount === 0 ? "No due read schedules" : "Queue due read schedules"}
      >
        <IconPlay size={13} />
        <span>{busyAction === "run-due" ? "Queueing" : `Run due (${dueReadCount})`}</span>
      </button>
      <button
        className="companion-action-card"
        disabled={busyAction !== null || !canUseTenantActions || snapshot.cache.refreshing}
        onClick={onRefresh}
      >
        <IconRefresh size={13} className={busyAction === "refresh" || snapshot.cache.refreshing ? "animate-spin" : ""} />
        <span>{busyAction === "refresh" || snapshot.cache.refreshing ? "Refreshing" : "Refresh cache"}</span>
      </button>
    </div>
  );
}

function SchedulesSection({
  snapshot,
  onOpen,
}: {
  snapshot: CompanionSnapshot;
  onOpen: (route: string) => void;
}) {
  return (
    <section className="companion-panel animate-companion-rise p-2.5">
      <SectionHeader
        icon={<IconClock size={13} />}
        title="Next schedules"
        action="Open"
        onAction={() => onOpen("/agents/schedules")}
      />
      <div className="mt-2 grid gap-1.5">
        {snapshot.upcomingSchedules.length === 0 ? (
          <EmptyMini title="No schedules" body="Add recurrence in the full app when a run should repeat." />
        ) : (
          snapshot.upcomingSchedules.slice(0, 3).map((item, index) => (
            <button
              key={item.agentSlug}
              className="companion-list-row"
              style={{ animationDelay: `${index * 25}ms` }}
              onClick={() => onOpen(item.route)}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[11.5px] font-semibold text-[var(--color-text)]">{item.agentName}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] ring-1 ${item.mode === "write" ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25" : "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"}`}>
                    {item.mode}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                  Every {formatInterval(item.intervalSeconds)}
                  {item.changeState ? ` - ${changeLabel(item.changeState)}` : ""}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-soft)]">
                {formatFuture(item.nextRunAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function ActivitySection({
  snapshot,
  onOpen,
}: {
  snapshot: CompanionSnapshot;
  onOpen: (route: string) => void;
}) {
  return (
    <section className="companion-panel animate-companion-rise p-2.5">
      <SectionHeader
        icon={<IconActivity size={13} />}
        title="Recent"
        action="History"
        onAction={() => onOpen("/activity")}
      />
      <div className="mt-2 grid gap-1.5">
        {snapshot.inFlight.slice(0, 2).map((item) => (
          <button
            key={item.id}
            className="companion-list-row"
            onClick={() => item.route && onOpen(item.route)}
          >
            <span className="min-w-0">
              <span className="block truncate text-[11.5px] font-semibold text-[var(--color-text)]">{item.label}</span>
              <span className="mt-0.5 block text-[10px] text-[var(--color-info)]">{item.status}</span>
            </span>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--color-info)]" />
          </button>
        ))}
        {snapshot.recentActivity.slice(0, 3 - Math.min(snapshot.inFlight.length, 2)).map((item, index) => (
          <button
            key={item.id}
            className="companion-list-row"
            style={{ animationDelay: `${index * 25}ms` }}
            onClick={() => onOpen(item.route)}
          >
            <span className="min-w-0">
              <span className="block truncate text-[11.5px] font-semibold text-[var(--color-text)]">{item.label}</span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                {item.summary ?? formatRelative(item.queuedAt)}
              </span>
            </span>
            <OutcomeBadge status={item.status} />
          </button>
        ))}
      </div>
    </section>
  );
}

function SectionHeader({
  icon,
  title,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--color-text)]">
        {icon}
        {title}
      </h2>
      <button className="companion-quiet-button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function StatusChip({
  tone,
  icon,
  label,
}: {
  tone: "success" | "warning" | "neutral";
  icon: ReactNode;
  label: string;
}) {
  const toneClass =
    tone === "success"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"
      : tone === "warning"
        ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25"
        : "bg-black/10 text-[var(--color-text-muted)] ring-white/[0.06]";
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] ring-1 ${toneClass}`}>
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

function ProgressLine({ label, active }: { label: string; active?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]">
      {active ? (
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-[var(--color-border-strong)] border-t-[var(--color-info)]" />
      ) : (
        <IconCheck size={12} />
      )}
      <span>{label}</span>
    </div>
  );
}

function EmptyMini({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-soft)] bg-black/10 px-3 py-4 text-center">
      <div className="text-[11.5px] font-semibold text-[var(--color-text)]">{title}</div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function OutcomeBadge({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"
      : status === "failed"
        ? "bg-black/10 text-[var(--color-text-muted)] ring-white/[0.06]"
        : "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] ring-1 ${tone}`}>
      {status}
    </span>
  );
}

function fallbackSnapshot(state: AppState): CompanionSnapshot {
  const tenant = state.activeTenantId
    ? state.tenants.find((item) => item.id === state.activeTenantId) ?? null
    : null;
  const provider = state.providers.find((item) => item.id === state.activeProviderId) ?? null;
  return {
    activeTenant: tenant ? { id: tenant.id, displayName: tenant.displayName } : null,
    provider: provider
      ? {
          id: provider.id,
          label: provider.name,
          isLocal: provider.isLocal,
          trustLabel: state.trust.label,
          status: provider.status,
          ...(provider.defaultModel ? { model: provider.defaultModel } : {}),
        }
      : null,
    cache: { stale: true, refreshing: false },
    scheduler: state.schedulerStatus ?? {
      supported: false,
      enabled: false,
      detail: "Desktop bridge unavailable.",
    },
    companion: {
      supported: false,
      enabled: false,
      detail: "Desktop bridge unavailable.",
    },
    inFlight: [],
    upcomingSchedules: [],
    recentActivity: [],
    attention: [],
  };
}

function rememberedHostedProviderConsent(
  tenantId: string,
  providerId: ProviderId | undefined,
): SendIntuneChatMessageInput["hostedProviderConsent"] | undefined {
  if (!providerId || !hasRememberedHostedChatConsent(tenantId, providerId)) return undefined;
  return {
    tenantId,
    providerId,
    acknowledgedAt: new Date().toISOString(),
    remember: true,
  };
}

function hostedChatConsentKey(tenantId: string, providerId: ProviderId): string {
  return `openadminos:intune-chat-hosted-consent:v1:${tenantId}:${providerId}`;
}

function hasRememberedHostedChatConsent(
  tenantId: string,
  providerId: ProviderId,
): boolean {
  try {
    return window.localStorage.getItem(hostedChatConsentKey(tenantId, providerId)) === "true";
  } catch {
    return false;
  }
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "due";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `in ${formatInterval(seconds)}`;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function changeLabel(changeState: NonNullable<CompanionSnapshot["upcomingSchedules"][number]["changeState"]>): string {
  if (changeState === "new") return "new finding";
  if (changeState === "changed") return "changed";
  return "no change";
}
