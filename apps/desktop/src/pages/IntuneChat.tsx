import { useEffect, useId, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import { Select } from "../components/Select";
import { useLocation, useNavigate, useParams } from "react-router";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { OutputDataTable, OutputFilterSelect, OutputPane, OutputPaneSection, OutputPaneToolbar, OutputSummaryGrid, OutputSummaryTile, type OutputTableColumn } from "../components/OutputPane";
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
  IconHardDrive,
  IconPlay,
  IconPlus,
  IconSearch,
  IconStar,
} from "../components/icons";
import { useAppState } from "../state";
import { suggestAgentForQuestion } from "../shared/agent-suggestions";
import {
  type AgentSummary,
  resolveProviderDefaultModel,
  type GraphCacheStatus,
  type GraphCacheResourceKind,
  type ImportMultiTenantResultToWorkspacesResult,
  type IntuneChatAgentSuggestion,
  type IntuneChatConversation,
  type IntuneChatMessage,
  type IntuneChatProgressStep,
  type IntuneChatSource,
  type IntuneChatStreamEvent,
  type IntuneChatToolTraceEntry,
  type MultiTenantChatJob,
  type MultiTenantChatStreamEvent,
  type SavedMultiTenantQuery,
  type TenantRecord,
  type TenantGroup,
  type TenantScope,
  type TenantScopePreflight,
  type RunMultiTenantChatInput,
  type ProviderId,
  type SendIntuneChatMessageInput,
  type WorkspaceDetail,
  type WorkspacePromptContextInput,
  type WorkspacePromptContextSummary,
  type WorkspaceSummary,
} from "../shared/openAdminOS";
import { copyTextToClipboard } from "../shared/clipboard";
import { CHAT_COPY, COMMON_COPY, chatErrorCopy, deriveTrustCopy } from "../copy";
import {
  chatSendReducer,
  initialChatSendState,
  shouldSubmitComposerKey,
} from "../shared/chat-send-state";
import { clearChatDraft, readChatDraft, writeChatDraft } from "../shared/chat-drafts";
import { OPEN_NEW_CONVERSATION_EVENT } from "../shared/shortcuts";
import { formatAgentDisplayName } from "../shared/agent-display";
import { SETUP_COPY } from "../copy";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { currentReturnTo, useSetupFlow } from "../setup/SetupFlowContext";

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
    label: "Users",
    prompts: [
      "Which user accounts are disabled?",
      "Which guest users have not signed in recently?",
      "Which users are linked to noncompliant managed devices?",
      "Which users appear in recent directory audit events?",
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
    label: "Policies",
    prompts: [
      "Which compliance policies were modified most recently?",
      "Which Conditional Access policies are disabled or report-only?",
      "Which configuration policies have the highest setting counts?",
      "Which policies changed recently?",
    ],
  },
  {
    label: "Sign-ins",
    prompts: [
      "Which recent sign-ins failed because of Conditional Access?",
      "Which users have repeated failed sign-ins?",
      "Which risky sign-ins need review?",
      "Which applications have the most sign-in failures?",
    ],
  },
  {
    label: "Identity",
    prompts: [
      "Which Entra devices are not managed in Intune?",
      "Which app registration secrets or certificates expire soon?",
      "Which users hold privileged directory roles?",
      "Which Conditional Access policies exclude guest or external identities?",
    ],
  },
  {
    label: "Security",
    prompts: [
      "Which high-severity Defender incidents are open?",
      "Which Defender alerts were raised this week?",
      "How has Secure Score changed over the last 90 days?",
      "Which Secure Score improvement actions rank highest?",
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

type FailedChatRequest = {
  content: string;
  conversationId: string | null;
};

type RelatedAgentSuggestion = {
  agent: AgentSummary;
  score: number;
};

type RelatedAgentState = {
  suggestionsByMessageId: Record<string, RelatedAgentSuggestion>;
  suggestedSlugsByConversationId: Record<string, string[]>;
};

type HostedChatConsentPrompt = {
  content: string;
  conversationId?: string | null;
  tenantId: string;
  tenantName: string;
  providerId: ProviderId;
  providerName: string;
  model?: string;
  workspaceContext?: WorkspacePromptContextInput;
  workspaceContextSummary?: WorkspacePromptContextSummary;
};

type HostedProviderConsentInput = NonNullable<
  SendIntuneChatMessageInput["hostedProviderConsent"]
>;

type MultiTenantScopeMode = "active" | "selected" | "all";

type MultiTenantFilterState = {
  tenantId: string;
  complianceState: string;
  readiness: string;
  os: string;
  staleOnly: boolean;
};

const defaultMultiTenantFilters: MultiTenantFilterState = {
  tenantId: "all",
  complianceState: "all",
  readiness: "all",
  os: "all",
  staleOnly: false,
};

type HostedBatchConsentPrompt = {
  preflight: TenantScopePreflight;
  content: string;
};

type IntuneChatRouteState = {
  initialQuestion?: unknown;
  resumePendingIntent?: PendingIntent;
};

const focusRingClass =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]";

export default function IntuneChat() {
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId: routeConversationId } = useParams<{ conversationId?: string }>();
  const { state, startRun, refresh, loading } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [conversations, setConversations] = useState<IntuneChatConversation[]>([]);
  /**
   * The conversation the host reported creating for an in-flight send.
   *
   * The sidebar list is reloaded asynchronously and can legitimately not
   * contain it yet, so the route must not depend on the list alone to
   * decide whether the open conversation exists.
   */
  const [pendingConversation, setPendingConversation] =
    useState<IntuneChatConversation | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    routeConversationId ?? null,
  );
  const [shellLoaded, setShellLoaded] = useState(false);
  const [messages, setMessages] = useState<IntuneChatMessage[]>([]);
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus | null>(null);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendState, dispatchSend] = useReducer(chatSendReducer, initialChatSendState);
  const [failedRequest, setFailedRequest] = useState<FailedChatRequest | null>(null);
  const [runningAgentSlug, setRunningAgentSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgressState | null>(null);
  const [progressAssistantMessageId, setProgressAssistantMessageId] = useState<string | null>(null);
  const [optimisticDraft, setOptimisticDraft] = useState<OptimisticChatDraft | null>(null);
  const [relatedAgentState, setRelatedAgentState] = useState<RelatedAgentState>({
    suggestionsByMessageId: {},
    suggestedSlugsByConversationId: {},
  });
  const [historyOpen, setHistoryOpen] = useState(true);
  const [historyIsOverlay, setHistoryIsOverlay] = useState(false);
  const historyToggleRef = useRef<HTMLButtonElement | null>(null);
  const historySearchRef = useRef<HTMLInputElement | null>(null);
  const [pinnedSectionOpen, setPinnedSectionOpen] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [hostedConsentPrompt, setHostedConsentPrompt] =
    useState<HostedChatConsentPrompt | null>(null);
  const [rememberHostedConsent, setRememberHostedConsent] = useState(false);
  const [tenantGroups, setTenantGroups] = useState<TenantGroup[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedMultiTenantQuery[]>([]);
  const [scopeMode, setScopeMode] = useState<MultiTenantScopeMode>("active");
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedSavedQueryId, setSelectedSavedQueryId] = useState<string>("");
  const [multiTenantPreflight, setMultiTenantPreflight] =
    useState<TenantScopePreflight | null>(null);
  const [preflightPrompt, setPreflightPrompt] = useState("");
  const [runningMultiTenant, setRunningMultiTenant] = useState(false);
  const [activeMultiTenantJob, setActiveMultiTenantJob] =
    useState<MultiTenantChatJob | null>(null);
  const [hostedBatchConsentPrompt, setHostedBatchConsentPrompt] =
    useState<HostedBatchConsentPrompt | null>(null);
  const [multiTenantJobsByConversationId, setMultiTenantJobsByConversationId] =
    useState<Record<string, MultiTenantChatJob>>({});
  const [multiTenantFilters, setMultiTenantFilters] =
    useState<MultiTenantFilterState>(defaultMultiTenantFilters);
  const [expandedTenantIds, setExpandedTenantIds] = useState<string[]>([]);
  const [splitJob, setSplitJob] = useState<MultiTenantChatJob | null>(null);
  const [splitResult, setSplitResult] =
    useState<ImportMultiTenantResultToWorkspacesResult | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [attachedWorkspaceId, setAttachedWorkspaceId] = useState("");
  const [attachedWorkspace, setAttachedWorkspace] = useState<WorkspaceDetail | null>(null);
  const [selectedWorkspaceEvidenceIds, setSelectedWorkspaceEvidenceIds] = useState<string[]>([]);
  const [selectedWorkspaceNoteIds, setSelectedWorkspaceNoteIds] = useState<string[]>([]);
  const [includeWorkspaceInstructions, setIncludeWorkspaceInstructions] = useState(true);
  const [pinTarget, setPinTarget] = useState<IntuneChatMessage | null>(null);
  const [pinWorkspaceId, setPinWorkspaceId] = useState("");
  const [selectedBatchAgentSlug, setSelectedBatchAgentSlug] = useState("");
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
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
  const initialQuestionConsumedRef = useRef(false);
  const resumedIntentRef = useRef<string | null>(null);
  const progressClearTimerRef = useRef<number | null>(null);
  const copiedClearTimerRef = useRef<number | null>(null);
  const draftConversationRef = useRef<string | null | undefined>(undefined);
  const skipDraftWriteRef = useRef(false);

  /**
   * Put a conversation into the sidebar list immediately.
   *
   * Sending the first message creates the conversation in the host and
   * routes to /chat/<id> before the sidebar list has been reloaded. Without
   * this the route points at an id the renderer has not seen yet, and the
   * "Conversation not found" empty state flashes over a send that is in
   * fact working.
   */
  const upsertConversation = (conversation: IntuneChatConversation) => {
    setConversations((current) =>
      current.some((entry) => entry.id === conversation.id)
        ? current.map((entry) =>
            entry.id === conversation.id ? conversation : entry,
          )
        : [conversation, ...current],
    );
  };

  const openConversation = (
    conversationId: string | null,
    options: { replace?: boolean } = {},
  ) => {
    setActiveConversationId(conversationId);
    const destination = conversationId
      ? `/chat/${encodeURIComponent(conversationId)}`
      : "/chat";
    if (`${location.pathname}${location.search}` !== destination) {
      navigate(destination, { replace: options.replace });
    }
  };

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const activeModel = resolveProviderDefaultModel(
    provider,
    state.activeModelByProviderId,
  ).model;
  const workspaceContextSummary = useMemo<WorkspacePromptContextSummary | undefined>(() => {
    if (!attachedWorkspace) return undefined;
    const includesInstructions =
      includeWorkspaceInstructions && Boolean(attachedWorkspace.instructions?.trim());
    if (
      !includesInstructions &&
      selectedWorkspaceEvidenceIds.length === 0 &&
      selectedWorkspaceNoteIds.length === 0
    ) {
      return undefined;
    }
    return {
      workspaceId: attachedWorkspace.id,
      workspaceTitle: attachedWorkspace.title,
      tenantId: attachedWorkspace.tenantId,
      evidenceCount: selectedWorkspaceEvidenceIds.length,
      noteCount: selectedWorkspaceNoteIds.length,
      includesInstructions,
    };
  }, [
    attachedWorkspace,
    includeWorkspaceInstructions,
    selectedWorkspaceEvidenceIds.length,
    selectedWorkspaceNoteIds.length,
  ]);

  const buildWorkspaceContextInput = (): WorkspacePromptContextInput | undefined => {
    if (!attachedWorkspace || !workspaceContextSummary) return undefined;
    return {
      workspaceId: attachedWorkspace.id,
      ...(selectedWorkspaceEvidenceIds.length > 0
        ? { evidenceIds: selectedWorkspaceEvidenceIds }
        : {}),
      ...(selectedWorkspaceNoteIds.length > 0
        ? { noteIds: selectedWorkspaceNoteIds }
        : {}),
      ...(workspaceContextSummary.includesInstructions ? { includeInstructions: true } : {}),
    };
  };

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    void Promise.all([
      api.listTenantGroups(),
      api.listSavedMultiTenantQueries(),
    ])
      .then(([groups, queries]) => {
        setTenantGroups(groups);
        setSavedQueries(queries);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);

  useEffect(() => {
    if (!historyIsOverlay || !historyOpen) return;
    const onHistoryKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setHistoryOpen(false);
      window.requestAnimationFrame(() => historyToggleRef.current?.focus());
    };
    window.addEventListener("keydown", onHistoryKeyDown);
    return () => window.removeEventListener("keydown", onHistoryKeyDown);
  }, [historyIsOverlay, historyOpen]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !state.activeTenantId) {
      setWorkspaces([]);
      setAttachedWorkspaceId("");
      setAttachedWorkspace(null);
      return;
    }
    void api
      .listWorkspaces(state.activeTenantId)
      .then((nextWorkspaces) => {
        setWorkspaces(nextWorkspaces);
        setAttachedWorkspaceId((current) =>
          current && nextWorkspaces.some((workspace) => workspace.id === current)
            ? current
            : "",
        );
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [state.activeTenantId]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !attachedWorkspaceId) {
      setAttachedWorkspace(null);
      setSelectedWorkspaceEvidenceIds([]);
      setSelectedWorkspaceNoteIds([]);
      return;
    }
    void api
      .getWorkspace(attachedWorkspaceId)
      .then((workspace) => {
        setAttachedWorkspace(workspace ?? null);
        setSelectedWorkspaceEvidenceIds((current) =>
          current.filter((id) => workspace?.evidence.some((entry) => entry.id === id)),
        );
        setSelectedWorkspaceNoteIds((current) =>
          current.filter((id) => workspace?.notes.some((entry) => entry.id === id)),
        );
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [attachedWorkspaceId]);

  useEffect(() => {
    if (scopeMode !== "selected" || selectedTenantIds.length > 0) return;
    if (state.activeTenantId) {
      setSelectedTenantIds([state.activeTenantId]);
    }
  }, [scopeMode, selectedTenantIds.length, state.activeTenantId]);

  useEffect(() => {
    const narrowWindow = window.matchMedia("(max-width: 1100px)");
    const updateHistoryLayout = (matches: boolean) => {
      setHistoryIsOverlay(matches);
      setHistoryOpen(!matches);
    };
    const onBreakpointChange = (event: MediaQueryListEvent) => {
      updateHistoryLayout(event.matches);
    };

    updateHistoryLayout(narrowWindow.matches);
    narrowWindow.addEventListener("change", onBreakpointChange);
    return () => narrowWindow.removeEventListener("change", onBreakpointChange);
  }, []);

  useEffect(() => {
    const nextConversationId = routeConversationId ?? null;
    setActiveConversationId(nextConversationId);
  }, [routeConversationId]);

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
    setConversations((current) => {
      if (!activeConversationId) return nextConversations;
      // Keep the open conversation in the list when the reload does not
      // return it. This was written for search (a filtered list hides the
      // open conversation), but the same staleness happens right after a
      // conversation is created: the route already points at it while the
      // list still predates it, and dropping it here renders the
      // "Conversation not found" state over a send that is working.
      const activeConversation = current.find(
        (conversation) => conversation.id === activeConversationId,
      );
      return activeConversation &&
        !nextConversations.some((conversation) => conversation.id === activeConversationId)
        ? [activeConversation, ...nextConversations]
        : nextConversations;
    });
    setCacheStatus(nextCache);
    setShellLoaded(true);
    if (sendInFlightRef.current && preferredActiveConversationId === undefined) {
      return;
    }
    if (preferredActiveConversationId !== undefined) {
      const nextConversationId =
        preferredActiveConversationId ?? nextConversations[0]?.id ?? null;
      openConversation(nextConversationId, { replace: true });
      return;
    }
    // Conversation selection is route-owned. Refreshing or filtering the rail
    // must never switch the open transcript without updating the URL.
  };

  useEffect(() => {
    setShellLoaded(false);
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
    const activeConversation = conversations.find(
      (conversation) => conversation.id === activeConversationId,
    );
    void api
      .getIntuneChatMessages(activeConversationId)
      .then(async (nextMessages) => {
        setMessages(nextMessages);
        if (activeConversation?.multiTenantJobId) {
          const job = await api.getMultiTenantChatJob(activeConversation.multiTenantJobId);
          if (job?.conversationId) {
            setMultiTenantJobsByConversationId((current) => ({
              ...current,
              [job.conversationId!]: job,
            }));
          }
        }
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [activeConversationId, conversations, sending]);

  useEffect(() => {
    if (draftConversationRef.current === activeConversationId) return;
    draftConversationRef.current = activeConversationId;
    skipDraftWriteRef.current = true;
    setInput(readChatDraft(activeConversationId));
  }, [activeConversationId]);

  useEffect(() => {
    if (skipDraftWriteRef.current) {
      skipDraftWriteRef.current = false;
      return;
    }
    writeChatDraft(activeConversationId, input);
  }, [activeConversationId, input]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: reducedMotion ? "auto" : "smooth",
    });
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

  const startNewConversation = (replace = false) => {
    if (sending) return;
    clearProgressTimer();
    openConversation(null, { replace });
    setMessages([]);
    setInput("");
    setError(null);
    setNotice(null);
    setStopping(false);
    setChatProgress(null);
    setProgressAssistantMessageId(null);
    setOptimisticDraft(null);
    setFailedRequest(null);
    clearChatDraft(null);
    dispatchSend({ type: "reset" });
    setScopeMode("active");
    setSelectedSavedQueryId("");
    setMultiTenantPreflight(null);
    setPreflightPrompt("");
    setActiveMultiTenantJob(null);
    setBatchNotice(null);
  };

  useEffect(() => {
    if (new URLSearchParams(location.search).get("new") !== "1" || sending) return;
    startNewConversation(true);
    // The one-shot query is intentionally removed after resetting Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, navigate, sending]);

  useEffect(() => {
    const onNewConversation = () => startNewConversation();
    window.addEventListener(OPEN_NEW_CONVERSATION_EVENT, onNewConversation);
    return () => window.removeEventListener(OPEN_NEW_CONVERSATION_EVENT, onNewConversation);
  });

  const handleStopGeneration = async () => {
    const api = window.openAdminOS;
    if (!api || !sending || stopping) return;
    setStopping(true);
    dispatchSend({ type: "request-stop" });
    setError(null);
    setChatProgress(createStoppedChatProgress("Stopping response."));
    try {
      await api.cancelIntuneChatStream();
    } catch (caught) {
      setStopping(false);
      dispatchSend({ type: "stop-failed" });
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handleSend = async (
    contentOverride?: string,
    conversationIdOverride?: string | null,
  ) => {
    const content = (contentOverride ?? input).trim();
    const api = window.openAdminOS;
    if (!api || !content || sending) return;
    const targetConversationId =
      conversationIdOverride !== undefined
        ? conversationIdOverride
        : activeConversationId;
    if (
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "chat-send",
          conversationId: targetConversationId,
          returnTo: currentReturnTo(location.pathname, location.search),
        }),
      )
    ) {
      writeChatDraft(targetConversationId, content);
      setInput(content);
      return;
    }
    if (shouldUseMultiTenantFlow(content, scopeMode)) {
      await prepareMultiTenantReview(content);
      return;
    }
    const workspaceContext = buildWorkspaceContextInput();
    const contextSummary = workspaceContext ? workspaceContextSummary : undefined;
    if (
      provider &&
      activeTenant &&
      !provider.isLocal &&
      (requiresHostedChatConsent(provider, activeTenant) || Boolean(workspaceContext))
    ) {
      setHostedConsentPrompt({
        content,
        ...(conversationIdOverride !== undefined
          ? { conversationId: conversationIdOverride }
          : {}),
        tenantId: activeTenant.id,
        tenantName: activeTenant.displayName,
        providerId: provider.id,
        providerName: provider.name,
        ...(activeModel ? { model: activeModel } : {}),
        ...(workspaceContext ? { workspaceContext } : {}),
        ...(contextSummary ? { workspaceContextSummary: contextSummary } : {}),
      });
      setRememberHostedConsent(false);
      return;
    }
    await executeSend(
      content,
      rememberedHostedProviderConsent(provider, activeTenant),
      conversationIdOverride,
      workspaceContext,
    );
  };

  const buildTenantScope = (content: string): TenantScope => {
    if (scopeMode === "all" || detectsAllTenantPrompt(content)) {
      return {
        kind: "all",
        ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
      };
    }
    if (scopeMode === "selected") {
      return {
        kind: "selected",
        tenantIds: selectedTenantIds,
        ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
      };
    }
    return { kind: "active" };
  };

  const prepareMultiTenantReview = async (content: string) => {
    const api = window.openAdminOS;
    if (!api || runningMultiTenant) return;
    setError(null);
    setNotice(null);
    setMultiTenantPreflight(null);
    setPreflightPrompt(content);
    try {
      const preflight = await api.preflightMultiTenantIntuneChat({
        prompt: content,
        tenantScope: buildTenantScope(content),
        ...(selectedSavedQueryId ? { savedQueryId: selectedSavedQueryId } : {}),
      });
      setMultiTenantPreflight(preflight);
      setInput(content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const runMultiTenantQuery = async (
    consent?: NonNullable<RunMultiTenantChatInput["hostedProviderConsent"]>,
  ) => {
    const api = window.openAdminOS;
    const preflight = multiTenantPreflight;
    const content = preflightPrompt.trim();
    if (!api || !preflight || !content || runningMultiTenant) return;
    if (!preflight.providerIsLocal && !consent) {
      setHostedBatchConsentPrompt({ preflight, content });
      return;
    }
    setRunningMultiTenant(true);
    setError(null);
    setNotice(null);
    setBatchNotice(null);
    setActiveMultiTenantJob(null);
    try {
      const result = await api.streamMultiTenantIntuneChat(
        {
          prompt: content,
          tenantScope: preflight.tenantScope,
          savedQueryId: selectedSavedQueryId || undefined,
          refreshIfStale: true,
          ...(consent ? { hostedProviderConsent: consent } : {}),
        },
        (event: MultiTenantChatStreamEvent) => {
          if (event.type === "started" || event.type === "progress") {
            setActiveMultiTenantJob(event.job);
          }
          if (event.type === "completed") {
            setActiveMultiTenantJob(event.result.job);
          }
          if (event.type === "cancelled") {
            setActiveMultiTenantJob(event.job);
            setNotice("Multi-tenant query stopped.");
          }
          if (event.type === "failed") {
            setError(event.error);
          }
        },
      );
      if (result.job.conversationId) {
        setMultiTenantJobsByConversationId((current) => ({
          ...current,
          [result.job.conversationId!]: result.job,
        }));
        setExpandedTenantIds(result.job.comparisons.slice(0, 1).map((row) => row.tenantId));
      }
      setMultiTenantPreflight(null);
      setPreflightPrompt("");
      setInput("");
      setMessages([result.userMessage, result.assistantMessage]);
      setPendingConversation(result.conversation);
      upsertConversation(result.conversation);
      openConversation(result.conversation.id, { replace: true });
      await loadShell(result.conversation.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningMultiTenant(false);
      setActiveMultiTenantJob(null);
    }
  };


  const recordRelatedAgentSuggestion = (
    conversationId: string,
    assistantMessageId: string,
    suggestion: { agent: AgentSummary; score: number } | null,
  ) => {
    if (!suggestion) return;
    setRelatedAgentState((current) => {
      const existingSlugs = current.suggestedSlugsByConversationId[conversationId] ?? [];
      if (
        existingSlugs.includes(suggestion.agent.slug) ||
        current.suggestionsByMessageId[assistantMessageId]
      ) {
        return current;
      }
      return {
        suggestionsByMessageId: {
          ...current.suggestionsByMessageId,
          [assistantMessageId]: suggestion,
        },
        suggestedSlugsByConversationId: {
          ...current.suggestedSlugsByConversationId,
          [conversationId]: [...existingSlugs, suggestion.agent.slug],
        },
      };
    });
  };

  const dismissRelatedAgentSuggestion = (assistantMessageId: string) => {
    setRelatedAgentState((current) => {
      if (!current.suggestionsByMessageId[assistantMessageId]) return current;
      const nextSuggestions = { ...current.suggestionsByMessageId };
      delete nextSuggestions[assistantMessageId];
      return {
        ...current,
        suggestionsByMessageId: nextSuggestions,
      };
    });
  };

  const executeSend = async (
    content: string,
    hostedProviderConsent?: HostedProviderConsentInput,
    conversationIdOverride?: string | null,
    workspaceContext?: WorkspacePromptContextInput,
  ) => {
    const api = window.openAdminOS;
    if (!api || !content || sending) return;
    const targetConversationId =
      conversationIdOverride === null
        ? null
        : conversationIdOverride ?? activeConversationId;
    const previouslySuggestedSlugs = targetConversationId
      ? relatedAgentState.suggestedSlugsByConversationId[targetConversationId] ?? []
      : [];
    const relatedAgentSuggestion = suggestAgentForQuestion(
      content,
      state.installedAgents.filter(
        (agent) => !previouslySuggestedSlugs.includes(agent.slug),
      ),
    );
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
    dispatchSend({ type: "send" });
    setSending(true);
    setFailedRequest(null);
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
    clearChatDraft(targetConversationId);
    let failed = false;
    let cancelled = false;
    let reachedTerminal = false;
    try {
      const result = await api.streamIntuneChatMessage(
        {
          conversationId: targetConversationId ?? undefined,
          content,
          refreshIfStale: true,
          ...(hostedProviderConsent ? { hostedProviderConsent } : {}),
          ...(workspaceContext ? { workspaceContext } : {}),
        },
        (event) => {
          if (event.type === "started") {
            dispatchSend({ type: "stream" });
            setOptimisticDraft(null);
            setPendingConversation(event.conversation);
            upsertConversation(event.conversation);
            openConversation(event.conversation.id, { replace: true });
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
              reachedTerminal = true;
              failed = true;
              dispatchSend({ type: "fail" });
              setError(event.error);
              setFailedRequest({ content, conversationId: targetConversationId });
              setInput(content);
            }
            if (event.type === "completed") {
              reachedTerminal = true;
              dispatchSend({ type: "complete" });
              recordRelatedAgentSuggestion(
                event.result.conversation.id,
                event.result.assistantMessage.id,
                relatedAgentSuggestion,
              );
            }
            if (event.type === "cancelled") {
              reachedTerminal = true;
              cancelled = true;
              dispatchSend({ type: "stopped" });
              setChatProgress(createStoppedChatProgress("Response stopped."));
            }
          }
        },
      );
      setPendingConversation(result.conversation);
      upsertConversation(result.conversation);
      openConversation(result.conversation.id, { replace: true });
      setCacheStatus(result.cacheStatus);
      if (result.assistantMessage.status === "completed") {
        recordRelatedAgentSuggestion(
          result.conversation.id,
          result.assistantMessage.id,
          relatedAgentSuggestion,
        );
      }
      await loadShell(result.conversation.id);
    } catch (caught) {
      failed = true;
      setOptimisticDraft(null);
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      if (!reachedTerminal) dispatchSend({ type: "fail" });
      setError(errorMessage);
      setFailedRequest({ content, conversationId: targetConversationId });
      setInput(content);
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

  const handleRetryFailedSend = async () => {
    const request = failedRequest;
    if (!request || sending) return;
    setError(null);
    await handleSend(request.content, request.conversationId);
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
        pending.workspaceContextSummary,
      ),
      pending.conversationId,
      pending.workspaceContext,
    );
  };

  const confirmHostedBatchConsentAndRun = async () => {
    const prompt = hostedBatchConsentPrompt;
    if (!prompt) return;
    setHostedBatchConsentPrompt(null);
    await runMultiTenantQuery(
      createHostedBatchProviderConsent(prompt.preflight, new Date().toISOString()),
    );
  };

  useEffect(() => {
    const routeState = location.state as IntuneChatRouteState | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind === "chat-send" &&
      resumedIntentRef.current !== resumed.createdAt &&
      !loading &&
      activeTenant
    ) {
      resumedIntentRef.current = resumed.createdAt;
      const draft = readChatDraft(resumed.conversationId).trim();
      navigate(location.pathname, { replace: true, state: null });
      if (draft) {
        setInput(draft);
        void handleSend(draft, resumed.conversationId);
      }
      return;
    }
    const initialQuestion =
      typeof routeState?.initialQuestion === "string"
        ? routeState.initialQuestion.trim()
        : "";
    if (
      !initialQuestion ||
      initialQuestionConsumedRef.current ||
      loading ||
      !activeTenant
    ) {
      return;
    }

    initialQuestionConsumedRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    openConversation(null, { replace: true });
    setMessages([]);
    void handleSend(initialQuestion, null);
  }, [activeTenant, handleSend, loading, location.pathname, location.state, navigate]);

  const applySavedQuery = (query: SavedMultiTenantQuery) => {
    setSelectedSavedQueryId(query.id);
    setInput(query.prompt);
    if (query.defaultScope?.kind === "all") {
      setScopeMode("all");
    } else if (query.defaultScope?.kind === "selected") {
      setScopeMode("selected");
      if (query.defaultScope.tenantIds.length > 0) {
        setSelectedTenantIds(query.defaultScope.tenantIds);
      }
    }
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const toggleTenantSelection = (tenantId: string) => {
    setSelectedTenantIds((current) =>
      current.includes(tenantId)
        ? current.filter((id) => id !== tenantId)
        : [...current, tenantId],
    );
  };

  const toggleGroupSelection = (groupId: string) => {
    setSelectedGroupIds((current) =>
      current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId],
    );
  };

  const saveCurrentTenantGroup = async () => {
    const api = window.openAdminOS;
    if (!api || !groupName.trim()) return;
    const tenantIds = multiTenantPreflight?.resolvedTenantIds ?? selectedTenantIds;
    if (tenantIds.length === 0) {
      setError("Select at least one tenant before saving a group.");
      return;
    }
    try {
      const group = await api.saveTenantGroup({
        name: groupName,
        tenantIds,
      });
      setTenantGroups(await api.listTenantGroups());
      setSelectedGroupIds((current) => [...new Set([...current, group.id])]);
      setGroupName("");
      setNotice(`Saved tenant group ${group.name}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const queueMultiTenantAgentBatch = async () => {
    const api = window.openAdminOS;
    const preflight = multiTenantPreflight;
    if (!api || !preflight || !selectedBatchAgentSlug || runningMultiTenant) return;
    setError(null);
    setBatchNotice(null);
    try {
      const result = await api.queueMultiTenantAgentBatch({
        agentSlug: selectedBatchAgentSlug,
        tenantScope: preflight.tenantScope,
        savedQueryId: selectedSavedQueryId || undefined,
        prompt: preflight.prompt,
      });
      setBatchNotice(
        `Queued ${result.runs.length} tenant-pinned run${result.runs.length === 1 ? "" : "s"}.`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const exportMultiTenantJob = async (
    job: MultiTenantChatJob,
    format: "md" | "json" | "csv",
  ) => {
    const api = window.openAdminOS;
    if (!api) return;
    const content =
      format === "json"
        ? `${JSON.stringify(job, null, 2)}\n`
        : format === "csv"
          ? buildDeviceCsv(job)
          : job.exportDossierMarkdown;
    const extension = format === "json" ? "json" : format === "csv" ? "csv" : "md";
    const result = await api.saveTextFile({
      suggestedName: `${safeFileName(job.prompt)}.${extension}`,
      content,
      filters: [
        {
          name: format === "json" ? "JSON" : format === "csv" ? "CSV" : "Markdown",
          extensions: [extension],
        },
      ],
    });
    if (!result.canceled) {
      setNotice(result.filePath ? `Exported result to ${result.filePath}.` : "Exported result.");
    }
  };

  const importSplitJob = async () => {
    const api = window.openAdminOS;
    const job = splitJob;
    if (!api || !job) return;
    try {
      const result = await api.importMultiTenantResultToWorkspaces({
        jobId: job.id,
        tenantMappings: job.comparisons
          .filter((tenant) => tenant.windowsDevices > 0 || tenant.status === "stale")
          .map((tenant) => ({
            tenantId: tenant.tenantId,
            title: `${tenant.tenantName} · ${job.prompt.slice(0, 80)}`,
          })),
      });
      setSplitResult(result);
      setNotice(
        `Created ${result.evidence.length} tenant-specific workspace evidence entr${result.evidence.length === 1 ? "y" : "ies"}.`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
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
        openConversation(null, { replace: true });
        await loadShell();
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
    if (
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "agent-run",
          slug,
          returnTo: currentReturnTo(location.pathname, location.search),
        }),
      )
    ) {
      return;
    }
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
    openConversation(message.conversationId);
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
    openConversation(message.conversationId);
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

  const handleCreateWorkspaceFromConversation = async () => {
    const api = window.openAdminOS;
    if (!api || !activeConversation || activeConversation.scopeKind === "multi-tenant") return;
    setError(null);
    setNotice(null);
    try {
      const workspace = await api.createWorkspace({
        title: activeConversation.title,
        ...(activeConversation.tenantId ? { tenantId: activeConversation.tenantId } : {}),
        conversationId: activeConversation.id,
      });
      setNotice(`Created workspace ${workspace.title} and linked this conversation.`);
      if (activeTenant) {
        setWorkspaces(await api.listWorkspaces(activeTenant.id));
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

  const handlePinMessageToWorkspace = async () => {
    const api = window.openAdminOS;
    const message = pinTarget;
    const workspaceId = pinWorkspaceId || workspaces[0]?.id;
    if (!api || !message || !workspaceId || !activeTenant) return;
    setError(null);
    setNotice(null);
    try {
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      const evidence = await api.pinWorkspaceEvidence({
        workspaceId,
        tenantId: activeTenant.id,
        title: `Chat answer · ${formatDateTime(message.createdAt)}`,
        sourceType: "chat-message",
        sourceRef: {
          conversationId: message.conversationId,
          messageId: message.id,
        },
        content: {
          role: message.role,
          content: message.content,
          sources: message.sources ?? [],
          agentSuggestions: message.agentSuggestions ?? [],
        },
        ...(message.sources?.[0]?.refreshedAt
          ? {
              freshness: {
                resource: message.sources[0].resource,
                refreshedAt: message.sources[0].refreshedAt,
                rowCount: message.sources[0].rows,
                cacheStatus: message.sources[0].source,
              },
            }
          : {}),
      });
      setNotice(
        `Pinned evidence to ${workspace?.title ?? "workspace"} as ${evidence.title}.`,
      );
      setPinTarget(null);
      setPinWorkspaceId("");
      setWorkspaces(await api.listWorkspaces(activeTenant.id));
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

  const activeConversation =
    conversations.find(
      (conversation) => conversation.id === activeConversationId,
    ) ??
    (pendingConversation && pendingConversation.id === activeConversationId
      ? pendingConversation
      : undefined);
  const unknownConversation = Boolean(
    shellLoaded &&
      routeConversationId &&
      conversationSearch.trim() === "" &&
      !activeConversation,
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
      aria-label={`Open conversation ${conversation.title}. Updated ${formatDateTime(conversation.updatedAt)}`}
      title={conversation.title}
      onClick={() => {
        openConversation(conversation.id);
        if (historyIsOverlay) {
          setHistoryOpen(false);
          window.requestAnimationFrame(() => historyToggleRef.current?.focus());
        }
      }}
      onContextMenu={(event) => openConversationContextMenu(event, conversation)}
      className={`mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors ${focusRingClass} ${
        activeConversationId === conversation.id
          ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
          : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
    >
      <div className="truncate text-[12.5px] font-medium">
        {conversation.pinnedAt && (
          <IconStar
            size={10}
            className="mr-1 inline align-[-1px] text-[var(--color-text-muted)]"
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
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
      {historyIsOverlay && historyOpen && (
        <button
          type="button"
          aria-label="Close chat history"
          onClick={() => {
            setHistoryOpen(false);
            window.requestAnimationFrame(() => historyToggleRef.current?.focus());
          }}
          className="absolute inset-0 z-20 border-0 bg-black/55"
        />
      )}
      <aside
        aria-label="Chat history"
        aria-hidden={!historyOpen}
        inert={!historyOpen}
        className={`flex min-h-0 flex-col bg-[var(--color-sidebar-solid)] transition-[transform,width] duration-150 ${
          historyIsOverlay
            ? `absolute inset-y-0 left-0 z-30 w-[284px] border-r border-[var(--color-border-soft)] shadow-[18px_0_48px_rgba(0,0,0,0.42)] ${historyOpen ? "translate-x-0" : "-translate-x-full"}`
            : historyOpen
              ? "relative w-[284px] shrink-0 border-r border-[var(--color-border-soft)]"
              : "relative w-0 shrink-0 overflow-hidden border-r-0"
        }`}
      >
        <div className="px-4 pb-3 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Conversations
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
                onClick={() => {
                  setHistoryOpen(false);
                  window.requestAnimationFrame(() => historyToggleRef.current?.focus());
                }}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${focusRingClass}`}
              >
                <IconArrowLeft size={13} />
              </button>
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<IconPlus size={12} />}
                disabled={sending}
                onClick={() => {
                  startNewConversation();
                  if (historyIsOverlay) setHistoryOpen(false);
                }}
              >
                New
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="sticky top-0 z-10 bg-[var(--color-sidebar-solid)] pb-2">
            <div className="relative">
              <IconSearch
                size={13}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <label htmlFor="conversation-search" className="sr-only">
                Search conversations
              </label>
              <input
                id="conversation-search"
                ref={historySearchRef}
                name="conversation-search"
                type="search"
                value={conversationSearch}
                onChange={(event) => setConversationSearch(event.target.value)}
                placeholder="Search conversations"
                autoComplete="off"
                className="h-8 w-full rounded-md bg-[var(--color-bg-raised)] pl-8 pr-2 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-placeholder)] focus:ring-[var(--color-accent)]"
              />
            </div>
          </div>
          {draftConversationActive && (
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                startNewConversation();
                if (historyIsOverlay) setHistoryOpen(false);
              }}
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
                      <IconStar size={10} className="text-[var(--color-text-muted)]" />
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
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border-soft)] px-6">
          <div className="flex min-w-0 items-center gap-3">
            {!historyOpen && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  ref={historyToggleRef}
                  title="Show chat history"
                  aria-label="Show chat history"
                  onClick={() => {
                    setHistoryOpen(true);
                    window.requestAnimationFrame(() => historySearchRef.current?.focus());
                  }}
                  className={`flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-bg-raised)] px-2.5 text-[11px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${focusRingClass}`}
                >
                  <IconChevronRight size={13} />
                  History
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="New conversation"
                  leadingIcon={<IconPlus size={12} />}
                  disabled={sending}
                  onClick={() => startNewConversation()}
                >
                  New
                </Button>
              </div>
            )}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <IconChat size={16} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
                {activeConversation?.pinnedAt && (
                  <IconStar
                    size={11}
                    className="mr-1.5 inline align-[-1px] text-[var(--color-text-muted)]"
                  />
                )}
                {unknownConversation
                  ? "Conversation not found"
                  : activeConversation?.title ?? "New conversation"}
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
                {activeConversation.scopeKind !== "multi-tenant" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<IconHardDrive size={12} />}
                    disabled={sending}
                    onClick={() => void handleCreateWorkspaceFromConversation()}
                  >
                    Workspace
                  </Button>
                )}
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
            {unknownConversation ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div
                  role="status"
                  className="w-full max-w-[520px] rounded-xl bg-[var(--color-bg-raised)] p-6 text-center ring-1 ring-[var(--color-border)]"
                >
                  <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                    <IconChat size={18} />
                  </div>
                  <h1 className="text-[17px] font-semibold text-[var(--color-text)]">
                    Conversation not found
                  </h1>
                  <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-5 text-[var(--color-text-muted)]">
                    It may have been deleted, or this link belongs to another local profile.
                    No tenant data was changed.
                  </p>
                  <Button
                    className="mt-5"
                    variant="primary"
                    leadingIcon={<IconPlus size={12} />}
                    onClick={() => startNewConversation(true)}
                  >
                    Start a new conversation
                  </Button>
                </div>
              </div>
            ) : multiTenantPreflight ? (
              <div className="flex flex-1 flex-col justify-center gap-6 py-8">
                <ScopeReviewCard
                  preflight={multiTenantPreflight}
                  progressJob={activeMultiTenantJob}
                  groupName={groupName}
                  onGroupNameChange={setGroupName}
                  onSaveGroup={() => void saveCurrentTenantGroup()}
                  onCancel={() => {
                    setMultiTenantPreflight(null);
                    setPreflightPrompt("");
                    setActiveMultiTenantJob(null);
                    setBatchNotice(null);
                  }}
                  onRun={() => void runMultiTenantQuery()}
                  running={runningMultiTenant}
                  installedAgents={state.installedAgents}
                  selectedBatchAgentSlug={selectedBatchAgentSlug}
                  onSelectedBatchAgentSlugChange={setSelectedBatchAgentSlug}
                  onQueueBatch={() => void queueMultiTenantAgentBatch()}
                  batchNotice={batchNotice}
                />
              </div>
            ) : displayedMessages.length === 0 ? (
              chatProgress ? (
                <div className="flex flex-1 flex-col justify-center gap-6 py-16">
                  <ChatProgressCard progress={chatProgress} />
                </div>
              ) : (
              <EmptyChat
                disabled={sending}
                onPrompt={(prompt) => {
                  setInput(prompt);
                  writeChatDraft(activeConversationId, prompt);
                  window.requestAnimationFrame(() => composerRef.current?.focus());
                }}
              />
              )
            ) : (
              <div className="flex flex-1 flex-col gap-6">
                {displayedMessages.map((message) => {
                  const job = multiTenantJobsByConversationId[message.conversationId];
                  const relatedAgentSuggestion =
                    message.role === "assistant" &&
                    message.status === "completed"
                      ? relatedAgentState.suggestionsByMessageId[message.id]
                      : undefined;
                  return (
                    <div key={message.id} className="space-y-4">
                      <ChatMessageBubble
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
                        pinDisabled={
                          !activeTenant ||
                          activeConversation?.scopeKind === "multi-tenant" ||
                          workspaces.length === 0 ||
                          message.status !== "completed"
                        }
                        onPin={() => {
                          setPinTarget(message);
                          setPinWorkspaceId(attachedWorkspaceId || workspaces[0]?.id || "");
                        }}
                      />
                      {relatedAgentSuggestion && (
                        <RelatedAgentHint
                          suggestion={relatedAgentSuggestion}
                          onOpen={() => navigate(`/agents/${relatedAgentSuggestion.agent.slug}`)}
                          onDismiss={() => dismissRelatedAgentSuggestion(message.id)}
                        />
                      )}
                      {message.role === "assistant" && job && (
                        <MultiTenantResultArtifact
                          job={job}
                          filters={multiTenantFilters}
                          onFiltersChange={setMultiTenantFilters}
                          expandedTenantIds={expandedTenantIds}
                          onToggleTenant={(tenantId) =>
                            setExpandedTenantIds((current) =>
                              current.includes(tenantId)
                                ? current.filter((id) => id !== tenantId)
                                : [...current, tenantId],
                            )
                          }
                          onExport={(format) => void exportMultiTenantJob(job, format)}
                          onSplit={() => {
                            setSplitJob(job);
                            setSplitResult(null);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
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
              <div
                role="alert"
                className="mb-3 flex items-start justify-between gap-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {failedRequest ? chatErrorCopy(error).what : "The requested action could not be completed."}
                  </div>
                  <div className="mt-0.5 break-words text-[var(--color-text-soft)]">
                    {chatErrorCopy(error).why ??
                      "Retry the action. If it still fails, review the provider and tenant connection in Settings."}
                  </div>
                </div>
                {failedRequest && (
                  <Button size="sm" variant="secondary" onClick={() => void handleRetryFailedSend()}>
                    {chatErrorCopy(error).action.label}
                  </Button>
                )}
              </div>
            )}
            {notice && (
              <div className="mb-3 rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
                {notice}
              </div>
            )}
            <MultiTenantComposerControls
              scopeMode={scopeMode}
              onScopeModeChange={setScopeMode}
              tenants={state.tenants}
              activeTenantId={state.activeTenantId}
              selectedTenantIds={selectedTenantIds}
              onToggleTenant={toggleTenantSelection}
              tenantGroups={tenantGroups}
              selectedGroupIds={selectedGroupIds}
              onToggleGroup={toggleGroupSelection}
              savedQueries={savedQueries}
              selectedSavedQueryId={selectedSavedQueryId}
              onSavedQuery={applySavedQuery}
              disabled={unknownConversation || sending || runningMultiTenant}
            />
            <WorkspaceContextControls
              workspaces={workspaces}
              workspace={attachedWorkspace}
              attachedWorkspaceId={attachedWorkspaceId}
              onWorkspaceChange={setAttachedWorkspaceId}
              selectedEvidenceIds={selectedWorkspaceEvidenceIds}
              onToggleEvidence={(id) =>
                setSelectedWorkspaceEvidenceIds((current) =>
                  current.includes(id)
                    ? current.filter((entry) => entry !== id)
                    : [...current, id],
                )
              }
              selectedNoteIds={selectedWorkspaceNoteIds}
              onToggleNote={(id) =>
                setSelectedWorkspaceNoteIds((current) =>
                  current.includes(id)
                    ? current.filter((entry) => entry !== id)
                    : [...current, id],
                )
              }
              includeInstructions={includeWorkspaceInstructions}
              onIncludeInstructionsChange={setIncludeWorkspaceInstructions}
              disabled={unknownConversation || sending || runningMultiTenant}
            />
            <div className="intune-chat-composer rounded-xl bg-[var(--color-bg-raised)] p-2 ring-1 ring-[var(--color-border)] focus-within:ring-[var(--color-accent)]">
              {!activeTenant && (
                <div className="mx-1 mb-1 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[11.5px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                  {SETUP_COPY.guestChatHint}
                </div>
              )}
              <label htmlFor="intune-chat-composer" className="sr-only">
                {CHAT_COPY.composerLabel}
              </label>
              <textarea
                id="intune-chat-composer"
                name="intune-chat-composer"
                ref={composerRef}
                disabled={unknownConversation}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (shouldSubmitComposerKey(event.nativeEvent)) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={activeTenant ? CHAT_COPY.composerPlaceholder : SETUP_COPY.guestComposerPlaceholder}
                className="max-h-[180px] min-h-[72px] w-full resize-none bg-transparent px-2 py-2 text-[13.5px] leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus-visible:outline-none"
              />
              <div className="flex items-center justify-between gap-3 px-1 pb-1">
                <div className="truncate text-[11px] text-[var(--color-text-muted)]">
                  {workspaceContextSummary
                    ? `Workspace context selected: ${workspaceContextSummary.evidenceCount} evidence, ${workspaceContextSummary.noteCount} notes.`
                    : provider?.isLocal
                      ? CHAT_COPY.localBoundary
                      : CHAT_COPY.hostedBoundary}
                </div>
                {sending ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<IconClose size={12} />}
                    disabled={stopping}
                    onClick={() => void handleStopGeneration()}
                  >
                    {stopping ? COMMON_COPY.actions.stopping : COMMON_COPY.actions.stop}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={unknownConversation || input.trim().length === 0}
                    onClick={() => void handleSend()}
                  >
                    {COMMON_COPY.actions.send}
                  </Button>
                )}
              </div>
            </div>
            <div
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {sendState.phase === "failed" ? "" : sendState.announcement}
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
      <HostedBatchConsentModal
        prompt={hostedBatchConsentPrompt}
        onClose={() => setHostedBatchConsentPrompt(null)}
        onConfirm={() => void confirmHostedBatchConsentAndRun()}
      />
      <SplitToWorkspacesModal
        job={splitJob}
        result={splitResult}
        onClose={() => {
          setSplitJob(null);
          setSplitResult(null);
        }}
        onConfirm={() => void importSplitJob()}
      />
      <PinMessageToWorkspaceModal
        message={pinTarget}
        workspaces={workspaces}
        selectedWorkspaceId={pinWorkspaceId}
        onWorkspaceChange={setPinWorkspaceId}
        onClose={() => {
          setPinTarget(null);
          setPinWorkspaceId("");
        }}
        onConfirm={() => void handlePinMessageToWorkspace()}
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

function MultiTenantComposerControls({
  scopeMode,
  onScopeModeChange,
  tenants,
  activeTenantId,
  selectedTenantIds,
  onToggleTenant,
  tenantGroups,
  selectedGroupIds,
  onToggleGroup,
  savedQueries,
  selectedSavedQueryId,
  onSavedQuery,
  disabled,
}: {
  scopeMode: MultiTenantScopeMode;
  onScopeModeChange: (mode: MultiTenantScopeMode) => void;
  tenants: TenantRecord[];
  activeTenantId?: string;
  selectedTenantIds: string[];
  onToggleTenant: (tenantId: string) => void;
  tenantGroups: TenantGroup[];
  selectedGroupIds: string[];
  onToggleGroup: (groupId: string) => void;
  savedQueries: SavedMultiTenantQuery[];
  selectedSavedQueryId: string;
  onSavedQuery: (query: SavedMultiTenantQuery) => void;
  disabled: boolean;
}) {
  const savedQuerySelectId = useId();

  return (
    <div className="mb-3 rounded-xl bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div
        role="group"
        aria-label="Tenant scope"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Scope
        </span>
        {(["active", "selected", "all"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => onScopeModeChange(mode)}
            className={`h-7 rounded-md px-2.5 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRingClass} ${
              scopeMode === mode
                ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                : "bg-[var(--color-bg)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] hover:text-[var(--color-text)]"
            }`}
          >
            {mode === "active"
              ? "Active tenant"
              : mode === "selected"
                ? "Selected tenants"
                : "All connected tenants"}
          </button>
        ))}
        <div className="ml-auto min-w-[180px]">
          <label htmlFor={savedQuerySelectId} className="sr-only">
            Saved multi-tenant query
          </label>
          <Select
            id={savedQuerySelectId}
            name="saved-multi-tenant-query"
            value={selectedSavedQueryId}
            disabled={disabled}
            onChange={(event) => {
              const query = savedQueries.find((entry) => entry.id === event.target.value);
              if (query) onSavedQuery(query);
            }}
            className="h-7 w-full rounded-md bg-[var(--color-bg)] px-2 text-[11.5px] text-[var(--color-text-soft)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          >
            <option value="">Saved queries</option>
            {savedQueries.map((query) => (
              <option key={query.id} value={query.id}>
                {query.title}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {scopeMode === "selected" && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Tenants
            </div>
            <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {tenants.map((tenant) => (
                <button
                  key={tenant.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleTenant(tenant.id)}
                  className={`rounded-md px-2 py-1 text-[11px] transition-colors ${focusRingClass} ${
                    selectedTenantIds.includes(tenant.id)
                      ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                      : tenant.id === activeTenantId
                        ? "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
                        : "bg-[var(--color-bg)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {tenant.displayName}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Groups
            </div>
            <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto pr-1">
              {tenantGroups.length === 0 ? (
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  Groups can be saved during scope review.
                </span>
              ) : (
                tenantGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onToggleGroup(group.id)}
                    className={`rounded-md px-2 py-1 text-[11px] transition-colors ${focusRingClass} ${
                      selectedGroupIds.includes(group.id)
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                        : "bg-[var(--color-bg)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {group.name}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceContextControls({
  workspaces,
  workspace,
  attachedWorkspaceId,
  onWorkspaceChange,
  selectedEvidenceIds,
  onToggleEvidence,
  selectedNoteIds,
  onToggleNote,
  includeInstructions,
  onIncludeInstructionsChange,
  disabled,
}: {
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceDetail | null;
  attachedWorkspaceId: string;
  onWorkspaceChange: (id: string) => void;
  selectedEvidenceIds: string[];
  onToggleEvidence: (id: string) => void;
  selectedNoteIds: string[];
  onToggleNote: (id: string) => void;
  includeInstructions: boolean;
  onIncludeInstructionsChange: (include: boolean) => void;
  disabled: boolean;
}) {
  const workspaceSelectId = useId();
  if (workspaces.length === 0) return null;
  const hasAttachment =
    Boolean(workspace) &&
    (selectedEvidenceIds.length > 0 ||
      selectedNoteIds.length > 0 ||
      (includeInstructions && Boolean(workspace?.instructions?.trim())));
  return (
    <div className="mb-3 rounded-xl bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Workspace context
        </span>
        <label htmlFor={workspaceSelectId} className="sr-only">
          Attach workspace context
        </label>
        <Select
          id={workspaceSelectId}
          name="attached-workspace-context"
          value={attachedWorkspaceId}
          disabled={disabled}
          onChange={(event) => onWorkspaceChange(event.target.value)}
          className="h-7 min-w-[220px] rounded-md bg-[var(--color-bg)] px-2 text-[11.5px] text-[var(--color-text-soft)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">No workspace attached</option>
          {workspaces.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
            </option>
          ))}
        </Select>
        {hasAttachment && <Pill tone="accent">Attached</Pill>}
        {!attachedWorkspaceId && (
          <div className="flex flex-wrap gap-1.5">
            {workspaces.slice(0, 3).map((entry) => (
              <button
                key={entry.id}
                type="button"
                disabled={disabled}
                onClick={() => onWorkspaceChange(entry.id)}
                className="rounded-md bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {entry.title}
              </button>
            ))}
          </div>
        )}
      </div>
      {workspace && (
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg bg-[var(--color-bg)] p-2 ring-1 ring-[var(--color-border-soft)]">
            <label className="flex cursor-pointer items-start gap-2 text-[11.5px] leading-5 text-[var(--color-text-soft)]">
              <input
                type="checkbox"
                checked={includeInstructions && Boolean(workspace.instructions?.trim())}
                disabled={disabled || !workspace.instructions?.trim()}
                onChange={(event) => onIncludeInstructionsChange(event.target.checked)}
                className="mt-1 h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              <span>
                Instructions
                <span className="block text-[10.5px] text-[var(--color-text-muted)]">
                  {workspace.instructions?.trim()
                    ? "Include workspace instructions"
                    : "No instructions saved"}
                </span>
              </span>
            </label>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-2 ring-1 ring-[var(--color-border-soft)]">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Evidence
            </div>
            <div className="max-h-20 space-y-1 overflow-y-auto pr-1">
              {workspace.evidence.length === 0 ? (
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  No evidence pinned
                </span>
              ) : (
                workspace.evidence.slice(0, 12).map((entry) => (
                  <label
                    key={entry.id}
                    className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedEvidenceIds.includes(entry.id)}
                      disabled={disabled}
                      onChange={() => onToggleEvidence(entry.id)}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 truncate">{entry.title}</span>
                  </label>
                ))
              )}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-2 ring-1 ring-[var(--color-border-soft)]">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Notes
            </div>
            <div className="max-h-20 space-y-1 overflow-y-auto pr-1">
              {workspace.notes.length === 0 ? (
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  No notes saved
                </span>
              ) : (
                workspace.notes.slice(0, 12).map((note) => (
                  <label
                    key={note.id}
                    className="flex cursor-pointer items-center gap-2 text-[11.5px] text-[var(--color-text-soft)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedNoteIds.includes(note.id)}
                      disabled={disabled}
                      onChange={() => onToggleNote(note.id)}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 truncate">{note.content}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeReviewCard({
  preflight,
  progressJob,
  groupName,
  onGroupNameChange,
  onSaveGroup,
  onCancel,
  onRun,
  running,
  installedAgents,
  selectedBatchAgentSlug,
  onSelectedBatchAgentSlugChange,
  onQueueBatch,
  batchNotice,
}: {
  preflight: TenantScopePreflight;
  progressJob: MultiTenantChatJob | null;
  groupName: string;
  onGroupNameChange: (value: string) => void;
  onSaveGroup: () => void;
  onCancel: () => void;
  onRun: () => void;
  running: boolean;
  installedAgents: { slug: string; name: string; mode: "read" | "write" }[];
  selectedBatchAgentSlug: string;
  onSelectedBatchAgentSlugChange: (slug: string) => void;
  onQueueBatch: () => void;
  batchNotice: string | null;
}) {
  const blocked = preflight.tenants.filter((tenant) =>
    ["expired", "missing-scopes", "throttled", "failed"].includes(tenant.status),
  );
  const selectedBatchAgent = installedAgents.find(
    (agent) => agent.slug === selectedBatchAgentSlug,
  );
  return (
    <div className="mx-auto w-full max-w-[920px] rounded-xl bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <div className="border-b border-[var(--color-border-soft)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-[var(--color-text)]">
              Review multi-tenant scope
            </div>
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {preflight.resolvedTenantIds.length} tenant{preflight.resolvedTenantIds.length === 1 ? "" : "s"} · {preflight.providerName}
              {preflight.model ? ` · ${preflight.model}` : ""}
            </div>
          </div>
          <Pill tone={preflight.providerIsLocal ? "success" : "warning"}>
            {preflight.providerIsLocal ? "Local provider" : "Hosted confirmation required"}
          </Pill>
        </div>
        <div className="mt-3 rounded-lg bg-[var(--color-bg)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          {preflight.prompt}
        </div>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0 overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
          <table className="w-full table-fixed text-left text-[12px]">
            <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Tenant</th>
                <th className="w-28 px-3 py-2">Readiness</th>
                <th className="w-36 px-3 py-2">Freshness</th>
                <th className="px-3 py-2">Recovery</th>
              </tr>
            </thead>
            <tbody>
              {preflight.tenants.map((tenant) => (
                <tr key={tenant.tenantId} className="border-t border-[var(--color-border-soft)]">
                  <td className="min-w-0 px-3 py-2">
                    <div className="truncate font-medium text-[var(--color-text)]" title={tenant.tenantName}>
                      {tenant.tenantName}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--color-text-muted)]">
                      {tenant.username ?? tenant.tenantId}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ReadinessPill status={tenant.status} />
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
                    {tenant.cacheFreshness ? formatDateTime(tenant.cacheFreshness) : "No cache"}
                  </td>
                  <td className="px-3 py-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                    {tenant.recovery}
                    {tenant.missingScopes.length > 0 && (
                      <div className="mt-1 font-mono text-[10px] text-[var(--color-warning)]">
                        {tenant.missingScopes.slice(0, 2).join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          {progressJob && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Run progress
                </div>
                <Pill tone={progressJob.status === "partial" ? "warning" : "accent"}>
                  {progressJob.status}
                </Pill>
              </div>
              <div className="space-y-1.5">
                {progressJob.progress.map((entry) => (
                  <div
                    key={entry.tenantId}
                    className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-[11px] ring-1 ring-[var(--color-border-soft)]"
                  >
                    <span className="min-w-0 truncate text-[var(--color-text-soft)]">
                      {entry.tenantName}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                      {entry.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Resources
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {preflight.resources.map((resource) => (
                <Pill key={resource}>{chatResourceLabel(resource)}</Pill>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Save group
            </div>
            <div className="mt-2 flex gap-2">
              <label htmlFor="tenant-group-name" className="sr-only">
                Tenant group name
              </label>
              <input
                id="tenant-group-name"
                name="tenant-group-name"
                value={groupName}
                onChange={(event) => onGroupNameChange(event.target.value)}
                placeholder="Tenant group name"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-md bg-[var(--color-bg-raised)] px-2 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
              />
              <Button size="sm" variant="secondary" disabled={!groupName.trim()} onClick={onSaveGroup}>
                Save
              </Button>
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Agent batch
            </div>
            <div className="mt-2 flex gap-2">
              <Select
                value={selectedBatchAgentSlug}
                onChange={(event) => onSelectedBatchAgentSlugChange(event.target.value)}
                disabled={running || installedAgents.length === 0}
                className="min-w-0 flex-1 rounded-md bg-[var(--color-bg-raised)] px-2 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Agent to queue for selected tenants"
              >
                <option value="">Select agent</option>
                {installedAgents.map((agent) => (
                  <option key={agent.slug} value={agent.slug}>
                    {formatAgentDisplayName(agent)} · {agent.mode}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                disabled={!selectedBatchAgentSlug || running || !preflight.canRun}
                onClick={onQueueBatch}
              >
                Queue
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
              Queues one tenant-pinned run per ready tenant.
              {selectedBatchAgent?.mode === "write"
                ? " Write runs still pause for per-run typed confirmation."
                : " Read runs start with the normal run history."}
            </p>
            {batchNotice && (
              <div className="mt-2 rounded-md bg-[var(--color-success-soft)] px-2 py-1.5 text-[11px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
                {batchNotice}
              </div>
            )}
          </div>
          {blocked.length > 0 && (
            <div className="rounded-lg bg-[var(--color-warning-soft)] p-3 text-[11.5px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
              {blocked.length} tenant{blocked.length === 1 ? "" : "s"} will be skipped unless recovered.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={running}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onRun} disabled={!preflight.canRun || running}>
              {running ? "Running" : "Run read-only query"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadinessPill({ status }: { status: string }) {
  const tone =
    status === "ready"
      ? "success"
      : status === "stale"
        ? "warning"
        : status === "skipped"
          ? "default"
          : "danger";
  return <Pill tone={tone}>{statusLabel(status)}</Pill>;
}

function MultiTenantResultArtifact({
  job,
  filters,
  onFiltersChange,
  expandedTenantIds,
  onToggleTenant,
  onExport,
  onSplit,
}: {
  job: MultiTenantChatJob;
  filters: MultiTenantFilterState;
  onFiltersChange: (filters: MultiTenantFilterState) => void;
  expandedTenantIds: string[];
  onToggleTenant: (tenantId: string) => void;
  onExport: (format: "md" | "json" | "csv") => void;
  onSplit: () => void;
}) {
  const filteredRows = job.deviceRows.filter((row) => {
    if (filters.tenantId !== "all" && row.tenantId !== filters.tenantId) return false;
    if (
      filters.complianceState !== "all" &&
      normalizeComplianceLabel(row.complianceState) !== filters.complianceState
    ) {
      return false;
    }
    if (filters.os !== "all" && row.operatingSystem !== filters.os) return false;
    if (filters.staleOnly && !row.stale) return false;
    return true;
  });
  const visibleComparisons = job.comparisons.filter((comparison) => {
    if (filters.tenantId !== "all" && comparison.tenantId !== filters.tenantId) return false;
    if (filters.readiness !== "all" && comparison.status !== filters.readiness) return false;
    return true;
  });
  const osOptions = [...new Set(job.deviceRows.map((row) => row.operatingSystem))].sort();
  const comparisonColumns: OutputTableColumn<MultiTenantChatJob["comparisons"][number]>[] = [
    {
      id: "tenant",
      header: "Tenant",
      sticky: true,
      sortValue: (tenant) => tenant.tenantName,
      render: (tenant) => {
        const expanded = expandedTenantIds.includes(tenant.tenantId);
        return (
          <button
            type="button"
            onClick={() => onToggleTenant(tenant.tenantId)}
            className={`inline-flex max-w-[240px] items-center gap-1.5 truncate text-left font-medium text-[var(--color-text)] hover:text-[var(--color-accent)] ${focusRingClass}`}
            aria-expanded={expanded}
          >
            {expanded ? <IconChevronDown size={12} aria-hidden="true" /> : <IconChevronRight size={12} aria-hidden="true" />}
            <span className="truncate" title={tenant.tenantName}>
              {tenant.tenantName}
            </span>
          </button>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      sortValue: (tenant) => tenant.status,
      render: (tenant) => <ReadinessPill status={tenant.status} />,
    },
    {
      id: "windows",
      header: "Windows",
      align: "right",
      sortValue: (tenant) => tenant.windowsDevices,
      render: (tenant) => tenant.windowsDevices.toLocaleString(),
      cellClassName: "font-mono tabular-nums",
    },
    {
      id: "compliant",
      header: "Compliant",
      align: "right",
      sortValue: (tenant) => tenant.compliant,
      render: (tenant) => tenant.compliant.toLocaleString(),
      cellClassName: "font-mono tabular-nums text-[var(--color-success)]",
    },
    {
      id: "nonCompliant",
      header: "Non-compliant",
      align: "right",
      sortValue: (tenant) => tenant.nonCompliant,
      render: (tenant) => tenant.nonCompliant.toLocaleString(),
      cellClassName: "font-mono tabular-nums text-[var(--color-danger)]",
    },
    {
      id: "unknown",
      header: "Unknown",
      align: "right",
      sortValue: (tenant) => tenant.unknown,
      render: (tenant) => tenant.unknown.toLocaleString(),
      cellClassName: "font-mono tabular-nums",
    },
    {
      id: "lastRefresh",
      header: "Last refresh",
      sortValue: (tenant) => tenant.lastRefresh ?? "",
      render: (tenant) => (tenant.lastRefresh ? formatDateTime(tenant.lastRefresh) : "Unknown"),
      cellClassName: "text-[11px] text-[var(--color-text-muted)]",
    },
  ];

  return (
    <OutputPane
      title="Multi-tenant result"
      subtitle={`${job.providerName}${job.model ? ` · ${job.model}` : ""} · ${formatDateTime(job.updatedAt)}`}
      className="relative left-1/2 w-[min(100%,calc(100vw-380px))] -translate-x-1/2"
      actions={
        <>
          <Button size="sm" variant="ghost" aria-label="Export multi-tenant result as CSV" onClick={() => onExport("csv")}>
            CSV
          </Button>
          <Button size="sm" variant="ghost" aria-label="Export multi-tenant result as JSON" onClick={() => onExport("json")}>
            JSON
          </Button>
          <Button size="sm" variant="ghost" aria-label="Export multi-tenant result dossier" onClick={() => onExport("md")}>
            Dossier
          </Button>
          <Button size="sm" variant="secondary" leadingIcon={<IconHardDrive size={12} />} onClick={onSplit}>
            Split to Workspaces
          </Button>
        </>
      }
    >
      <div className="border-b border-[var(--color-border-soft)] p-4">
        <OutputSummaryGrid>
          <OutputSummaryTile label="Tenants" value={job.summary.tenantsScanned} />
          <OutputSummaryTile label="Windows devices" value={job.summary.windowsDevices} />
          <OutputSummaryTile label="Compliant" value={job.summary.compliant} tone="success" />
          <OutputSummaryTile label="Non-compliant" value={job.summary.nonCompliant} tone="danger" />
        </OutputSummaryGrid>
        {job.progress.length > 0 && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 grid gap-2 lg:grid-cols-2"
          >
            {job.progress.map((entry) => (
              <div
                key={entry.tenantId}
                className="flex min-w-0 items-start justify-between gap-3 rounded-lg bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
              >
                <div className="min-w-0">
                  <div className="truncate text-[11.5px] font-medium text-[var(--color-text)]" title={entry.tenantName}>
                    {entry.tenantName}
                  </div>
                  {entry.detail && (
                    <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]" title={entry.detail}>
                      {entry.detail}
                    </div>
                  )}
                </div>
                <Pill
                  tone={
                    entry.status === "ready"
                      ? "success"
                      : entry.status === "failed"
                        ? "danger"
                        : entry.status === "skipped"
                          ? "default"
                          : "warning"
                  }
                >
                  {statusLabel(entry.status)}
                </Pill>
              </div>
            ))}
          </div>
        )}
      </div>
      <OutputPaneToolbar>
        <OutputFilterSelect
          label="Tenant"
          value={filters.tenantId}
          onChange={(tenantId) => onFiltersChange({ ...filters, tenantId })}
          options={[
            { value: "all", label: "All tenants" },
            ...job.comparisons.map((tenant) => ({
              value: tenant.tenantId,
              label: tenant.tenantName,
            })),
          ]}
        />
        <OutputFilterSelect
          label="Readiness"
          value={filters.readiness}
          onChange={(readiness) => onFiltersChange({ ...filters, readiness })}
          options={[
            { value: "all", label: "All readiness" },
            { value: "ready", label: "Ready" },
            { value: "stale", label: "Stale" },
            { value: "failed", label: "Failed" },
            { value: "skipped", label: "Skipped" },
          ]}
        />
        <OutputFilterSelect
          label="Compliance"
          value={filters.complianceState}
          onChange={(complianceState) => onFiltersChange({ ...filters, complianceState })}
          options={[
            { value: "all", label: "All compliance" },
            { value: "compliant", label: "Compliant" },
            { value: "non-compliant", label: "Non-compliant" },
            { value: "unknown", label: "Unknown" },
          ]}
        />
        <OutputFilterSelect
          label="OS"
          value={filters.os}
          onChange={(os) => onFiltersChange({ ...filters, os })}
          options={[
            { value: "all", label: "All OS" },
            ...osOptions.map((os) => ({ value: os, label: os })),
          ]}
        />
        <label
          htmlFor="multi-tenant-stale-only"
          className="inline-flex h-8 items-center gap-2 rounded-md bg-[var(--color-bg)] px-2 text-[11.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
        >
          <input
            id="multi-tenant-stale-only"
            name="multi-tenant-stale-only"
            type="checkbox"
            checked={filters.staleOnly}
            onChange={(event) => onFiltersChange({ ...filters, staleOnly: event.target.checked })}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          Stale only
        </label>
      </OutputPaneToolbar>
      <OutputDataTable
        rows={visibleComparisons}
        columns={comparisonColumns}
        getRowId={(tenant) => tenant.tenantId}
        initialSort={{ columnId: "tenant", direction: "ascending" }}
        minWidthClassName="min-w-[880px]"
        isRowExpanded={(tenant) => expandedTenantIds.includes(tenant.tenantId)}
        renderExpandedRow={(tenant) => {
          const tenantRows = filteredRows.filter((row) => row.tenantId === tenant.tenantId);
          return <DeviceRowsTable rows={tenantRows} />;
        }}
      />
    </OutputPane>
  );
}

function DeviceRowsTable({ rows }: { rows: MultiTenantChatJob["deviceRows"] }) {
  const columns: OutputTableColumn<MultiTenantChatJob["deviceRows"][number]>[] = [
    {
      id: "device",
      header: "Device",
      sortValue: (row) => row.deviceName,
      render: (row) => row.deviceName,
      cellClassName: "max-w-[220px] truncate text-[var(--color-text)]",
      title: (row) => row.deviceName,
    },
    {
      id: "compliance",
      header: "Compliance",
      sortValue: (row) => normalizeComplianceLabel(row.complianceState),
      render: (row) => (
        <Pill tone={complianceTone(row.complianceState)}>
          {normalizeComplianceLabel(row.complianceState)}
        </Pill>
      ),
    },
    {
      id: "os",
      header: "OS",
      sortValue: (row) => row.operatingSystem,
      render: (row) => row.operatingSystem,
      cellClassName: "text-[var(--color-text-soft)]",
    },
    {
      id: "version",
      header: "Version",
      sortValue: (row) => row.osVersion ?? "",
      render: (row) => row.osVersion ?? "unknown",
      cellClassName: "font-mono text-[var(--color-text-muted)]",
    },
    {
      id: "lastSync",
      header: "Last sync",
      sortValue: (row) => row.lastSyncDateTime ?? "",
      render: (row) => (row.lastSyncDateTime ? formatDateTime(row.lastSyncDateTime) : "unknown"),
      cellClassName: "text-[var(--color-text-muted)]",
    },
    {
      id: "owner",
      header: "Owner",
      sortValue: (row) => row.owner ?? "",
      render: (row) => row.owner ?? "unknown",
      cellClassName: "max-w-[220px] truncate text-[var(--color-text-muted)]",
      title: (row) => row.owner,
    },
    {
      id: "freshness",
      header: "Freshness",
      sortValue: (row) => row.sourceRefreshedAt ?? "",
      render: (row) => (row.sourceRefreshedAt ? formatDateTime(row.sourceRefreshedAt) : "unknown"),
      cellClassName: "text-[var(--color-text-muted)]",
    },
  ];

  if (rows.length === 0) {
    return (
      <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
        No device rows match the current filters.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
      <OutputDataTable
        rows={rows.slice(0, 250)}
        columns={columns}
        getRowId={(row) => `${row.tenantId}:${row.deviceId ?? row.deviceName}`}
        initialSort={{ columnId: "device", direction: "ascending" }}
        minWidthClassName="min-w-[920px]"
        tableClassName="text-[11.5px]"
      />
      {rows.length > 250 && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          Showing first 250 matching rows. Export the dossier for the full local result.
        </div>
      )}
    </div>
  );
}

function HostedBatchConsentModal({
  prompt,
  onClose,
  onConfirm,
}: {
  prompt: HostedBatchConsentPrompt | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={Boolean(prompt)} onClose={onClose} size="lg">
      <ModalHeader
        title="Send multi-tenant context to hosted provider"
        subtitle={prompt?.preflight.providerName ?? "Hosted provider"}
        badge={<Pill tone="warning">Hosted batch</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
          Retrieved context from {prompt?.preflight.resolvedTenantIds.length ?? 0} tenant
          {(prompt?.preflight.resolvedTenantIds.length ?? 0) === 1 ? "" : "s"} will be sent to {prompt?.preflight.providerName}.
        </div>
        <div className="max-h-52 overflow-y-auto rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
          {prompt?.preflight.tenants.map((tenant) => (
            <div key={tenant.tenantId} className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                  {tenant.tenantName}
                </div>
                <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                  {tenant.username ?? tenant.tenantId}
                </div>
              </div>
              <ReadinessPill status={tenant.status} />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Confirm batch
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SplitToWorkspacesModal({
  job,
  result,
  onClose,
  onConfirm,
}: {
  job: MultiTenantChatJob | null;
  result: ImportMultiTenantResultToWorkspacesResult | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const tenants =
    job?.comparisons.filter((tenant) => tenant.windowsDevices > 0 || tenant.status === "stale") ??
    [];
  return (
    <Modal open={Boolean(job)} onClose={onClose} size="lg">
      <ModalHeader
        title="Split result to Workspaces"
        subtitle="One tenant-specific evidence entry per workspace"
        badge={<Pill tone="accent">Single-tenant evidence</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          This does not create a mixed-tenant workspace. Each row below becomes local evidence for that tenant only.
        </div>
        <div className="overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
          {tenants.map((tenant) => (
            <div key={tenant.tenantId} className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 text-[12px] last:border-b-0">
              <div className="min-w-0">
                <div className="truncate font-medium text-[var(--color-text)]">{tenant.tenantName}</div>
                <div className="text-[10.5px] text-[var(--color-text-muted)]">
                  New workspace evidence · {tenant.windowsDevices} Windows devices
                </div>
              </div>
              <ReadinessPill status={tenant.status} />
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                {tenant.lastRefresh ? formatDateTime(tenant.lastRefresh) : "no cache"}
              </span>
            </div>
          ))}
        </div>
        {result && (
          <div className="rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-[12px] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
            Created {result.evidence.length} evidence entr{result.evidence.length === 1 ? "y" : "ies"} across {result.workspaces.length} workspace{result.workspaces.length === 1 ? "" : "s"}.
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={tenants.length === 0 || Boolean(result)} onClick={onConfirm}>
            Create evidence
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PinMessageToWorkspaceModal({
  message,
  workspaces,
  selectedWorkspaceId,
  onWorkspaceChange,
  onClose,
  onConfirm,
}: {
  message: IntuneChatMessage | null;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={Boolean(message)} onClose={onClose} size="md">
      <ModalHeader
        title="Pin answer to workspace"
        subtitle="Creates tenant-scoped evidence from this chat answer"
        badge={<Pill tone="accent">Workspace evidence</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          This stores the answer and visible sources in the selected workspace. Multi-tenant answers must be split into tenant-specific workspace evidence first.
        </div>
        <label htmlFor="pin-answer-workspace" className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Workspace
          </span>
          <Select
            id="pin-answer-workspace"
            name="pin-answer-workspace"
            value={selectedWorkspaceId}
            onChange={(event) => onWorkspaceChange(event.target.value)}
            className="mt-2 h-9 w-full rounded-md bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.title}
              </option>
            ))}
          </Select>
        </label>
        {message && (
          <div className="max-h-36 overflow-y-auto rounded-lg bg-[var(--color-bg)] p-3 text-[12px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            {message.content.slice(0, 600)}
            {message.content.length > 600 ? "..." : ""}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!selectedWorkspaceId || workspaces.length === 0}
            onClick={onConfirm}
          >
            Pin answer
          </Button>
        </div>
      </div>
    </Modal>
  );
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
  const trustCopy = deriveTrustCopy({
    provider: prompt
      ? { name: prompt.providerName, isLocal: false }
      : { name: "Hosted provider", isLocal: false },
    ...(prompt?.model ? { model: prompt.model } : {}),
    scope: { tenantNames: prompt ? [prompt.tenantName] : [] },
    ...(prompt?.workspaceContextSummary
      ? {
          attachments: {
            workspaceTitle: prompt.workspaceContextSummary.workspaceTitle,
            evidenceCount: prompt.workspaceContextSummary.evidenceCount,
            noteCount: prompt.workspaceContextSummary.noteCount,
            includesInstructions: prompt.workspaceContextSummary.includesInstructions,
          },
        }
      : {}),
  });
  return (
    <Modal open={Boolean(prompt)} onClose={onClose} size="md">
      <ModalHeader
        title={trustCopy.confirmTitle}
        subtitle={prompt?.providerName ?? "Hosted provider"}
        badge={<Pill tone="warning">Hosted</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
          {trustCopy.confirmBody}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <ConsentFact label="Tenant" value={prompt?.tenantName ?? "Active tenant"} />
          <ConsentFact label="Provider" value={prompt?.providerName ?? "Hosted provider"} />
          <ConsentFact label="Model" value={prompt?.model ?? "Provider default"} />
          <ConsentFact label="Stored data" value={trustCopy.storage} />
          {prompt?.workspaceContextSummary && (
            <ConsentFact
              label="Workspace"
              value={`${prompt.workspaceContextSummary.workspaceTitle} · ${prompt.workspaceContextSummary.evidenceCount} evidence · ${prompt.workspaceContextSummary.noteCount} notes`}
            />
          )}
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
                {prompt?.workspaceContextSummary
                  ? " Selected workspace evidence, notes, and instructions are included in this response prompt."
                  : ""}
              </p>
            </div>
          </div>
        </div>
        <label
          htmlFor="remember-hosted-provider-confirmation"
          className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
        >
          <input
            id="remember-hosted-provider-confirmation"
            name="remember-hosted-provider-confirmation"
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
        <label htmlFor="conversation-title" className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Conversation title
          </span>
          <input
            id="conversation-title"
            name="conversation-title"
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
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px] text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)] ${focusRingClass}`}
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
  workspaceContext?: WorkspacePromptContextSummary,
): HostedProviderConsentInput {
  return {
    tenantId,
    providerId,
    acknowledgedAt: new Date().toISOString(),
    ...(remember ? { remember: true } : {}),
    ...(workspaceContext ? { workspaceContext } : {}),
  };
}

export function createHostedBatchProviderConsent(
  preflight: TenantScopePreflight,
  acknowledgedAt: string,
): NonNullable<RunMultiTenantChatInput["hostedProviderConsent"]> {
  return {
    tenantIds: preflight.resolvedTenantIds,
    providerId: preflight.providerId,
    acknowledgedAt,
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
      status:
        stage === "building-context"
          ? "active"
          : stage === "running-tools" || stage === "generating-answer"
            ? "completed"
            : "pending",
    },
    {
      id: "model-answer",
      label: "Generate response",
      status:
        stage === "running-tools" || stage === "generating-answer"
          ? "active"
          : "pending",
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
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-[560px] rounded-xl bg-[var(--color-bg-raised)] px-3.5 py-3 ring-1 ring-[var(--color-border-soft)]"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-text)]">
            {progress.message}
          </div>
          <div className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {completedCount}/{progress.steps.length}
          </div>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-border-soft)]"
          role="progressbar"
          aria-label={progress.message}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={`h-full rounded-full transition-[width,background-color] duration-300 ${
              hasFailed
                ? "bg-[var(--color-danger)]"
                : isComplete
                  ? "bg-[var(--color-success)]"
                  : "bg-[var(--color-info)]"
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
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                {statusLabel(step.status)}
              </span>
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
        <IconCheck size={10} aria-hidden="true" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-soft)] text-[10px] font-semibold text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/35"
      >
        !
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--color-info)]"
      >
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-[var(--color-text)]/25"
    >
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
    <div className="flex flex-1 flex-col items-center justify-end px-6 pb-8 pt-12">
      <div className="w-full max-w-[680px] text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <IconChat size={21} />
        </div>
        <h1 className="mt-5 text-pretty text-[22px] font-semibold tracking-tight text-[var(--color-text)]">
          {CHAT_COPY.emptyTitle}
        </h1>
        <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-[var(--color-text-soft)]">
          {CHAT_COPY.emptySubtitle}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-1.5">
          {promptGroups.map((group) => (
            <button
              key={group.label}
              type="button"
              onClick={() => setActiveGroup(group.label)}
              className={`rounded-lg px-3 py-1.5 text-[11.5px] transition-colors ${focusRingClass} ${
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
              className={`rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-[13px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50 ${focusRingClass}`}
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
  pinDisabled,
  onPin,
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
  pinDisabled: boolean;
  onPin: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[76%]" : "w-full max-w-[760px]"}>
        <div
          className={
            isUser
              ? "rounded-2xl border border-[var(--color-border)] border-r-2 border-r-[var(--color-accent)] bg-[var(--color-bg-raised)] px-4 py-2.5 text-[13.5px] leading-6 text-[var(--color-text)]"
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
        {!isUser && message.toolTrace && message.toolTrace.length > 0 && (
          <ToolTraceDetails trace={message.toolTrace} />
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
            className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40 ${focusRingClass}`}
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
              className={`inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${focusRingClass}`}
            >
              Edit
            </button>
          )}
          {!isUser && !progress && (
            <>
              <button
                type="button"
                title="Pin response to workspace"
                aria-label="Pin response to workspace"
                disabled={pinDisabled}
                onClick={onPin}
                className="inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Pin answer
              </button>
              <button
                type="button"
                title="Regenerate response"
                aria-label="Regenerate response"
                disabled={regenerateDisabled}
                onClick={onRegenerate}
                className={`inline-flex h-6 items-center rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40 ${focusRingClass}`}
              >
                Regenerate
              </button>
            </>
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

function ToolTraceDetails({ trace }: { trace: IntuneChatToolTraceEntry[] }) {
  return (
    <div className="mt-2">
      <OutputPaneSection
        title="What ran"
        subtitle={`${trace.length} read-only tool call${trace.length === 1 ? "" : "s"}`}
        defaultCollapsed
        bodyClassName="p-2"
      >
        <div className="grid gap-2">
          {trace.map((entry, index) => (
            <div
              key={entry.id}
              className="rounded-md bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-[var(--color-text)]">
                    {index + 1}. {entry.tool}
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]">
                    {summarizeToolParams(entry.params)}
                  </div>
                </div>
                <Pill tone={entry.error ? "warning" : "success"}>
                  {entry.durationMs} ms
                </Pill>
              </div>
              <div className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
                {entry.resultSummary}
              </div>
              {entry.error && (
                <div className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-2.5 py-2 text-[11px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                  {entry.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </OutputPaneSection>
    </div>
  );
}

function summarizeToolParams(params: unknown): string {
  if (!params || typeof params !== "object") return "{}";
  const json = JSON.stringify(params);
  if (!json) return "{}";
  return json.length > 180 ? `${json.slice(0, 180)}...` : json;
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
    intuneAuditEvents: "Intune audit events",
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
    namedLocations: "Named locations",
    authenticationMethodsPolicy: "Authentication methods policy",
    authorizationPolicy: "Authorization policy",
    crossTenantAccessPolicy: "Cross-tenant access policy",
    directoryRoles: "Directory roles",
    administrativeUnits: "Administrative units",
    applications: "App registrations",
    servicePrincipals: "Service principals",
    domains: "Domains",
    securityAlerts: "Defender alerts",
    securityIncidents: "Defender incidents",
    secureScores: "Secure Score history",
    secureScoreControlProfiles: "Secure Score controls",
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

    if (message.toolTrace?.length) {
      lines.push("### What Ran", "");
      for (const entry of message.toolTrace) {
        lines.push(`- \`${entry.tool}\` · ${entry.resultSummary} · ${entry.durationMs} ms`);
        lines.push(`  - Params: \`${summarizeToolParams(entry.params)}\``);
        if (entry.error) lines.push(`  - Error: ${entry.error}`);
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

function detectsAllTenantPrompt(prompt: string): boolean {
  return /\b(all tenants|every tenant|every connected tenant|all customers|all clients|across tenants|from every tenant)\b/i.test(prompt);
}

function shouldUseMultiTenantFlow(prompt: string, scopeMode: MultiTenantScopeMode): boolean {
  return scopeMode !== "active" || detectsAllTenantPrompt(prompt);
}

function statusLabel(status: string): string {
  return status
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeComplianceLabel(value: string): "compliant" | "non-compliant" | "unknown" {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "compliant") return "compliant";
  if (normalized === "noncompliant" || normalized === "non-compliant") {
    return "non-compliant";
  }
  return "unknown";
}

function complianceTone(value: string): "success" | "danger" | "warning" {
  const normalized = normalizeComplianceLabel(value);
  if (normalized === "compliant") return "success";
  if (normalized === "non-compliant") return "danger";
  return "warning";
}

function buildDeviceCsv(job: MultiTenantChatJob): string {
  const header = [
    "tenant",
    "device",
    "compliance",
    "operating_system",
    "os_version",
    "last_sync",
    "owner",
    "source_refreshed_at",
  ];
  const rows = job.deviceRows.map((row) => [
    row.tenantName,
    row.deviceName,
    row.complianceState,
    row.operatingSystem,
    row.osVersion ?? "",
    row.lastSyncDateTime ?? "",
    row.owner ?? "",
    row.sourceRefreshedAt ?? "",
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
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

function RelatedAgentHint({
  suggestion,
  onOpen,
  onDismiss,
}: {
  suggestion: RelatedAgentSuggestion;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const modeLabel = suggestion.agent.mode === "write" ? "Write" : "Read-only";
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[760px] rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-[12px] font-medium text-[var(--color-text)]">
                Related agent · {formatAgentDisplayName(suggestion.agent)}
              </span>
              <Pill tone={suggestion.agent.mode === "write" ? "warning" : "success"}>
                {modeLabel}
              </Pill>
              <span className="text-[11px] text-[var(--color-text-muted)]">
                covers this as a repeatable run.
              </span>
            </div>
            <div
              className="mt-1 truncate text-[11.5px] text-[var(--color-text-muted)]"
              title={suggestion.agent.description}
            >
              {suggestion.agent.description}
            </div>
            <button
              type="button"
              onClick={onOpen}
              className={`mt-2 inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-soft)] ${focusRingClass}`}
            >
              Open agent →
            </button>
          </div>
          <button
            type="button"
            title="Dismiss related agent"
            aria-label={`Dismiss related agent ${formatAgentDisplayName(suggestion.agent)}`}
            onClick={onDismiss}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${focusRingClass}`}
          >
            <IconClose size={12} />
          </button>
        </div>
      </div>
    </div>
  );
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
  const detailsId = useId();
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
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
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
        <div
          id={detailsId}
          className="mt-3 border-t border-[var(--color-border-soft)] pt-3 text-[11px] leading-5 text-[var(--color-text-muted)]"
        >
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
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--color-text-faint)]" />
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
