import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Pill, StatusDot } from "../components/Pill";
import {
  IconBolt,
  IconCloud,
  IconCopy,
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconChat,
  IconCheck,
  IconClose,
  IconDownload,
  IconPlay,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStar,
} from "../components/icons";
import { useAppState } from "../state";
import {
  resolveProviderDefaultModel,
  type GraphCacheStatus,
  type GraphCacheResourceKind,
  type IntuneChatAgentSuggestion,
  type IntuneChatConversation,
  type IntuneChatMessage,
  type IntuneChatProgressStep,
  type IntuneChatSource,
  type IntuneChatStreamEvent,
  type ProviderId,
  type SendIntuneChatMessageInput,
} from "../shared/openAdminOS";
import { copyTextToClipboard } from "../shared/clipboard";

const promptGroups = [
  {
    label: "Devices",
    prompts: [
      "Which managed devices have not synced in the last 7 days?",
      "Which devices are stale in Intune but still active in Entra?",
      "Which devices are both stale and noncompliant?",
      "Which Windows devices are not encrypted?",
    ],
  },
  {
    label: "Apps",
    prompts: [
      "Which required apps are assigned but not installed on targeted devices?",
      "Which app deployments appear tied to the primary user?",
      "Which superseded apps are still detected on devices?",
      "Which app assignments target empty or stale groups?",
    ],
  },
  {
    label: "Autopilot",
    prompts: [
      "Which Autopilot devices are in failed enrollment state?",
      "Which deployment profiles make the enrolling user a local admin?",
      "Which Win32 apps are assigned during Autopilot ESP?",
      "Why is this Autopilot device stuck during ESP?",
    ],
  },
  {
    label: "Security",
    prompts: [
      "Which recent sign-ins failed because of Conditional Access?",
      "Which Conditional Access policies depend on device compliance?",
      "Which endpoint security policies are assigned to all devices?",
      "What are the top risks visible from cached tenant data?",
    ],
  },
  {
    label: "Updates",
    prompts: [
      "Which devices should have received 25H2 but have not?",
      "Which update rings might conflict with feature update policies?",
      "Which Windows devices are below the supported OS build?",
      "Why are feature updates not offered to active devices?",
    ],
  },
  {
    label: "Scripts",
    prompts: [
      "Which remediation scripts have not reported results recently?",
      "Which devices are likely affected by Intune Management Extension delays?",
      "Which scripts run as the logged-on user versus system?",
      "Why are remediation results missing even though scripts ran locally?",
    ],
  },
];

type ChatProgressState = {
  message: string;
  progressPercent: number;
  steps: IntuneChatProgressStep[];
};

type OptimisticChatDraft = {
  userMessage: IntuneChatMessage;
  assistantMessage: IntuneChatMessage;
};

type HostedChatConsentPrompt = {
  content: string;
  conversationId?: string;
  tenantId: string;
  tenantName: string;
  providerId: ProviderId;
  providerName: string;
  model?: string;
};

type HostedProviderConsentInput = NonNullable<
  SendIntuneChatMessageInput["hostedProviderConsent"]
>;

const collapsedRailControlClass =
  "grid h-9 w-9 place-items-center rounded-full text-center leading-none transition-colors";

export default function IntuneChat() {
  const navigate = useNavigate();
  const { state, startRun, refresh } = useAppState();
  const [conversations, setConversations] = useState<IntuneChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<IntuneChatMessage[]>([]);
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus | null>(null);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runningAgentSlug, setRunningAgentSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgressState | null>(null);
  const [progressAssistantMessageId, setProgressAssistantMessageId] = useState<string | null>(null);
  const [optimisticDraft, setOptimisticDraft] = useState<OptimisticChatDraft | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pinnedSectionOpen, setPinnedSectionOpen] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [hostedConsentPrompt, setHostedConsentPrompt] =
    useState<HostedChatConsentPrompt | null>(null);
  const [rememberHostedConsent, setRememberHostedConsent] = useState(true);
  const [renameTarget, setRenameTarget] = useState<IntuneChatConversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<IntuneChatConversation | null>(null);
  const [conversationMenu, setConversationMenu] = useState<{
    conversation: IntuneChatConversation;
    x: number;
    y: number;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendInFlightRef = useRef(false);
  const progressClearTimerRef = useRef<number | null>(null);
  const copiedClearTimerRef = useRef<number | null>(null);

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const activeModel = resolveProviderDefaultModel(
    provider,
    state.activeModelByProviderId,
  ).model;

  const loadShell = async (
    preferredActiveConversationId?: string | null,
    searchOverride = conversationSearch,
  ) => {
    const api = window.openAdminOS;
    if (!api) return;
    const query = searchOverride.trim();
    const [nextConversations, nextCache] = await Promise.all([
      query
        ? api.searchIntuneChatConversations(query)
        : api.listIntuneChatConversations(),
      api.getGraphCacheStatus().catch(() => null),
    ]);
    setConversations(nextConversations);
    setCacheStatus(nextCache);
    if (sendInFlightRef.current && preferredActiveConversationId === undefined) {
      return;
    }
    if (preferredActiveConversationId !== undefined) {
      setActiveConversationId(
        preferredActiveConversationId ?? nextConversations[0]?.id ?? null,
      );
      return;
    }
    setActiveConversationId((current) =>
      current && nextConversations.some((conversation) => conversation.id === current)
        ? current
        : nextConversations[0]?.id ?? null,
    );
  };

  useEffect(() => {
    void loadShell().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTenantId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadShell(undefined, conversationSearch).catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
    }, 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationSearch]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (sending || sendInFlightRef.current) {
      return;
    }
    if (!api || !activeConversationId) {
      setMessages([]);
      return;
    }
    void api
      .getIntuneChatMessages(activeConversationId)
      .then(setMessages)
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [activeConversationId, sending]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, sending, chatProgress?.message]);

  useEffect(
    () => () => {
      if (progressClearTimerRef.current !== null) {
        window.clearTimeout(progressClearTimerRef.current);
      }
      if (copiedClearTimerRef.current !== null) {
        window.clearTimeout(copiedClearTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!conversationMenu) return;
    const closeMenu = () => setConversationMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [conversationMenu]);

  const clearProgressTimer = () => {
    if (progressClearTimerRef.current !== null) {
      window.clearTimeout(progressClearTimerRef.current);
      progressClearTimerRef.current = null;
    }
  };

  const scheduleProgressClear = (delayMs: number) => {
    clearProgressTimer();
    progressClearTimerRef.current = window.setTimeout(() => {
      setChatProgress(null);
      setProgressAssistantMessageId(null);
      progressClearTimerRef.current = null;
    }, delayMs);
  };

  const startNewConversation = () => {
    if (sending) return;
    clearProgressTimer();
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setError(null);
    setNotice(null);
    setStopping(false);
    setChatProgress(null);
    setProgressAssistantMessageId(null);
    setOptimisticDraft(null);
  };

  const handleStopGeneration = async () => {
    const api = window.openAdminOS;
    if (!api || !sending || stopping) return;
    setStopping(true);
    setError(null);
    setChatProgress(createStoppedChatProgress("Stopping response."));
    try {
      await api.cancelIntuneChatStream();
    } catch (caught) {
      setStopping(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleSend = async (contentOverride?: string, conversationIdOverride?: string) => {
    const content = (contentOverride ?? input).trim();
    const api = window.openAdminOS;
    if (!api || !content || sending) return;
    if (provider && activeTenant && requiresHostedChatConsent(provider, activeTenant)) {
      setHostedConsentPrompt({
        content,
        ...(conversationIdOverride ? { conversationId: conversationIdOverride } : {}),
        tenantId: activeTenant.id,
        tenantName: activeTenant.displayName,
        providerId: provider.id,
        providerName: provider.name,
        ...(activeModel ? { model: activeModel } : {}),
      });
      setRememberHostedConsent(true);
      return;
    }
    await executeSend(
      content,
      rememberedHostedProviderConsent(provider, activeTenant),
      conversationIdOverride,
    );
  };

  const executeSend = async (
    content: string,
    hostedProviderConsent?: HostedProviderConsentInput,
    conversationIdOverride?: string,
  ) => {
    const api = window.openAdminOS;
    if (!api || !content || sending) return;
    const targetConversationId = conversationIdOverride ?? activeConversationId;
    const pendingConversationId = targetConversationId ?? `pending_${window.crypto.randomUUID()}`;
    const pendingUserId = `pending_user_${window.crypto.randomUUID()}`;
    const pendingAssistantId = `pending_assistant_${window.crypto.randomUUID()}`;
    const pendingCreatedAt = new Date().toISOString();
    const initialProgress = createInitialChatProgress();
    const pendingUserMessage: IntuneChatMessage = {
      id: pendingUserId,
      conversationId: pendingConversationId,
      role: "user",
      content,
      status: "completed",
      createdAt: pendingCreatedAt,
    };
    const pendingAssistantMessage: IntuneChatMessage = {
      id: pendingAssistantId,
      conversationId: pendingConversationId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: pendingCreatedAt,
      providerId: provider?.id ?? state.activeProviderId,
      ...(activeModel ? { model: activeModel } : {}),
    };

    sendInFlightRef.current = true;
    setSending(true);
    setError(null);
    setNotice(null);
    clearProgressTimer();
    setChatProgress(initialProgress);
    setProgressAssistantMessageId(pendingAssistantId);
    setOptimisticDraft({
      userMessage: pendingUserMessage,
      assistantMessage: pendingAssistantMessage,
    });
    setMessages((current) => [
      ...(targetConversationId ? current : []),
      pendingUserMessage,
      pendingAssistantMessage,
    ]);
    setInput("");
    let failed = false;
    let cancelled = false;
    try {
      const result = await api.streamIntuneChatMessage(
        {
          conversationId: targetConversationId ?? undefined,
          content,
          refreshIfStale: true,
          ...(hostedProviderConsent ? { hostedProviderConsent } : {}),
        },
        (event) => {
          if (event.type === "started") {
            setOptimisticDraft(null);
            setActiveConversationId(event.conversation.id);
            setCacheStatus(event.cacheStatus);
            setProgressAssistantMessageId(event.assistantMessage.id);
            setMessages((current) => {
              const withoutDraft = current.filter(
                (message) =>
                  message.id !== pendingUserId &&
                  message.id !== pendingAssistantId &&
                  message.id !== event.userMessage.id &&
                  message.id !== event.assistantMessage.id,
              );
              return [...withoutDraft, event.userMessage, event.assistantMessage];
            });
          }
          if (event.type === "status") {
            setChatProgress(progressFromStatusEvent(event));
            if (event.cacheStatus) {
              setCacheStatus(event.cacheStatus);
            }
          }
          if (event.type === "delta") {
            setMessages((current) =>
              upsertMessage(
                current,
                {
                  id: event.assistantMessageId,
                  conversationId: event.conversationId,
                  role: "assistant",
                  content: event.content,
                  status: "streaming",
                  createdAt: new Date().toISOString(),
                  ...(event.providerId ? { providerId: event.providerId } : {}),
                  ...(event.model ? { model: event.model } : {}),
                },
                (existing) => ({
                  ...existing,
                  content: event.content,
                  providerId: event.providerId ?? existing.providerId,
                  model: event.model ?? existing.model,
                }),
              ),
            );
          }
          if (
            event.type === "completed" ||
            event.type === "failed" ||
            event.type === "cancelled"
          ) {
            setOptimisticDraft(null);
            setCacheStatus(event.result.cacheStatus);
            setMessages((current) => {
              const withoutPending = current.filter(
                (message) =>
                  message.id !== pendingUserId && message.id !== pendingAssistantId,
              );
              const withUser = upsertMessage(withoutPending, event.result.userMessage);
              return upsertMessage(withUser, event.result.assistantMessage);
            });
            if (event.type === "failed") {
              failed = true;
              setError(event.error);
            }
            if (event.type === "cancelled") {
              cancelled = true;
              setChatProgress(createStoppedChatProgress("Response stopped."));
            }
          }
        },
      );
      setActiveConversationId(result.conversation.id);
      setCacheStatus(result.cacheStatus);
      await loadShell(result.conversation.id);
    } catch (caught) {
      failed = true;
      setOptimisticDraft(null);
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      setError(errorMessage);
      setChatProgress({
        message: "Chat answer failed.",
        progressPercent: 100,
        steps: [
          { id: "cache-check", label: "Check cached tenant data", status: "completed" },
          { id: "context-pack", label: "Build answer context", status: "failed" },
          { id: "model-answer", label: "Generate response", status: "pending" },
        ],
      });
      setMessages((current) =>
        upsertMessage(
          current,
          {
            id: pendingAssistantId,
            conversationId: pendingConversationId,
            role: "assistant",
            content: `Chat answer failed. ${errorMessage}`,
            status: "failed",
            createdAt: new Date().toISOString(),
            providerId: provider?.id ?? state.activeProviderId,
            ...(activeModel ? { model: activeModel } : {}),
          },
          (existing) => ({
            ...existing,
            content: existing.content.trim()
              ? existing.content
              : `Chat answer failed. ${errorMessage}`,
            status: "failed",
          }),
        ),
      );
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
      setStopping(false);
      scheduleProgressClear(cancelled ? 2200 : failed ? 3200 : 1800);
    }
  };

  const confirmHostedConsentAndSend = async () => {
    const pending = hostedConsentPrompt;
    if (!pending) return;
    if (rememberHostedConsent) {
      rememberHostedChatConsent(pending.tenantId, pending.providerId);
    }
    setHostedConsentPrompt(null);
    await executeSend(
      pending.content,
      createHostedProviderConsent(
        pending.tenantId,
        pending.providerId,
        rememberHostedConsent,
      ),
      pending.conversationId,
    );
  };

  const handleRenameConversation = async () => {
    const api = window.openAdminOS;
    const target = renameTarget;
    const nextTitle = renameTitle.trim();
    if (!api || !target || !nextTitle) return;
    setError(null);
    try {
      const renamed = await api.renameIntuneChatConversation(target.id, nextTitle);
      setRenameTarget(null);
      setRenameTitle("");
      await loadShell(renamed.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleTogglePinnedConversation = async (conversation: IntuneChatConversation) => {
    const api = window.openAdminOS;
    if (!api || sending) return;
    setError(null);
    try {
      const updated = await api.setIntuneChatConversationPinned(
        conversation.id,
        !conversation.pinnedAt,
      );
      await loadShell(updated.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleDeleteConversation = async () => {
    const api = window.openAdminOS;
    const target = deleteTarget;
    if (!api || !target) return;
    setError(null);
    try {
      await api.deleteIntuneChatConversation(target.id);
      setDeleteTarget(null);
      if (target.id === activeConversationId) {
        setMessages([]);
        await loadShell(null);
      } else {
        await loadShell(activeConversationId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleRunAgent = async (
    slug: string,
    conversationId: string,
    messageId: string,
  ) => {
    setRunningAgentSlug(slug);
    setError(null);
    setNotice(null);
    try {
      const run = await startRun(slug, {
        source: {
          type: "intune-chat",
          conversationId,
          messageId,
        },
      });
      if (window.openAdminOS) {
        setMessages(await window.openAdminOS.getIntuneChatMessages(conversationId));
      }
      await refresh();
      navigate(`/runs/${run.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAgentSlug(null);
    }
  };

  const handleEditPrompt = (message: IntuneChatMessage) => {
    if (sending || message.role !== "user") return;
    setActiveConversationId(message.conversationId);
    setInput(message.content);
    setError(null);
    setNotice(null);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleRegenerateResponse = async (message: IntuneChatMessage) => {
    if (sending || message.role !== "assistant") return;
    const previousPrompt = previousUserPromptForMessage(messages, message);
    if (!previousPrompt) {
      setError("Cannot regenerate this response because the previous prompt was not found.");
      return;
    }
    setActiveConversationId(message.conversationId);
    setError(null);
    setNotice(null);
    await handleSend(previousPrompt, message.conversationId);
  };

  const handleExportConversation = async () => {
    const api = window.openAdminOS;
    if (!api || !activeConversation || messages.length === 0) return;
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveTextFile({
        suggestedName: `${safeFileName(activeConversation.title)}.md`,
        content: buildConversationExportMarkdown({
          conversation: activeConversation,
          messages,
          tenantName: activeTenant?.displayName,
          providerName: provider?.name ?? state.activeProviderId,
          cacheSummary,
        }),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!result.canceled) {
        setNotice(
          result.filePath
            ? `Exported conversation to ${result.filePath}.`
            : "Exported conversation.",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleCopyMessage = async (message: IntuneChatMessage) => {
    const text = message.content.trim();
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setCopiedMessageId(message.id);
      if (copiedClearTimerRef.current !== null) {
        window.clearTimeout(copiedClearTimerRef.current);
      }
      copiedClearTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId(null);
        copiedClearTimerRef.current = null;
      }, 1600);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const cacheSummary = useMemo(() => {
    if (!cacheStatus) return "No cache";
    const refreshed = cacheStatus.resources.filter((resource) => resource.refreshedAt);
    if (refreshed.length === 0) return "No cache";
    const newest = refreshed
      .map((resource) => resource.refreshedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return newest ? `Updated ${formatDateTime(newest)}` : "Cache ready";
  }, [cacheStatus]);

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  );
  const pinnedConversations = conversations.filter(
    (conversation) => conversation.pinnedAt,
  );
  const recentConversations = conversations.filter(
    (conversation) => !conversation.pinnedAt,
  );
  const activeConversationInRail = conversations.some(
    (conversation) => conversation.id === activeConversationId,
  );
  const draftConversationActive =
    activeConversationId === null ||
    (sending && optimisticDraft !== null && !activeConversationInRail);
  const displayedMessages = mergeOptimisticMessages(messages, optimisticDraft);
  const progressMessageVisible =
    progressAssistantMessageId !== null &&
    displayedMessages.some((message) => message.id === progressAssistantMessageId);
  const openConversationContextMenu = (
    event: MouseEvent<HTMLButtonElement>,
    conversation: IntuneChatConversation,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setConversationMenu({
      conversation,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
    });
  };
  const renderConversationRow = (conversation: IntuneChatConversation) => (
    <button
      key={conversation.id}
      type="button"
      onClick={() => setActiveConversationId(conversation.id)}
      onContextMenu={(event) => openConversationContextMenu(event, conversation)}
      className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
        activeConversationId === conversation.id
          ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
          : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
    >
      <div className="truncate text-[12.5px] font-medium">
        {conversation.pinnedAt && (
          <IconStar
            size={10}
            className="mr-1 inline align-[-1px] text-[var(--color-accent)]"
          />
        )}
        {conversation.title}
      </div>
      <div className="mt-1 text-[10.5px] text-[var(--color-text-muted)]">
        {formatDateTime(conversation.updatedAt)}
      </div>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
      <aside
        className={`flex shrink-0 flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)] transition-[width] duration-150 ${
          sidebarCollapsed ? "w-16" : "w-[284px]"
        }`}
      >
        <div className={sidebarCollapsed ? "flex flex-col items-center gap-2 px-0 pt-5 pb-3" : "px-4 pt-5 pb-3"}>
          {sidebarCollapsed ? (
            <>
              <button
                type="button"
                title="Show chat history"
                aria-label="Show chat history"
                onClick={() => setSidebarCollapsed(false)}
                className={`${collapsedRailControlClass} bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/25 hover:bg-[var(--color-accent-soft)]/80`}
              >
                <IconChevronRight size={15} />
              </button>
              <button
                type="button"
                title="New conversation"
                aria-label="New conversation"
                disabled={sending}
                onClick={startNewConversation}
                className={`${collapsedRailControlClass} ${
                  draftConversationActive
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/25"
                    : "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)] hover:text-[var(--color-text)]"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <IconPlus size={14} />
              </button>
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Intune Chat
                </div>
                <div className="mt-1 truncate text-[13px] text-[var(--color-text-soft)]">
                  {activeTenant?.displayName ?? "No tenant"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="Hide chat history"
                  aria-label="Hide chat history"
                  onClick={() => setSidebarCollapsed(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                >
                  <IconArrowLeft size={13} />
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<IconPlus size={12} />}
                  disabled={sending}
                  onClick={startNewConversation}
                >
                  New
                </Button>
              </div>
            </div>
          )}
        </div>

        {!sidebarCollapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div className="sticky top-0 z-10 bg-[var(--color-sidebar-solid)] pb-2">
              <div className="relative">
                <IconSearch
                  size={13}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                />
                <input
                  value={conversationSearch}
                  onChange={(event) => setConversationSearch(event.target.value)}
                  placeholder="Search conversations"
                  className="h-8 w-full rounded-md bg-[var(--color-bg-raised)] pl-8 pr-2 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-muted)] focus:ring-[var(--color-accent)]"
                />
              </div>
            </div>
            {draftConversationActive && (
              <button
                type="button"
                disabled={sending}
                onClick={startNewConversation}
                className="mb-1 w-full rounded-lg bg-[var(--color-surface-hover)] px-3 py-2.5 text-left text-[var(--color-text)] transition-colors disabled:cursor-not-allowed"
              >
                <div className="truncate text-[12.5px] font-medium">
                  New conversation
                </div>
                <div className="mt-1 text-[10.5px] text-[var(--color-text-muted)]">
                  {sending ? "Thinking" : input.trim() ? "Draft" : "Ready"}
                </div>
              </button>
            )}
            {conversations.length === 0 ? (
              <div className="rounded-lg px-3 py-4 text-[12px] leading-5 text-[var(--color-text-muted)]">
                {conversationSearch.trim()
                  ? "No matching conversations."
                  : "Chat history will appear here."}
              </div>
            ) : (
              <>
                {pinnedConversations.length > 0 && (
                  <div className="mb-2">
                    <button
                      type="button"
                      onClick={() => setPinnedSectionOpen((open) => !open)}
                      className="mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                      aria-expanded={pinnedSectionOpen}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <IconStar size={10} className="text-[var(--color-accent)]" />
                        Pinned
                        <span className="font-mono text-[10px] tabular-nums opacity-70">
                          {pinnedConversations.length}
                        </span>
                      </span>
                      {pinnedSectionOpen ? (
                        <IconChevronDown size={11} />
                      ) : (
                        <IconChevronRight size={11} />
                      )}
                    </button>
                    {pinnedSectionOpen && pinnedConversations.map(renderConversationRow)}
                  </div>
                )}
                {recentConversations.length > 0 && (
                  <div>
                    {pinnedConversations.length > 0 && (
                      <div className="mb-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                        Recent
                      </div>
                    )}
                    {recentConversations.map(renderConversationRow)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {sidebarCollapsed && (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-0 pb-3">
            {conversations.slice(0, 12).map((conversation, index) => (
              <button
                key={conversation.id}
                type="button"
                title={conversation.title}
                aria-label={`Open conversation ${conversation.title}`}
                onClick={() => {
                  setActiveConversationId(conversation.id);
                  setSidebarCollapsed(false);
                }}
                onContextMenu={(event) => openConversationContextMenu(event, conversation)}
                className={`${collapsedRailControlClass} font-mono text-[10.5px] ${
                  activeConversationId === conversation.id
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }`}
              >
                {String(index + 1).padStart(2, "0")}
              </button>
            ))}
          </div>
        )}

        <div
          className={`border-t border-[var(--color-border-soft)] ${
            sidebarCollapsed ? "flex h-14 items-center justify-center p-0" : "p-3"
          }`}
        >
          {sidebarCollapsed ? (
            <button
              type="button"
              title="Chat settings"
              aria-label="Chat settings"
              onClick={() => navigate("/settings")}
              className={`${collapsedRailControlClass} text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]`}
            >
              <IconSettings size={14} />
            </button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start"
              leadingIcon={<IconSettings size={13} />}
              onClick={() => navigate("/settings")}
            >
              Chat settings
            </Button>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border-soft)] px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <IconChat size={16} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
                {activeConversation?.pinnedAt && (
                  <IconStar
                    size={11}
                    className="mr-1.5 inline align-[-1px] text-[var(--color-accent)]"
                  />
                )}
                {activeConversation?.title ?? "New conversation"}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                <StatusDot tone={provider?.isLocal ? "success" : "warning"} />
                <span className="truncate">
                  {provider?.isLocal
                    ? "Local provider"
                    : "Hosted provider"}
                  {" · "}
                  {cacheSummary}
                </span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {activeConversation && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<IconDownload size={12} />}
                  disabled={sending || messages.length === 0}
                  onClick={() => void handleExportConversation()}
                >
                  Export
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<IconStar size={12} />}
                  disabled={sending}
                  onClick={() => void handleTogglePinnedConversation(activeConversation)}
                >
                  {activeConversation.pinnedAt ? "Unpin" : "Pin"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    setRenameTarget(activeConversation);
                    setRenameTitle(activeConversation.title);
                  }}
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={sending}
                  onClick={() => setDeleteTarget(activeConversation)}
                >
                  Delete
                </Button>
              </>
            )}
            <Pill tone={provider?.isLocal ? "success" : "warning"}>
              {provider?.name ?? state.activeProviderId}
            </Pill>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col px-6 py-8">
            {displayedMessages.length === 0 ? (
              chatProgress ? (
                <div className="flex flex-1 flex-col justify-center gap-6 py-16">
                  <ChatProgressCard progress={chatProgress} />
                </div>
              ) : (
              <EmptyChat
                disabled={!activeTenant || sending}
                onPrompt={(prompt) => void handleSend(prompt)}
              />
              )
            ) : (
              <div className="flex flex-1 flex-col gap-6">
                {displayedMessages.map((message) => (
                <ChatMessageBubble
                    key={message.id}
                    message={message}
                    progress={message.id === progressAssistantMessageId ? chatProgress : null}
                    copied={message.id === copiedMessageId}
                    runningAgentSlug={runningAgentSlug}
                    regenerateDisabled={
                      sending ||
                      !previousUserPromptForMessage(displayedMessages, message)
                    }
                    onCopy={() => void handleCopyMessage(message)}
                    onEditPrompt={() => handleEditPrompt(message)}
                    onRegenerate={() => void handleRegenerateResponse(message)}
                    onRunAgent={handleRunAgent}
                  />
                ))}
                {sending && chatProgress && !progressMessageVisible && (
                  <ChatProgressCard progress={chatProgress} />
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] px-6 py-4">
          <div className="mx-auto w-full max-w-[860px]">
            {error && (
              <div className="mb-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
                {error}
              </div>
            )}
            {notice && (
              <div className="mb-3 rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
                {notice}
              </div>
            )}
            <div className="intune-chat-composer rounded-xl bg-[var(--color-bg-raised)] p-2 ring-1 ring-[var(--color-border)] focus-within:ring-[var(--color-accent)]">
              <textarea
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Ask about devices, users, policies, sign-ins, or an installed agent workflow."
                className="max-h-[180px] min-h-[72px] w-full resize-none bg-transparent px-2 py-2 text-[13.5px] leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:outline-none focus-visible:outline-none"
              />
              <div className="flex items-center justify-between gap-3 px-1 pb-1">
                <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                  {provider?.isLocal
                    ? "Tenant context stays on this device with the selected local provider."
                    : "Retrieved tenant context is sent to the selected hosted provider."}
                </div>
                {sending ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<IconClose size={12} />}
                    disabled={stopping}
                    onClick={() => void handleStopGeneration()}
                  >
                    {stopping ? "Stopping" : "Stop"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={input.trim().length === 0 || !activeTenant}
                    onClick={() => void handleSend()}
                  >
                    Send
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      <HostedChatConsentModal
        prompt={hostedConsentPrompt}
        remember={rememberHostedConsent}
        onRememberChange={setRememberHostedConsent}
        onClose={() => setHostedConsentPrompt(null)}
        onConfirm={() => void confirmHostedConsentAndSend()}
      />
      <RenameConversationModal
        conversation={renameTarget}
        title={renameTitle}
        onTitleChange={setRenameTitle}
        onClose={() => {
          setRenameTarget(null);
          setRenameTitle("");
        }}
        onConfirm={() => void handleRenameConversation()}
      />
      <DeleteConversationModal
        conversation={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteConversation()}
      />
      {conversationMenu && (
        <ConversationContextMenu
          conversation={conversationMenu.conversation}
          x={conversationMenu.x}
          y={conversationMenu.y}
          onDelete={() => {
            setDeleteTarget(conversationMenu.conversation);
            setConversationMenu(null);
          }}
        />
      )}
    </div>
  );
}

function upsertMessage(
  current: IntuneChatMessage[],
  next: IntuneChatMessage,
  updateExisting?: (existing: IntuneChatMessage) => IntuneChatMessage,
): IntuneChatMessage[] {
  let found = false;
  const updated = current.map((message) => {
    if (message.id !== next.id) return message;
    found = true;
    return updateExisting ? updateExisting(message) : next;
  });
  return found ? updated : [...updated, next];
}

function mergeOptimisticMessages(
  messages: IntuneChatMessage[],
  draft: OptimisticChatDraft | null,
): IntuneChatMessage[] {
  if (!draft) return messages;
  const messageIds = new Set(messages.map((message) => message.id));
  const merged = [...messages];
  if (!messageIds.has(draft.userMessage.id)) {
    merged.push(draft.userMessage);
  }
  if (!messageIds.has(draft.assistantMessage.id)) {
    merged.push(draft.assistantMessage);
  }
  return merged;
}

function previousUserPromptForMessage(
  messages: IntuneChatMessage[],
  message: IntuneChatMessage,
): string | null {
  const messageIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (messageIndex <= 0) return null;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === "user" && candidate.content.trim()) {
      return candidate.content.trim();
    }
  }
  return null;
}

function HostedChatConsentModal({
  prompt,
  remember,
  onRememberChange,
  onClose,
  onConfirm,
}: {
  prompt: HostedChatConsentPrompt | null;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={Boolean(prompt)} onClose={onClose} size="md">
      <ModalHeader
        title="Send tenant context to hosted provider"
        subtitle={prompt?.providerName ?? "Hosted provider"}
        badge={<Pill tone="warning">Hosted</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
          This chat answer will use retrieved tenant context with {prompt?.providerName}.
          The answer prompt leaves this device.
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <ConsentFact label="Tenant" value={prompt?.tenantName ?? "Active tenant"} />
          <ConsentFact label="Provider" value={prompt?.providerName ?? "Hosted provider"} />
          <ConsentFact label="Model" value={prompt?.model ?? "Provider default"} />
          <ConsentFact label="Stored data" value="Chat history and Graph cache stay local" />
        </div>
        <div className="rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)] text-[var(--color-warning)]">
              <IconCloud size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[var(--color-text)]">
                What leaves this device
              </div>
              <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-soft)]">
                The prompt text, selected cached Graph evidence, source freshness,
                and answer instructions are sent to the hosted provider for this
                response. Raw cache tables, chat history storage, and self-training
                files remain on this device.
              </p>
            </div>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => onRememberChange(event.target.checked)}
            className="mt-1 h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          <span>
            Remember this decision for this tenant and provider on this device.
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConsentFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate text-[12.5px] text-[var(--color-text)]">
        {value}
      </div>
    </div>
  );
}

function RenameConversationModal({
  conversation,
  title,
  onTitleChange,
  onClose,
  onConfirm,
}: {
  conversation: IntuneChatConversation | null;
  title: string;
  onTitleChange: (title: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const trimmed = title.trim();
  return (
    <Modal open={Boolean(conversation)} onClose={onClose} size="md">
      <ModalHeader
        title="Rename conversation"
        subtitle={conversation?.title}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Conversation title
          </span>
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            autoFocus
            className="mt-2 h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          />
        </label>
        <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
          Renaming changes the local conversation title only. It does not
          change prompts, cached Graph data, or agent run history.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={trimmed.length === 0}
          >
            Rename
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteConversationModal({
  conversation,
  onClose,
  onConfirm,
}: {
  conversation: IntuneChatConversation | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={Boolean(conversation)} onClose={onClose} size="md">
      <ModalHeader
        title="Delete conversation"
        subtitle={conversation?.title}
        badge={<Pill tone="danger">Local deletion</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          This removes the conversation, messages, and chat tool-call records
          from the local SQLite store. It does not disconnect the tenant or
          clear the Graph cache.
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConversationContextMenu({
  conversation,
  x,
  y,
  onDelete,
}: {
  conversation: IntuneChatConversation;
  x: number;
  y: number;
  onDelete: () => void;
}) {
  return (
    <div
      className="fixed z-[80] w-[220px] overflow-hidden rounded-lg bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      <div className="border-b border-[var(--color-border-soft)] px-3 py-2">
        <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
          {conversation.title}
        </div>
        <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
          Local conversation
        </div>
      </div>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px] text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)]"
      >
        Delete conversation
      </button>
    </div>
  );
}

function requiresHostedChatConsent(
  provider: { id: ProviderId; isLocal: boolean } | undefined,
  tenant: { id: string } | undefined,
): provider is { id: ProviderId; isLocal: false } {
  if (!provider || provider.isLocal || !tenant) return false;
  return !hasRememberedHostedChatConsent(tenant.id, provider.id);
}

function rememberedHostedProviderConsent(
  provider: { id: ProviderId; isLocal: boolean } | undefined,
  tenant: { id: string } | undefined,
): HostedProviderConsentInput | undefined {
  if (!provider || provider.isLocal || !tenant) return undefined;
  if (!hasRememberedHostedChatConsent(tenant.id, provider.id)) return undefined;
  return createHostedProviderConsent(tenant.id, provider.id, true);
}

function createHostedProviderConsent(
  tenantId: string,
  providerId: ProviderId,
  remember: boolean,
): HostedProviderConsentInput {
  return {
    tenantId,
    providerId,
    acknowledgedAt: new Date().toISOString(),
    ...(remember ? { remember: true } : {}),
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

function rememberHostedChatConsent(tenantId: string, providerId: ProviderId): void {
  try {
    window.localStorage.setItem(hostedChatConsentKey(tenantId, providerId), "true");
  } catch {
    // If localStorage is unavailable, the next hosted send will ask again.
  }
}

function createInitialChatProgress(): ChatProgressState {
  return {
    message: "Checking cached tenant data.",
    progressPercent: 8,
    steps: [
      { id: "cache-check", label: "Check cached tenant data", status: "active" },
      { id: "context-pack", label: "Build answer context", status: "pending" },
      { id: "model-answer", label: "Generate response", status: "pending" },
    ],
  };
}

function createStoppedChatProgress(message: string): ChatProgressState {
  return {
    message,
    progressPercent: 100,
    steps: [
      { id: "cache-check", label: "Check cached tenant data", status: "completed" },
      { id: "context-pack", label: "Build answer context", status: "completed" },
      { id: "model-answer", label: "Generate response", status: "failed" },
    ],
  };
}

function progressFromStatusEvent(
  event: Extract<IntuneChatStreamEvent, { type: "status" }>,
): ChatProgressState {
  const steps = event.progressSteps ?? fallbackProgressSteps(event.stage);
  return {
    message: event.message,
    progressPercent:
      typeof event.progressPercent === "number"
        ? event.progressPercent
        : estimateProgressPercent(steps),
    steps,
  };
}

function fallbackProgressSteps(
  stage: Extract<IntuneChatStreamEvent, { type: "status" }>["stage"],
): IntuneChatProgressStep[] {
  if (stage === "completed") {
    return [
      { id: "cache-check", label: "Check cached tenant data", status: "completed" },
      { id: "context-pack", label: "Build answer context", status: "completed" },
      { id: "model-answer", label: "Generate response", status: "completed" },
    ];
  }
  if (stage === "failed") {
    return [
      { id: "cache-check", label: "Check cached tenant data", status: "completed" },
      { id: "context-pack", label: "Build answer context", status: "completed" },
      { id: "model-answer", label: "Generate response", status: "failed" },
    ];
  }
  return [
    {
      id: "cache-check",
      label: "Check cached tenant data",
      status: stage === "checking-cache" ? "active" : "completed",
    },
    {
      id: "context-pack",
      label: "Build answer context",
      status: stage === "building-context" ? "active" : "pending",
    },
    {
      id: "model-answer",
      label: "Generate response",
      status: stage === "generating-answer" ? "active" : "pending",
    },
  ];
}

function estimateProgressPercent(steps: IntuneChatProgressStep[]): number {
  if (steps.length === 0) return 0;
  const score = steps.reduce((sum, step) => {
    if (step.status === "completed" || step.status === "failed") return sum + 1;
    if (step.status === "active") return sum + 0.45;
    return sum;
  }, 0);
  return Math.max(5, Math.min(100, Math.round((score / steps.length) * 100)));
}

function ChatProgressCard({ progress }: { progress: ChatProgressState }) {
  const percent = Math.max(5, Math.min(100, progress.progressPercent));
  const hasFailed = progress.steps.some((step) => step.status === "failed");
  const isComplete =
    progress.steps.length > 0 &&
    progress.steps.every((step) => step.status === "completed");
  const completedCount = progress.steps.filter(
    (step) => step.status === "completed" || step.status === "failed",
  ).length;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[560px] rounded-xl bg-[var(--color-bg-raised)] px-3.5 py-3 ring-1 ring-[var(--color-border-soft)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-text)]">
            {progress.message}
          </div>
          <div className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {completedCount}/{progress.steps.length}
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-border-soft)]">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              hasFailed
                ? "bg-[var(--color-danger)]"
                : isComplete
                  ? "bg-[var(--color-success)]"
                  : "bg-[var(--color-accent)]"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-3 grid gap-2">
          {progress.steps.map((step) => (
            <div key={step.id} className="flex min-w-0 items-start gap-2.5">
              <ProgressStepGlyph status={step.status} />
              <div className="min-w-0 flex-1">
                <div
                  className={`truncate text-[12px] ${
                    step.status === "pending"
                      ? "text-[var(--color-text-muted)]"
                      : "text-[var(--color-text-soft)]"
                  }`}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]">
                    {step.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProgressStepGlyph({
  status,
}: {
  status: IntuneChatProgressStep["status"];
}) {
  if (status === "completed") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/35">
        <IconCheck size={10} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-soft)] text-[10px] font-semibold text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/35">
        !
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--color-accent)]">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-[var(--color-text)]/25">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-soft)]" />
    </span>
  );
}

function EmptyChat({
  disabled,
  onPrompt,
}: {
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const [activeGroup, setActiveGroup] = useState(promptGroups[0]?.label ?? "Devices");
  const prompts =
    promptGroups.find((group) => group.label === activeGroup)?.prompts ??
    promptGroups[0]?.prompts ??
    [];

  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div className="w-full max-w-[680px] text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <IconChat size={21} />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          What do you want to inspect?
        </h1>
        <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-[var(--color-text-soft)]">
          Ask a tenant question in plain language. Chat will use Graph cache or live
          reads, then keep any write action inside agent confirmation flows.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-1.5">
          {promptGroups.map((group) => (
            <button
              key={group.label}
              onClick={() => setActiveGroup(group.label)}
              className={`rounded-lg px-3 py-1.5 text-[11.5px] transition-colors ${
                activeGroup === group.label
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] hover:text-[var(--color-text)]"
              }`}
            >
              {group.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-2 text-left sm:grid-cols-2">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              disabled={disabled}
              onClick={() => onPrompt(prompt)}
              className="rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-[13px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatMessageBubble({
  message,
  progress,
  copied,
  runningAgentSlug,
  regenerateDisabled,
  onCopy,
  onEditPrompt,
  onRegenerate,
  onRunAgent,
}: {
  message: IntuneChatMessage;
  progress: ChatProgressState | null;
  copied: boolean;
  runningAgentSlug: string | null;
  regenerateDisabled: boolean;
  onCopy: () => void;
  onEditPrompt: () => void;
  onRegenerate: () => void;
  onRunAgent: (
    slug: string,
    conversationId: string,
    messageId: string,
  ) => Promise<void>;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[76%]" : "w-full max-w-[760px]"}>
        <div
          className={
            isUser
              ? "rounded-2xl bg-[var(--color-accent)] px-4 py-2.5 text-[13.5px] leading-6 text-[#1a120c]"
              : "text-[13.5px] leading-6 text-[var(--color-text)]"
          }
        >
          {!isUser && progress ? (
            <div className="space-y-4">
              <ChatProgressCard progress={progress} />
              {message.content.trim().length > 0 && (
                <div className="whitespace-pre-wrap">{message.content}</div>
              )}
            </div>
          ) : (
            <div className="whitespace-pre-wrap">
              {message.content || (message.status === "streaming" ? "..." : "")}
            </div>
          )}
        </div>
        {!isUser && message.sources && message.sources.length > 0 && (
          <>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span className="mr-0.5">Sources</span>
              {message.sources.slice(0, 4).map((source) => (
                <Pill
                  key={source.resource}
                  tone={source.error ? "warning" : source.source === "live" ? "success" : "default"}
                >
                  {source.label}
                </Pill>
              ))}
              {message.sources.length > 4 && (
                <Pill>{message.sources.length - 4} more</Pill>
              )}
            </div>
            <SourceDetails sources={message.sources} />
          </>
        )}
        {!isUser && message.agentSuggestions && message.agentSuggestions.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {message.agentSuggestions.map((suggestion) => (
              <AgentSuggestionCard
                key={suggestion.agentSlug}
                suggestion={suggestion}
                running={runningAgentSlug === suggestion.agentSlug}
                onRun={() =>
                  void onRunAgent(
                    suggestion.agentSlug,
                    message.conversationId,
                    message.id,
                  )
                }
              />
            ))}
          </div>
        )}
        <div
          className={`mt-2 flex items-center gap-2 text-[10.5px] text-[var(--color-text-muted)] ${
            isUser ? "justify-end text-right" : "justify-start"
          }`}
        >
          <span>{formatDateTime(message.createdAt)}</span>
          <button
            type="button"
            title={isUser ? "Copy prompt" : "Copy response"}
            aria-label={isUser ? "Copy prompt" : "Copy response"}
            disabled={message.content.trim().length === 0}
            onClick={onCopy}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconCopy size={11} />
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          {isUser && (
            <button
              type="button"
              title="Edit and resend prompt"
              aria-label="Edit and resend prompt"
              onClick={onEditPrompt}
              className="inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              Edit
            </button>
          )}
          {!isUser && !progress && (
            <button
              type="button"
              title="Regenerate response"
              aria-label="Regenerate response"
              disabled={regenerateDisabled}
              onClick={onRegenerate}
              className="inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceDetails({ sources }: { sources: IntuneChatSource[] }) {
  return (
    <details className="mt-2 rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium text-[var(--color-text-soft)] transition-colors hover:text-[var(--color-text)]">
        Source details
      </summary>
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2">
        <div className="grid gap-2">
          {sources.map((source) => (
            <div
              key={source.resource}
              className="rounded-md bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                    {source.label}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">
                    {source.path ?? source.resource}
                  </div>
                </div>
                <Pill tone={source.error ? "warning" : source.source === "live" ? "success" : "default"}>
                  {sourceCoverageLabel(source)}
                </Pill>
              </div>
              <div className="mt-2 grid gap-1.5 text-[11px] leading-5 text-[var(--color-text-muted)] sm:grid-cols-2">
                <SourceFact label="Rows" value={String(source.rows)} />
                <SourceFact
                  label="Freshness"
                  value={source.refreshedAt ? formatDateTime(source.refreshedAt) : "Not refreshed"}
                />
                <SourceFact
                  label="Pages"
                  value={source.pages ? String(source.pages) : "Unknown"}
                />
                <SourceFact
                  label="Mode"
                  value={source.source === "live" ? "Refreshed for this answer" : "Read from cache"}
                />
              </div>
              {source.select && source.select.length > 0 && (
                <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text-soft)]">Select</span>{" "}
                  <span className="font-mono">
                    {source.select.slice(0, 10).join(", ")}
                    {source.select.length > 10 ? `, +${source.select.length - 10} more` : ""}
                  </span>
                </div>
              )}
              {source.query && Object.keys(source.query).length > 0 && (
                <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text-soft)]">Query</span>{" "}
                  <span className="font-mono">{formatSourceQuery(source.query)}</span>
                </div>
              )}
              {source.error && (
                <div className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-2.5 py-2 text-[11px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                  {source.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function SourceFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-medium text-[var(--color-text-soft)]">{label}</span>{" "}
      <span>{value}</span>
    </div>
  );
}

function sourceCoverageLabel(source: IntuneChatSource): string {
  if (source.error) return "Partial";
  if (source.pageLimitReached) return "Capped";
  if (source.pages && source.pages > 1) return `${source.pages} pages`;
  if (source.rows === 0) return "No rows";
  return source.source === "live" ? "Live" : "Cache";
}

function chatResourceLabel(resource: GraphCacheResourceKind): string {
  const labels: Record<GraphCacheResourceKind, string> = {
    androidManagedAppProtections: "Android app protection policies",
    assignmentFilters: "Assignment filters",
    autopilotEvents: "Autopilot events",
    conditionalAccessPolicies: "Conditional Access policies",
    configurationPolicies: "Settings catalog policies",
    detectedApps: "Detected installed apps",
    deviceCompliancePolicies: "Device compliance policies",
    deviceConfigurations: "Legacy device configuration profiles",
    deviceEnrollmentConfigurations: "Enrollment configurations",
    deviceHealthScripts: "Remediations",
    deviceManagementScripts: "Platform scripts",
    directoryAudits: "Directory audit logs",
    endpointSecurityIntents: "Endpoint security policies",
    entraDevices: "Entra devices",
    groupPolicyConfigurations: "Administrative templates",
    groups: "Groups",
    iosManagedAppProtections: "iOS app protection policies",
    managedAppPolicies: "Managed app policies",
    managedDeviceEncryptionStates: "Device encryption states",
    managedDeviceOverview: "Managed device overview",
    managedDevices: "Intune managed devices",
    mobileAppConfigurations: "App configuration policies",
    mobileApps: "Intune apps",
    roleScopeTags: "Scope tags",
    signIns: "Sign-in logs",
    troubleshootingEvents: "Troubleshooting events",
    users: "Users",
    windowsAutopilotDevices: "Windows Autopilot devices",
    windowsAutopilotProfiles: "Windows Autopilot profiles",
    windowsFeatureUpdateProfiles: "Windows feature update policies",
    windowsQualityUpdateProfiles: "Windows quality update policies",
  };
  return labels[resource];
}

function formatSourceQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function buildConversationExportMarkdown(input: {
  conversation: IntuneChatConversation;
  messages: IntuneChatMessage[];
  tenantName?: string;
  providerName?: string;
  cacheSummary: string;
}): string {
  const lines = [
    `# ${input.conversation.title}`,
    "",
    `Exported: ${new Date().toISOString()}`,
    `Tenant: ${input.tenantName ?? input.conversation.tenantId ?? "Unknown"}`,
    `Provider: ${input.providerName ?? "Unknown"}`,
    `Cache: ${input.cacheSummary}`,
    "",
    "This export was generated locally by OpenAdminOS. It includes chat text and source metadata, not cached Graph row payloads.",
    "",
  ];

  for (const message of input.messages) {
    lines.push(`## ${message.role === "user" ? "Prompt" : "Response"} · ${formatDateTime(message.createdAt)}`);
    if (message.providerId || message.model || message.status !== "completed") {
      lines.push(
        [
          message.status !== "completed" ? `status=${message.status}` : undefined,
          message.providerId ? `provider=${message.providerId}` : undefined,
          message.model ? `model=${message.model}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    lines.push("", message.content.trim() || "_No content._", "");

    if (message.sources?.length) {
      lines.push("### Sources", "");
      for (const source of message.sources) {
        lines.push(`- **${source.label}** (${source.source})`);
        lines.push(`  - Resource: \`${source.resource}\``);
        if (source.path) lines.push(`  - Path: \`${source.path}\``);
        if (source.select?.length) {
          lines.push(`  - Select: \`${source.select.join(", ")}\``);
        }
        if (source.query && Object.keys(source.query).length > 0) {
          lines.push(`  - Query: \`${formatSourceQuery(source.query)}\``);
        }
        lines.push(`  - Rows: ${source.rows}`);
        lines.push(`  - Pages: ${source.pages ?? "unknown"}`);
        lines.push(`  - Capped: ${source.pageLimitReached ? "yes" : "no"}`);
        lines.push(`  - Refreshed: ${source.refreshedAt ?? "not refreshed"}`);
        if (source.error) lines.push(`  - Error: ${source.error}`);
      }
      lines.push("");
    }

    if (message.agentSuggestions?.length) {
      lines.push("### Agent Suggestions", "");
      for (const suggestion of message.agentSuggestions) {
        lines.push(
          `- **${suggestion.agentName}** (${suggestion.mode}, ${Math.round(suggestion.confidence * 100)}% match)`,
        );
        lines.push(`  - Reason: ${suggestion.reason}`);
        if (suggestion.matchedTerms?.length) {
          lines.push(`  - Matched terms: ${suggestion.matchedTerms.join(", ")}`);
        }
        if (suggestion.matchedConcepts?.length) {
          lines.push(`  - Routing evidence: ${suggestion.matchedConcepts.join("; ")}`);
        }
        if (suggestion.matchedResources?.length) {
          lines.push(
            `  - Planned sources: ${suggestion.matchedResources
              .map(chatResourceLabel)
              .join(", ")}`,
          );
        }
        lines.push(`  - Scopes: ${suggestion.scopes.join(", ") || "none"}`);
      }
      lines.push("");
    }
  }

  return capExportContent(`${lines.join("\n")}\n`);
}

function capExportContent(content: string): string {
  const maxLength = 1_900_000;
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n\n_Export truncated by OpenAdminOS because it exceeded the local save limit._\n`;
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "intune-chat-conversation";
}

function AgentSuggestionCard({
  suggestion,
  running,
  onRun,
}: {
  suggestion: IntuneChatAgentSuggestion;
  running: boolean;
  onRun: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const visibleScopes = suggestion.scopes.slice(0, 3);
  const hiddenScopeCount = Math.max(0, suggestion.scopes.length - visibleScopes.length);
  const matchedTerms = suggestion.matchedTerms ?? [];
  const matchedConcepts = suggestion.matchedConcepts ?? [];
  const matchedResources = suggestion.matchedResources ?? [];

  return (
    <div className="rounded-xl bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
              {suggestion.agentName}
            </span>
            <Pill tone={suggestion.mode === "write" ? "warning" : "success"}>
              {suggestion.mode === "write" ? "Write agent" : "Read agent"}
            </Pill>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {Math.round(suggestion.confidence * 100)}% match · existing agent workflow
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDetailsOpen((current) => !current)}
          >
            {detailsOpen ? "Hide details" : "Details"}
          </Button>
          <Button
            size="sm"
            variant={suggestion.mode === "write" ? "danger" : "secondary"}
            leadingIcon={suggestion.mode === "write" ? <IconBolt size={12} /> : <IconPlay size={12} />}
            disabled={running}
            onClick={onRun}
          >
            {running ? "Starting" : suggestion.mode === "write" ? "Review" : "Run"}
          </Button>
        </div>
      </div>
      {detailsOpen && (
        <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
          <div>{suggestion.reason}</div>
          {(matchedTerms.length > 0 ||
            matchedConcepts.length > 0 ||
            matchedResources.length > 0) && (
            <div className="mt-3 rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
              <div className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Why suggested
              </div>
              {matchedConcepts.length > 0 && (
                <ul className="space-y-1 text-[11px] text-[var(--color-text-soft)]">
                  {matchedConcepts.map((concept) => (
                    <li key={concept} className="flex gap-2">
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--color-accent)]" />
                      <span>{concept}</span>
                    </li>
                  ))}
                </ul>
              )}
              {matchedTerms.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span>Matched terms</span>
                  {matchedTerms.map((term) => (
                    <Pill key={term}>{term}</Pill>
                  ))}
                </div>
              )}
              {matchedResources.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span>Planned sources</span>
                  {matchedResources.slice(0, 4).map((resource) => (
                    <Pill key={resource}>{chatResourceLabel(resource)}</Pill>
                  ))}
                  {matchedResources.length > 4 && (
                    <Pill>{matchedResources.length - 4} more</Pill>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span>Required scopes</span>
            {visibleScopes.map((scope) => (
              <Pill key={scope}>{scope}</Pill>
            ))}
            {hiddenScopeCount > 0 && <Pill>{hiddenScopeCount} more</Pill>}
          </div>
          {suggestion.mode === "write" && (
            <div className="mt-2 text-[var(--color-warning)]">
              Write actions still use the normal plan and confirmation flow.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
