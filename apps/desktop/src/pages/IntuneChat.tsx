import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { Select } from "../components/Select";
import { useLocation, useNavigate, useParams } from "react-router";
import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { OutputDataTable, OutputFilterSelect, OutputPane, OutputPaneSection, OutputPaneToolbar, OutputSummaryGrid, OutputSummaryTile, type OutputTableColumn } from "../components/OutputPane";
import {
  IconCloud,
  IconCopy,
  IconArrowDown,
  IconArrowUp,
  IconAgentTeam,
  IconChevronDown,
  IconChevronRight,
  IconChat,
  IconCheck,
  IconClose,
  IconDownload,
  IconHardDrive,
  IconLayers,
  IconLock,
  IconMicrophone,
  IconMore,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSlash,
  IconStar,
  IconStop,
  IconWarning,
} from "../components/icons";
import {
  TopBarActions,
  TopBarTitle,
  useAppState,
  useConversations,
  useConversationsOptional,
  ConversationWorkspaceProvider,
  useDataBoundaryOptional,
  useShellChromeOptional,
  useUpdateStateOptional,
  type DataBoundary,
} from "../state";
import { suggestAgentForQuestion } from "../shared/agent-suggestions";
import {
  type AgentSummary,
  resolveProviderDefaultModel,
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
  type ProviderSummary,
  type SendIntuneChatMessageInput,
  type WorkspaceDetail,
  type WorkspacePromptContextInput,
  type WorkspacePromptContextSummary,
  type WorkspaceSummary,
} from "../shared/openAdminOS";
import { copyTextToClipboard } from "../shared/clipboard";
import { CHAT_COPY, chatErrorCopy, deriveTrustCopy } from "../copy";
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
import { Badge, IconButton, Menu, SegmentedControl } from "../components/ui";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { MultiTenantTile, TenantTile } from "../components/TenantTile";
import { openNovaPanel } from "../shared/nova-panel";
import Workspaces from "./Workspaces";

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

type UnifiedAgentSuggestion = {
  slug: string;
  name: string;
  mode: "read" | "write";
  reason: string;
  scopes: string[];
  matchedTerms?: string[];
  matchedConcepts?: string[];
  matchedResources?: GraphCacheResourceKind[];
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
  const conversations = useConversationsOptional();
  if (conversations) return <IntuneChatContent />;
  return (
    <ConversationWorkspaceProvider>
      <IntuneChatContent />
    </ConversationWorkspaceProvider>
  );
}

function IntuneChatContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    conversationId: routeConversationId,
    workspaceId: routeWorkspaceId,
  } = useParams<{ conversationId?: string; workspaceId?: string }>();
  const {
    state,
    startRun,
    refresh,
    loading,
    setActiveProvider,
    setActiveModel,
  } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const shellChrome = useShellChromeOptional();
  const dataBoundaryContext = useDataBoundaryOptional();
  const updateContext = useUpdateStateOptional();
  const {
    conversations,
    activeConversationId,
    activeConversation,
    shellLoaded,
    conversationSearch,
    panelMode,
    workspaceCreateRequest,
    consumeWorkspaceCreateRequest,
    tenantWorkspaces: workspaces,
    cacheStatus,
    setPendingConversation,
    setCacheStatus,
    replaceWorkspaces: setAllWorkspaces,
    openConversation,
    upsertConversation,
    reloadConversations: loadShell,
    requestRename,
    requestDelete,
    togglePinned,
    exportConversation,
    moveToWorkspace,
  } = useConversations();
  const [messages, setMessages] = useState<IntuneChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sendInFlightRef = useRef(false);
  const initialQuestionConsumedRef = useRef(false);
  const resumedIntentRef = useRef<string | null>(null);
  const progressClearTimerRef = useRef<number | null>(null);
  const copiedClearTimerRef = useRef<number | null>(null);
  const draftConversationRef = useRef<string | null | undefined>(undefined);
  const skipDraftWriteRef = useRef(false);
  const [dismissedSuggestionMessageIds, setDismissedSuggestionMessageIds] = useState<string[]>([]);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const followLatestRef = useRef(true);
  const restoreConversationScrollRef = useRef<string | null>(null);

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const activeModel = resolveProviderDefaultModel(
    provider,
    state.activeModelByProviderId,
  ).model;
  const providerReady = Boolean(
    provider && ["connected", "available"].includes(provider.status),
  );
  const dataBoundary = dataBoundaryContext?.boundary ?? (
    !providerReady
      ? {
          kind: "none" as const,
          label: "No model" as const,
          tooltip: "Choose an LLM provider before sending tenant context.",
          isVoiceHosted: false as const,
        }
      : provider?.isLocal
        ? {
            kind: "local" as const,
            label: `Local · ${provider.name}`,
            ...(activeModel ? { model: activeModel } : {}),
            tooltip: "Tenant data stays on this device.",
            isVoiceHosted: false as const,
          }
        : {
            kind: "hosted" as const,
            label: `Hosted · ${provider?.name ?? "provider"}`,
            ...(activeModel ? { model: activeModel } : {}),
            tooltip: `Tenant context will be sent to ${provider?.name ?? "the selected provider"}.`,
            isVoiceHosted: false as const,
          }
  );
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
    setAttachedWorkspaceId((current) =>
      current && workspaces.some((workspace) => workspace.id === current) ? current : "",
    );
  }, [workspaces]);

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
    const shouldRestoreScroll = restoreConversationScrollRef.current !== activeConversationId;
    if (shouldRestoreScroll) {
      restoreConversationScrollRef.current = activeConversationId;
      followLatestRef.current = false;
    }
    void api
      .getIntuneChatMessages(activeConversationId)
      .then(async (nextMessages) => {
        setMessages(nextMessages);
        if (shouldRestoreScroll) {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              setShowScrollToLatest(
                scrollLatestUserNearTop(messagesScrollRef.current, nextMessages),
              );
            });
          });
        }
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
    const scrollRoot = messagesScrollRef.current;
    if (!scrollRoot || !followLatestRef.current) return;
    if (typeof scrollRoot.scrollTo === "function") {
      scrollRoot.scrollTo({
        top: scrollRoot.scrollHeight,
        behavior: reducedMotion ? "auto" : "smooth",
      });
    } else {
      scrollRoot.scrollTop = scrollRoot.scrollHeight;
    }
    setShowScrollToLatest(false);
  }, [messages, sending, chatProgress?.message]);

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
    restoreConversationScrollRef.current = null;
    followLatestRef.current = true;
    setShowScrollToLatest(false);
  };

  useEffect(() => {
    if (new URLSearchParams(location.search).get("new") !== "1" || sending) return;
    startNewConversation(true);
    // The one-shot query is intentionally removed after resetting Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, sending]);

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
    const requestedAgentMatch = matchComposerAgent(content, state.installedAgents);
    if (requestedAgentMatch?.extraInstructions) {
      writeChatDraft(targetConversationId, content);
      setInput(content);
      setError(null);
      setNotice(
        `${formatAgentDisplayName(requestedAgentMatch.agent)} runs without extra instructions. Remove the text after the agent name and send again, or send the text as a normal chat message.`,
      );
      return;
    }
    if (requestedAgentMatch) {
      const requestedAgent = requestedAgentMatch.agent;
      clearChatDraft(targetConversationId);
      setInput("");
      if (requestedAgent.mode === "write") {
        navigate(`/agents/${encodeURIComponent(requestedAgent.slug)}/confirm`);
        return;
      }
      setRunningAgentSlug(requestedAgent.slug);
      setError(null);
      setNotice(null);
      try {
        const run = await startRun(requestedAgent.slug);
        await refresh();
        navigate(`/runs/${run.id}`);
      } catch (caught) {
        setInput(content);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRunningAgentSlug(null);
      }
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
    followLatestRef.current = true;
    setShowScrollToLatest(false);
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

  const handleTogglePinnedConversation = async (conversation: IntuneChatConversation) => {
    if (sending) return;
    setError(null);
    try {
      await togglePinned(conversation);
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
    const matchedAgent = state.installedAgents.find((agent) => agent.slug === slug);
    if (matchedAgent?.mode === "write") {
      navigate(`/agents/${encodeURIComponent(slug)}/confirm`);
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
    if (!activeConversation) return;
    setError(null);
    setNotice(null);
    try {
      const result = await exportConversation(activeConversation);
      if (result && !result.canceled) {
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
    if (!activeConversation || activeConversation.scopeKind === "multi-tenant") return;
    setError(null);
    setNotice(null);
    try {
      await moveToWorkspace(activeConversation);
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
      const nextWorkspaces = await api.listWorkspaces();
      setAllWorkspaces(nextWorkspaces);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const workspaceView = panelMode === "workspaces";
  const scopeLabel =
    scopeMode === "all"
      ? "All connected tenants"
      : scopeMode === "selected"
        ? `${selectedTenantIds.length} selected tenant${selectedTenantIds.length === 1 ? "" : "s"}`
        : activeTenant?.displayName ?? "No active tenant";
  const latestCacheRefresh = newestTimestamp(
    cacheStatus?.resources.flatMap((resource) => resource.refreshedAt ?? []) ?? [],
  );
  const homeFreshness = latestCacheRefresh
    ? `Graph data from ${formatRelativeAge(latestCacheRefresh)}`
    : "Graph data has not been cached yet";
  const awaitingConfirmationRuns = state.runs.filter(
    (run) =>
      run.status === "awaiting-confirmation" &&
      run.tenantId === state.activeTenantId,
  );
  const openFindings = (state.office?.findings ?? []).filter(
    (finding) =>
      finding.tenantId === state.activeTenantId && finding.state === "open",
  );
  const updateNeedsAttention =
    updateContext?.state.status === "ready" || updateContext?.state.status === "error";
  const needsYouCount =
    awaitingConfirmationRuns.length + openFindings.length + (updateNeedsAttention ? 1 : 0);
  const homeSuggestions = promptGroups.flatMap((group) => group.prompts).slice(0, 3);
  const unknownConversation = Boolean(
    shellLoaded &&
      routeConversationId &&
      conversationSearch.trim() === "" &&
      !activeConversation,
  );
  useEffect(() => {
    const onRenameShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "F2" || !activeConversation || workspaceView || sending) return;
      event.preventDefault();
      requestRename(activeConversation);
    };
    window.addEventListener("keydown", onRenameShortcut);
    return () => window.removeEventListener("keydown", onRenameShortcut);
  }, [activeConversation, requestRename, sending, workspaceView]);
  const displayedMessages = mergeOptimisticMessages(messages, optimisticDraft);
  const latestAssistantMessageId = [...displayedMessages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const progressMessageVisible =
    progressAssistantMessageId !== null &&
    displayedMessages.some((message) => message.id === progressAssistantMessageId);
  const fillComposer = (value: string) => {
    setInput(value);
    writeChatDraft(activeConversationId, value);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const scrollToLatest = () => {
    const scrollRoot = messagesScrollRef.current;
    if (!scrollRoot) return;
    followLatestRef.current = true;
    setShowScrollToLatest(false);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    if (typeof scrollRoot.scrollTo === "function") {
      scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior });
    } else {
      scrollRoot.scrollTop = scrollRoot.scrollHeight;
    }
  };

  const handleConversationScroll = () => {
    const scrollRoot = messagesScrollRef.current;
    if (!scrollRoot) return;
    const atBottom =
      scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight < 56;
    followLatestRef.current = atBottom;
    setShowScrollToLatest(!atBottom);
  };

  const handleModelSelect = async (providerId: ProviderId, model: string) => {
    setError(null);
    try {
      if (providerId !== state.activeProviderId) {
        await setActiveProvider(providerId);
      }
      await setActiveModel(providerId, model);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const composerScopeProps = {
    label: scopeLabel,
    scopeMode,
    onScopeModeChange: setScopeMode,
    tenants: state.tenants,
    activeTenantId: state.activeTenantId,
    selectedTenantIds,
    onToggleTenant: toggleTenantSelection,
    tenantGroups,
    selectedGroupIds,
    onToggleGroup: toggleGroupSelection,
    workspaces,
    workspace: attachedWorkspace,
    attachedWorkspaceId,
    onWorkspaceChange: setAttachedWorkspaceId,
    selectedEvidenceIds: selectedWorkspaceEvidenceIds,
    onToggleEvidence: (id: string) =>
      setSelectedWorkspaceEvidenceIds((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    selectedNoteIds: selectedWorkspaceNoteIds,
    onToggleNote: (id: string) =>
      setSelectedWorkspaceNoteIds((current) =>
        current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      ),
    includeInstructions: includeWorkspaceInstructions,
    onIncludeInstructionsChange: setIncludeWorkspaceInstructions,
    disabled: unknownConversation || sending || runningMultiTenant,
  };

  const renderComposer = (placement: "home" | "docked") => (
    <ChatComposer
      placement={placement}
      textareaRef={composerRef}
      value={input}
      onValueChange={setInput}
      onSend={() => void handleSend()}
      onStop={() => void handleStopGeneration()}
      sending={sending}
      stopping={stopping}
      disabled={unknownConversation}
      activeTenant={activeTenant}
      scopeProps={composerScopeProps}
      installedAgents={state.installedAgents}
      savedQueries={savedQueries}
      onSavedQuery={applySavedQuery}
      providers={state.providers}
      activeProviderId={state.activeProviderId}
      activeModel={activeModel}
      onModelSelect={(providerId, model) => void handleModelSelect(providerId, model)}
      onOpenProviders={() => navigate("/settings/providers")}
      dataBoundary={dataBoundary}
    />
  );

  const homeOpen =
    !workspaceView &&
    activeConversationId === null &&
    !unknownConversation &&
    !multiTenantPreflight &&
    displayedMessages.length === 0 &&
    !chatProgress;

  const calmTopBar = shellChrome ? (
    <>
      <TopBarTitle>
        <span className="block max-w-full truncate text-sm font-medium text-[var(--color-text-soft)]">
          {workspaceView
            ? "Workspaces"
            : unknownConversation
              ? "Conversation not found"
              : activeConversation?.title ?? ""}
        </span>
      </TopBarTitle>
      <TopBarActions>
        {activeConversation && !workspaceView ? (
          <ConversationActionsMenu
            conversation={activeConversation}
            sending={sending}
            messagesAvailable={messages.length > 0}
            onRename={() => requestRename(activeConversation)}
            onTogglePin={() => void handleTogglePinnedConversation(activeConversation)}
            onExport={() => void handleExportConversation()}
            onMove={() => void handleCreateWorkspaceFromConversation()}
            onDelete={() => requestDelete(activeConversation)}
          />
        ) : null}
      </TopBarActions>
    </>
  ) : null;

  const calmModals = (
    <>
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
    </>
  );
  if (workspaceView) {
    return (
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
        {calmTopBar}
        <Workspaces
          embedded
          selectedWorkspaceId={routeWorkspaceId ?? null}
          createRequest={workspaceCreateRequest}
          onCreateRequestConsumed={consumeWorkspaceCreateRequest}
          onWorkspaceSelected={(workspaceId) =>
            navigate(
              workspaceId
                ? `/chat/workspaces/${encodeURIComponent(workspaceId)}`
                : "/chat?panel=workspaces",
            )
          }
          onWorkspacesChange={setAllWorkspaces}
        />
        {calmModals}
      </div>
    );
  }

  if (homeOpen) {
    return (
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
        {calmTopBar}
        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[788px] px-6 pb-12 pt-[9vh]">
            {activeTenant ? (
              <div className="mb-[26px] flex items-center gap-4">
                <TenantTile tenantId={activeTenant.id} displayName={activeTenant.displayName} size="md" />
                <div className="min-w-0">
                  <h1 className="line-clamp-2 font-serif text-display font-medium tracking-[-0.015em] text-[var(--color-text)]">
                    {activeTenant.displayName}
                  </h1>
                  <p className="mt-1.5 text-base text-[var(--color-text-muted)]">{homeFreshness}</p>
                </div>
              </div>
            ) : (
              <div className="mb-6 max-w-[620px]">
                <h1 className="font-serif text-display font-medium tracking-[-0.015em] text-[var(--color-text)]">
                  Connect a tenant to begin
                </h1>
                <p className="mt-2 text-md leading-6 text-[var(--color-text-muted)]">
                  {SETUP_COPY.guestChatHint}
                </p>
              </div>
            )}
            <ChatNotices
              error={error}
              notice={notice}
              retryLabel={failedRequest ? chatErrorCopy(error ?? "").action.label : undefined}
              onRetry={failedRequest ? () => void handleRetryFailedSend() : undefined}
            />
            {renderComposer("home")}
            {needsYouCount > 0 ? (
              <section className="mt-[30px]" aria-labelledby="needs-you-heading">
                <div className="flex items-baseline justify-between px-0.5 pb-2 text-sm text-[var(--color-text-muted)]">
                  <h2 id="needs-you-heading">Needs you</h2>
                  <span className="tabular-nums">{needsYouCount}</span>
                </div>
                <div className="overflow-hidden rounded-2xl ring-1 ring-[var(--color-border-soft)]">
                  {awaitingConfirmationRuns.map((run) => {
                    const agent = state.installedAgents.find((entry) => entry.slug === run.agentSlug);
                    return (
                      <TenantBriefingRow
                        key={run.id}
                        icon={<IconWarning size={15} />}
                        warn
                        title={`${agent ? formatAgentDisplayName(agent) : run.agentSlug} is ready for review`}
                        detail={run.plan?.summary ?? run.summary ?? "A write plan is waiting for confirmation."}
                        action="Review"
                        onClick={() => navigate(`/runs/${run.id}`)}
                      />
                    );
                  })}
                  {openFindings.map((finding) => (
                    <TenantBriefingRow
                      key={finding.id}
                      icon={<IconAgentTeam size={15} />}
                      title={finding.title}
                      detail={finding.summary}
                      action="Open"
                      onClick={() => navigate("/office")}
                    />
                  ))}
                  {updateContext?.state.status === "ready" ? (
                    <TenantBriefingRow
                      icon={<IconRefresh size={15} />}
                      title={updateContext.state.version ? `Update ${updateContext.state.version} is ready` : "Update ready"}
                      detail="Restart to install, or it installs on the next quit."
                      action="Restart"
                      onClick={() => void updateContext.restart()}
                    />
                  ) : null}
                  {updateContext?.state.status === "error" ? (
                    <TenantBriefingRow
                      icon={<IconWarning size={15} />}
                      warn
                      title="Update check failed"
                      detail={updateContext.state.message ?? "Check the network connection, then try again."}
                      action="Retry"
                      onClick={() => void updateContext.retry()}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
              <span className="mr-0.5">Try</span>
              {homeSuggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={sending}
                  onClick={() => fillComposer(prompt)}
                  className="h-[30px] max-w-[22rem] truncate rounded-lg bg-[var(--color-hover)] px-2.5 text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-active)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  {suggestionLabel(prompt)}
                </button>
              ))}
              <button
                type="button"
                disabled={sending}
                onClick={() => fillComposer("/")}
                className="h-[30px] rounded-lg bg-[var(--color-hover)] px-2.5 text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-active)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                Run an agent with /
              </button>
            </div>
          </div>
        </section>
        {calmModals}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--color-bg)]">
      {calmTopBar}
      <section className="flex min-w-0 flex-1 flex-col">
        <div
          ref={messagesScrollRef}
          onScroll={handleConversationScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex min-h-full w-full max-w-[788px] flex-col px-6 pb-14 pt-[18px]">
            {unknownConversation ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div role="status" className="w-full max-w-[520px] rounded-2xl bg-[var(--color-surface)] p-6 text-center ring-1 ring-[var(--color-border-soft)]">
                  <h1 className="font-serif text-lg font-medium text-[var(--color-text)]">
                    Conversation not found
                  </h1>
                  <p className="mx-auto mt-2 max-w-[420px] text-base leading-5 text-[var(--color-text-muted)]">
                    It may have been deleted, or this link belongs to another local profile. No tenant data was changed.
                  </p>
                  <Button className="mt-5" variant="primary" leadingIcon={<IconPlus size={12} />} onClick={() => startNewConversation(true)}>
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
            ) : displayedMessages.length === 0 && chatProgress ? (
              <div className="flex flex-1 flex-col justify-center py-16">
                <AssistantPendingScopeLine tenant={activeTenant} label={chatProgress.message} />
              </div>
            ) : (
              <div className="flex flex-1 flex-col">
                {displayedMessages.map((message) => {
                  const job = multiTenantJobsByConversationId[message.conversationId];
                  const relatedAgentSuggestion =
                    message.role === "assistant" && message.status === "completed"
                      ? relatedAgentState.suggestionsByMessageId[message.id]
                      : undefined;
                  const suggestedAgents = mergeSuggestedAgents(
                    message.agentSuggestions,
                    relatedAgentSuggestion,
                  );
                  const messageConversation =
                    conversations.find((entry) => entry.id === message.conversationId) ??
                    activeConversation;
                  const messageTenant = messageConversation?.tenantId
                    ? state.tenants.find((tenant) => tenant.id === messageConversation.tenantId)
                    : activeTenant;
                  return (
                    <div key={message.id} data-message-id={message.id}>
                      <ChatMessageBubble
                        message={message}
                        progress={message.id === progressAssistantMessageId ? chatProgress : null}
                        copied={message.id === copiedMessageId}
                        latestAssistant={message.id === latestAssistantMessageId}
                        tenant={messageTenant}
                        multiTenant={messageConversation?.scopeKind === "multi-tenant"}
                        regenerateDisabled={sending || !previousUserPromptForMessage(displayedMessages, message)}
                        onCopy={() => void handleCopyMessage(message)}
                        onEditPrompt={() => handleEditPrompt(message)}
                        onRegenerate={() => void handleRegenerateResponse(message)}
                        pinDisabled={!activeTenant || activeConversation?.scopeKind === "multi-tenant" || workspaces.length === 0 || message.status !== "completed"}
                        onPin={() => {
                          setPinTarget(message);
                          setPinWorkspaceId(attachedWorkspaceId || workspaces[0]?.id || "");
                        }}
                      />
                      {message.role === "assistant" && suggestedAgents.length > 0 && !dismissedSuggestionMessageIds.includes(message.id) ? (
                        <SuggestedAgentsBlock
                          suggestions={suggestedAgents}
                          runningAgentSlug={runningAgentSlug}
                          onRun={(slug) => void handleRunAgent(slug, message.conversationId, message.id)}
                          onDismiss={() => {
                            dismissRelatedAgentSuggestion(message.id);
                            setDismissedSuggestionMessageIds((current) => [...new Set([...current, message.id])]);
                          }}
                        />
                      ) : null}
                      {message.role === "assistant" && job ? (
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
                      ) : null}
                    </div>
                  );
                })}
                {sending && chatProgress && !progressMessageVisible ? (
                  <AssistantPendingScopeLine tenant={activeTenant} label={chatProgress.message} />
                ) : null}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="relative shrink-0 px-6 pb-3.5">
          {showScrollToLatest ? (
            <IconButton
              label="Scroll to latest"
              tooltip="Scroll to latest"
              icon={<IconArrowDown size={13} />}
              onClick={scrollToLatest}
              className="absolute bottom-[calc(100%+10px)] left-1/2 z-20 -translate-x-1/2 bg-[var(--color-surface)] shadow-[var(--shadow-pop)]"
            />
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 -top-7 h-7 bg-gradient-to-b from-transparent to-[var(--color-bg)]" />
          <div className="relative mx-auto w-full max-w-[740px]">
            <ChatNotices
              error={error}
              notice={notice}
              retryLabel={failedRequest ? chatErrorCopy(error ?? "").action.label : undefined}
              onRetry={failedRequest ? () => void handleRetryFailedSend() : undefined}
            />
            {renderComposer("docked")}
          </div>
        </div>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {sendState.phase === "failed" ? "" : sendState.announcement}
        </div>
      </section>
      {calmModals}
    </div>
  );

}

function ConversationActionsMenu({
  conversation,
  sending,
  messagesAvailable,
  onRename,
  onTogglePin,
  onExport,
  onMove,
  onDelete,
}: {
  conversation: IntuneChatConversation;
  sending: boolean;
  messagesAvailable: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu
      ariaLabel="Conversation actions"
      trigger={
        <IconButton
          label="Conversation actions"
          tooltip="Conversation actions"
          icon={<IconMore size={14} />}
        />
      }
      items={[
        {
          id: "workspace",
          label: "Workspace",
          icon: <IconHardDrive size={12} />,
          disabled: sending || conversation.scopeKind === "multi-tenant",
          onSelect: onMove,
        },
        {
          id: "export",
          label: "Export",
          icon: <IconDownload size={12} />,
          disabled: sending || !messagesAvailable,
          onSelect: onExport,
        },
        {
          id: "pin",
          label: conversation.pinnedAt ? "Unpin" : "Pin",
          icon: <IconStar size={12} />,
          disabled: sending,
          onSelect: onTogglePin,
        },
        {
          id: "rename",
          label: "Rename",
          icon: <IconChat size={12} />,
          disabled: sending,
          onSelect: onRename,
        },
        { type: "separator", id: "delete-separator" },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          disabled: sending,
          onSelect: onDelete,
        },
      ]}
    />
  );
}

type ComposerScopeProps = Parameters<typeof ComposerScopePopover>[0];

function ChatComposer({
  placement,
  textareaRef,
  value,
  onValueChange,
  onSend,
  onStop,
  sending,
  stopping,
  disabled,
  activeTenant,
  scopeProps,
  installedAgents,
  savedQueries,
  onSavedQuery,
  providers,
  activeProviderId,
  activeModel,
  onModelSelect,
  onOpenProviders,
  dataBoundary,
}: {
  placement: "home" | "docked";
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  sending: boolean;
  stopping: boolean;
  disabled: boolean;
  activeTenant?: TenantRecord;
  scopeProps: ComposerScopeProps;
  installedAgents: AgentSummary[];
  savedQueries: SavedMultiTenantQuery[];
  onSavedQuery: (query: SavedMultiTenantQuery) => void;
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModel?: string;
  onModelSelect: (providerId: ProviderId, model: string) => void;
  onOpenProviders: () => void;
  dataBoundary: DataBoundary;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activePickerIndex, setActivePickerIndex] = useState(0);
  const query = value.startsWith("/") ? value.slice(1).trim().toLocaleLowerCase() : "";
  const hasAgentToken = installedAgents.some((agent) =>
    value
      .toLocaleLowerCase()
      .startsWith(`/${formatAgentDisplayName(agent).toLocaleLowerCase()} `),
  );
  const matchingAgents = installedAgents.filter((agent) => {
    const name = formatAgentDisplayName(agent).toLocaleLowerCase();
    return !query || name.includes(query) || agent.slug.toLocaleLowerCase().includes(query);
  });
  const matchingQueries = savedQueries.filter((savedQuery) =>
    !query ||
    savedQuery.title.toLocaleLowerCase().includes(query) ||
    savedQuery.prompt.toLocaleLowerCase().includes(query),
  );
  const pickerEntries: Array<
    | { kind: "agent"; agent: AgentSummary }
    | { kind: "query"; query: SavedMultiTenantQuery }
  > = [
    ...matchingAgents.map((agent) => ({ kind: "agent" as const, agent })),
    ...matchingQueries.map((savedQuery) => ({ kind: "query" as const, query: savedQuery })),
  ];

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [textareaRef, value]);

  useEffect(() => {
    setPickerOpen(value.startsWith("/") && !hasAgentToken);
    setActivePickerIndex(0);
  }, [hasAgentToken, value]);

  const pickEntry = (index: number) => {
    const entry = pickerEntries[index];
    if (!entry) return;
    if (entry.kind === "agent") {
      onValueChange(`/${formatAgentDisplayName(entry.agent)} `);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      onSavedQuery(entry.query);
    }
    setPickerOpen(false);
  };

  const placeholder = activeTenant
    ? placement === "home"
      ? activeTenant.displayName.length <= 28
        ? `Ask about ${activeTenant.displayName}, or type / to run an agent`
        : "Ask about this tenant, or type / to run an agent"
      : "Ask a follow-up, or type / to run an agent"
    : SETUP_COPY.guestComposerPlaceholder;
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);

  return (
    <div className="relative">
      {pickerOpen ? (
        <div
          id={`chat-agent-picker-${placement}`}
          role="listbox"
          aria-label="Agents and saved queries"
          className={`absolute inset-x-0 z-[90] max-h-[min(420px,52vh)] overflow-y-auto rounded-[14px] bg-[var(--color-raised)] p-1.5 shadow-[var(--shadow-pop)] ${
            placement === "docked" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]"
          }`}
        >
          {pickerEntries.length === 0 ? (
            <div className="px-3 py-3 text-sm text-[var(--color-text-muted)]">
              No matching agents or saved queries.
            </div>
          ) : (
            <>
              {matchingAgents.length > 0 ? (
                <div className="px-2 pb-1 pt-1 text-xs text-[var(--color-text-muted)]">Agents</div>
              ) : null}
              {matchingAgents.map((agent, index) => (
                <button
                  key={agent.slug}
                  id={`chat-picker-${placement}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activePickerIndex === index}
                  onMouseEnter={() => setActivePickerIndex(index)}
                  onClick={() => pickEntry(index)}
                  className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)] ${
                    activePickerIndex === index ? "bg-[var(--color-hover)]" : "hover:bg-[var(--color-hover)]"
                  }`}
                >
                  <IconLayers size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-[var(--color-text)]">
                      {formatAgentDisplayName(agent)}
                    </span>
                    <span className="block truncate text-sm text-[var(--color-text-muted)]">
                      {agent.description}
                    </span>
                  </span>
                  {agent.mode === "write" ? <Badge tone="warning">Makes changes</Badge> : null}
                </button>
              ))}
              {matchingQueries.length > 0 ? (
                <div className="mt-1 border-t border-[var(--color-border-soft)] px-2 pb-1 pt-2 text-xs text-[var(--color-text-muted)]">
                  Saved queries
                </div>
              ) : null}
              {matchingQueries.map((savedQuery, queryIndex) => {
                const index = matchingAgents.length + queryIndex;
                return (
                  <button
                    key={savedQuery.id}
                    id={`chat-picker-${placement}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activePickerIndex === index}
                    onMouseEnter={() => setActivePickerIndex(index)}
                    onClick={() => pickEntry(index)}
                    className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)] ${
                      activePickerIndex === index ? "bg-[var(--color-hover)]" : "hover:bg-[var(--color-hover)]"
                    }`}
                  >
                    <IconStar size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-medium text-[var(--color-text)]">
                        {savedQuery.title}
                      </span>
                      <span className="block truncate text-sm text-[var(--color-text-muted)]">
                        {savedQuery.prompt}
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      ) : null}

      <div className="intune-chat-composer rounded-2xl bg-[var(--color-surface)] px-2.5 pb-2.5 pl-4 pt-3.5 shadow-[var(--shadow-composer)] transition-shadow duration-150 focus-within:shadow-[var(--shadow-composer-focus)]">
        {!activeTenant ? (
          <div className="mb-2 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm leading-5 text-[var(--color-warning)]">
            {SETUP_COPY.guestChatHint}
          </div>
        ) : null}
        <label htmlFor={`intune-chat-composer-${placement}`} className="sr-only">
          {CHAT_COPY.composerLabel}
        </label>
        <textarea
          id={`intune-chat-composer-${placement}`}
          name={`intune-chat-composer-${placement}`}
          ref={textareaRef}
          rows={1}
          disabled={disabled}
          value={value}
          role="combobox"
          aria-controls={pickerOpen ? `chat-agent-picker-${placement}` : undefined}
          aria-expanded={pickerOpen}
          aria-haspopup="listbox"
          aria-activedescendant={
            pickerOpen && pickerEntries.length > 0
              ? `chat-picker-${placement}-${activePickerIndex}`
              : undefined
          }
          aria-autocomplete="list"
          autoComplete="off"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            if (pickerOpen && pickerEntries.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActivePickerIndex((current) =>
                  (current + (event.key === "ArrowDown" ? 1 : -1) + pickerEntries.length) % pickerEntries.length,
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pickEntry(activePickerIndex);
                return;
              }
            }
            if (event.key === "Escape" && pickerOpen) {
              event.preventDefault();
              setPickerOpen(false);
              return;
            }
            if (shouldSubmitComposerKey(event.nativeEvent)) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          className="block min-h-[38px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent pb-3 pr-2 pt-0.5 text-md leading-[1.55] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus-visible:outline-none"
        />
        <div className="flex items-center gap-1">
          <ComposerScopePopover {...scopeProps} />
          <IconButton
            size="sm"
            label="Run an agent"
            tooltip="Run an agent"
            shortcut="/"
            icon={<IconSlash size={13} />}
            disabled={disabled || sending}
            onClick={() => {
              onValueChange("/");
              setPickerOpen(true);
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          />
          <span className="min-w-2 flex-1" />
          <ComposerModelPopover
            providers={providers}
            activeProviderId={activeProviderId}
            activeModel={activeModel}
            onSelect={onModelSelect}
            onManage={onOpenProviders}
            disabled={disabled || sending}
          />
          <IconButton
            size="sm"
            label="Voice"
            tooltip="Voice"
            shortcut="Alt+V"
            icon={<IconMicrophone size={14} />}
            disabled={disabled}
            onClick={openNovaPanel}
          />
          <button
            type="button"
            aria-label={sending ? (stopping ? "Stopping" : "Stop") : "Send"}
            title={sending ? (stopping ? "Stopping" : "Stop") : "Send"}
            disabled={sending ? stopping : disabled || value.trim().length === 0}
            onClick={sending ? onStop : onSend}
            className="ml-1 inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--color-accent)] text-[var(--color-on-accent)] transition-colors hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:bg-[var(--color-active)] disabled:text-[var(--color-text-muted)]"
          >
            {sending ? <IconStop size={13} /> : <IconArrowUp size={15} />}
          </button>
        </div>
      </div>

      {dataBoundary.kind === "none" ? (
        <div className={`mt-2.5 flex items-center gap-2 text-sm text-[var(--color-warning)] ${placement === "home" ? "justify-start pl-1" : "justify-center"}`}>
          <IconSettings size={13} />
          <span>No model selected.</span>
          <button type="button" onClick={onOpenProviders} className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
            Set up a model
          </button>
        </div>
      ) : dataBoundary.kind === "local" ? (
        <div className={`mt-2.5 flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] ${placement === "home" ? "justify-start pl-1" : "justify-center"}`}>
          <IconLock size={13} />
          <span>Local model. Tenant data stays on this device.</span>
        </div>
      ) : (
        <div role="note" className={`mt-2.5 flex items-center gap-1.5 text-sm text-[var(--color-warning)] ${placement === "home" ? "justify-start pl-1" : "justify-center"}`}>
          <IconCloud size={13} />
          <span>Prompts and tenant data go to {activeProvider?.name ?? "the selected provider"} while this model is selected.</span>
        </div>
      )}
    </div>
  );
}

function ComposerModelPopover({
  providers,
  activeProviderId,
  activeModel,
  onSelect,
  onManage,
  disabled,
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModel?: string;
  onSelect: (providerId: ProviderId, model: string) => void;
  onManage: () => void;
  disabled: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const availableProviders = providers.filter(
    (provider) => ["connected", "available"].includes(provider.status) && provider.models.length > 0,
  );
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);

  useEffect(() => {
    const closeFromOutside = (event: globalThis.MouseEvent) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const details = detailsRef.current;
      if (event.key !== "Escape" || !details?.open) return;
      event.preventDefault();
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    };
    window.addEventListener("mousedown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("mousedown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, []);

  return (
    <details ref={detailsRef} className="group relative">
      <summary
        aria-label={`Model: ${activeModel ?? activeProvider?.name ?? "No model"}`}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        className={`flex h-8 max-w-[240px] cursor-pointer list-none items-center gap-1.5 rounded-[9px] px-2.5 text-sm text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] [&::-webkit-details-marker]:hidden ${focusRingClass} ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        {activeProvider?.isLocal === false ? <IconCloud size={12} /> : <IconLock size={12} />}
        <span className="truncate">{activeModel ?? activeProvider?.name ?? "Choose model"}</span>
        <IconChevronDown size={11} className="text-[var(--color-text-muted)]" />
      </summary>
      <div role="menu" aria-label="Models" className="absolute bottom-[calc(100%+8px)] right-0 z-[90] w-[min(360px,calc(100vw-48px))] overflow-hidden rounded-[14px] bg-[var(--color-raised)] p-1.5 shadow-[var(--shadow-pop)]">
        {([true, false] as const).map((local, groupIndex) => {
          const group = availableProviders.filter((provider) => provider.isLocal === local);
          if (group.length === 0) return null;
          return (
            <div key={local ? "local" : "hosted"} className={groupIndex > 0 ? "mt-1 border-t border-[var(--color-border-soft)] pt-1" : ""}>
              <div className="px-2 pb-1 pt-1 text-xs text-[var(--color-text-muted)]">
                {local ? "On this device" : "Hosted"}
              </div>
              {group.flatMap((provider) =>
                provider.models.map((model) => {
                  const selected = provider.id === activeProviderId && model === activeModel;
                  return (
                    <button
                      key={`${provider.id}:${model}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        detailsRef.current?.removeAttribute("open");
                        onSelect(provider.id, model);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]"
                    >
                      {local ? <IconLock size={13} /> : <IconCloud size={13} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-[var(--color-text)]">{model}</span>
                        <span className="block truncate text-sm text-[var(--color-text-muted)]">{provider.name}</span>
                      </span>
                      {selected ? <IconCheck size={13} /> : null}
                    </button>
                  );
                }),
              )}
            </div>
          );
        })}
        <div className="mt-1 border-t border-[var(--color-border-soft)] pt-1">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              detailsRef.current?.removeAttribute("open");
              onManage();
            }}
            className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]"
          >
            <IconSettings size={13} />
            Manage models
          </button>
        </div>
      </div>
    </details>
  );
}

function ChatNotices({
  error,
  notice,
  retryLabel,
  onRetry,
}: {
  error: string | null;
  notice: string | null;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  return (
    <>
      {error ? (
        <div role="alert" className="mb-3 flex items-start justify-between gap-4 rounded-[10px] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          <div className="min-w-0">
            <div className="font-medium">{onRetry ? chatErrorCopy(error).what : "The requested action could not be completed."}</div>
            <div className="mt-0.5 break-words text-[var(--color-text-soft)]">
              {chatErrorCopy(error).why ?? "Retry the action. If it still fails, review the provider and tenant connection in Settings."}
            </div>
          </div>
          {onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>{retryLabel ?? "Retry"}</Button> : null}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="mb-3 rounded-[10px] bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
          {notice}
        </div>
      ) : null}
    </>
  );
}

function TenantBriefingRow({
  icon,
  warn = false,
  title,
  detail,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  warn?: boolean;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-[var(--color-border-soft)] px-4 py-3 text-left first:border-t-0 hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]">
      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-[9px] ${warn ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]" : "bg-[var(--color-bubble)] text-[var(--color-text-soft)]"}`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-base font-medium text-[var(--color-text)]">{title}</span>
        <span className="block truncate text-sm text-[var(--color-text-muted)]">{detail}</span>
      </span>
      <span className="inline-flex items-center gap-1 text-sm text-[var(--color-text-soft)]">
        {action}<IconChevronRight size={11} />
      </span>
    </button>
  );
}

function AssistantPendingScopeLine({ tenant, label }: { tenant?: TenantRecord; label: string }) {
  return (
    <div className="mb-8 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
      {tenant ? <TenantTile tenantId={tenant.id} displayName={tenant.displayName} size="xs" /> : null}
      {tenant?.displayName ? <span>{tenant.displayName}</span> : null}
      <span aria-hidden="true">·</span>
      <span className="chat-scope-shimmer">{label}</span>
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

function ComposerScopePopover({
  label,
  scopeMode,
  onScopeModeChange,
  tenants,
  activeTenantId,
  selectedTenantIds,
  onToggleTenant,
  tenantGroups,
  selectedGroupIds,
  onToggleGroup,
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
  label: string;
  scopeMode: MultiTenantScopeMode;
  onScopeModeChange: (mode: MultiTenantScopeMode) => void;
  tenants: TenantRecord[];
  activeTenantId?: string;
  selectedTenantIds: string[];
  onToggleTenant: (tenantId: string) => void;
  tenantGroups: TenantGroup[];
  selectedGroupIds: string[];
  onToggleGroup: (groupId: string) => void;
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
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const hasMultipleTenants = tenants.length >= 2;
  const hasWorkspaceContext =
    Boolean(workspace) &&
    (selectedEvidenceIds.length > 0 ||
      selectedNoteIds.length > 0 ||
      (includeInstructions && Boolean(workspace?.instructions?.trim())));
  const activeTenant = tenants.find((tenant) => tenant.id === activeTenantId);

  useEffect(() => {
    const closeFromOutside = (event: globalThis.MouseEvent) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const details = detailsRef.current;
      if (event.key !== "Escape" || !details?.open) return;
      event.preventDefault();
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    };
    window.addEventListener("mousedown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("mousedown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, []);

  return (
    <details ref={detailsRef} className="group relative">
      <summary
        aria-label={`Scope: ${label}`}
        aria-disabled={disabled}
        onClick={(event) => {
          if (event.defaultPrevented) return;
          if (disabled) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (disabled && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
          }
        }}
        className={`flex h-8 max-w-[260px] cursor-pointer list-none items-center gap-1.5 rounded-[9px] px-2.5 text-sm text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] [&::-webkit-details-marker]:hidden ${focusRingClass} ${
          disabled ? "pointer-events-none opacity-50" : ""
        }`}
      >
        {scopeMode === "active" && activeTenant ? (
          <TenantTile tenantId={activeTenant.id} displayName={activeTenant.displayName} size="xs" />
        ) : (
          <MultiTenantTile size="xs" />
        )}
        <span className="max-w-52 truncate">{label}</span>
        {hasWorkspaceContext && <Badge tone="info">Context</Badge>}
        <IconChevronDown size={11} />
      </summary>
      <div className="absolute bottom-[calc(100%+8px)] left-0 z-[70] w-[min(440px,calc(100vw-64px))] rounded-[14px] bg-[var(--color-raised)] p-3 shadow-[var(--shadow-pop)]">
        <div className="text-sm font-medium text-[var(--color-text)]">Tenant scope</div>
        {hasMultipleTenants ? (
          <SegmentedControl
            className="mt-2"
            ariaLabel="Tenant scope"
            value={scopeMode}
            options={[
              { id: "active", label: "Active tenant" },
              { id: "selected", label: "Selected tenants" },
              { id: "all", label: "All connected tenants" },
            ]}
            onValueChange={(value) => onScopeModeChange(value as MultiTenantScopeMode)}
          />
        ) : (
          <div className="mt-2 text-sm text-[var(--color-text-muted)]">
            Active tenant: {tenants.find((tenant) => tenant.id === activeTenantId)?.displayName ?? "Not connected"}
          </div>
        )}

        {hasMultipleTenants && scopeMode === "selected" && (
          <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">Tenants</div>
            <div className="mt-2 grid max-h-28 gap-1 overflow-y-auto sm:grid-cols-2">
              {tenants.map((tenant) => (
                <label
                  key={tenant.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-text-soft)] hover:bg-[var(--color-surface)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedTenantIds.includes(tenant.id)}
                    onChange={() => onToggleTenant(tenant.id)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  <span className="truncate">{tenant.displayName}</span>
                </label>
              ))}
            </div>
            {tenantGroups.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-[var(--color-text-muted)]">Tenant groups</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tenantGroups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => onToggleGroup(group.id)}
                      className={`rounded-md px-2 py-1 text-xs ${focusRingClass} ${
                        selectedGroupIds.includes(group.id)
                          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                          : "bg-[var(--color-surface)] text-[var(--color-text-muted)]"
                      }`}
                    >
                      {group.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {workspaces.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
            <label className="block text-xs font-medium text-[var(--color-text-muted)]">
              Workspace context
              <Select
                aria-label="Workspace context"
                value={attachedWorkspaceId}
                onChange={(event) => onWorkspaceChange(event.target.value)}
                className="mt-2 h-8 w-full rounded-md bg-[var(--color-bg-raised)] px-2 text-sm text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
              >
                <option value="">No workspace attached</option>
                {workspaces.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </Select>
            </label>
            {workspace && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="flex items-start gap-2 text-xs text-[var(--color-text-soft)]">
                  <input
                    type="checkbox"
                    checked={includeInstructions && Boolean(workspace.instructions?.trim())}
                    disabled={!workspace.instructions?.trim()}
                    onChange={(event) => onIncludeInstructionsChange(event.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  Instructions
                </label>
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-muted)]">Evidence</div>
                  <div className="mt-1 max-h-20 space-y-1 overflow-y-auto">
                    {workspace.evidence.slice(0, 12).map((entry) => (
                      <label key={entry.id} className="flex items-center gap-2 text-xs text-[var(--color-text-soft)]">
                        <input
                          type="checkbox"
                          checked={selectedEvidenceIds.includes(entry.id)}
                          onChange={() => onToggleEvidence(entry.id)}
                          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                        />
                        <span className="truncate">{entry.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-muted)]">Notes</div>
                  <div className="mt-1 max-h-20 space-y-1 overflow-y-auto">
                    {workspace.notes.slice(0, 12).map((note) => (
                      <label key={note.id} className="flex items-center gap-2 text-xs text-[var(--color-text-soft)]">
                        <input
                          type="checkbox"
                          checked={selectedNoteIds.includes(note.id)}
                          onChange={() => onToggleNote(note.id)}
                          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                        />
                        <span className="truncate">{note.content}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </details>
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
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">
              Review multi-tenant scope
            </div>
            <div
              title={`${preflight.providerName}${preflight.model ? ` · ${preflight.model}` : ""}`}
              className="mt-1 max-w-full truncate text-xs text-[var(--color-text-muted)]"
            >
              {preflight.resolvedTenantIds.length} tenant{preflight.resolvedTenantIds.length === 1 ? "" : "s"} · {preflight.providerName}
              {preflight.model ? ` · ${preflight.model}` : ""}
            </div>
          </div>
          <Badge tone={preflight.providerIsLocal ? "success" : "warning"}>
            {preflight.providerIsLocal ? "Local provider" : "Hosted confirmation required"}
          </Badge>
        </div>
        <div className="mt-3 rounded-lg bg-[var(--color-bg)] px-3 py-2 text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          {preflight.prompt}
        </div>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0 overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="bg-[var(--color-bg)] text-xs text-[var(--color-text-muted)]">
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
                    <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
                      {tenant.username ?? tenant.tenantId}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ReadinessBadge status={tenant.status} />
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                    {tenant.cacheFreshness ? formatDateTime(tenant.cacheFreshness) : "No cache"}
                  </td>
                  <td className="px-3 py-2 text-xs leading-5 text-[var(--color-text-muted)]">
                    {tenant.recovery}
                    {tenant.missingScopes.length > 0 && (
                      <div className="mt-1 font-mono text-xs text-[var(--color-warning)]">
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
                <div className="text-xs font-medium text-[var(--color-text-muted)]">
                  Run progress
                </div>
                <Badge tone={progressJob.status === "partial" ? "warning" : "info"}>
                  {progressJob.status}
                </Badge>
              </div>
              <div className="space-y-1.5">
                {progressJob.progress.map((entry) => (
                  <div
                    key={entry.tenantId}
                    className="flex items-center justify-between gap-2 rounded-md bg-[var(--color-bg-raised)] px-2 py-1.5 text-xs ring-1 ring-[var(--color-border-soft)]"
                  >
                    <span className="min-w-0 truncate text-[var(--color-text-soft)]">
                      {entry.tenantName}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                      {entry.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">
              Resources
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {preflight.resources.map((resource) => (
                <Badge key={resource}>{chatResourceLabel(resource)}</Badge>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">
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
                className="min-w-0 flex-1 rounded-md bg-[var(--color-bg-raised)] px-2 text-sm text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
              />
              <Button size="sm" variant="secondary" disabled={!groupName.trim()} onClick={onSaveGroup}>
                Save
              </Button>
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">
              Agent batch
            </div>
            <div className="mt-2 flex gap-2">
              <Select
                value={selectedBatchAgentSlug}
                onChange={(event) => onSelectedBatchAgentSlugChange(event.target.value)}
                disabled={running || installedAgents.length === 0}
                className="min-w-0 flex-1 rounded-md bg-[var(--color-bg-raised)] px-2 text-sm text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
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
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
              Queues one tenant-pinned run per ready tenant.
              {selectedBatchAgent?.mode === "write"
                ? " Write runs still pause for per-run typed confirmation."
                : " Read runs start with the normal run history."}
            </p>
            {batchNotice && (
              <div className="mt-2 rounded-md bg-[var(--color-success-soft)] px-2 py-1.5 text-xs text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
                {batchNotice}
              </div>
            )}
          </div>
          {blocked.length > 0 && (
            <div className="rounded-lg bg-[var(--color-warning-soft)] p-3 text-sm leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
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

function ReadinessBadge({ status }: { status: string }) {
  const tone =
    status === "ready"
      ? "success"
      : status === "stale"
        ? "warning"
        : status === "skipped"
          ? "neutral"
          : "danger";
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
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
      render: (tenant) => <ReadinessBadge status={tenant.status} />,
    },
    {
      id: "windows",
      header: "Windows",
      align: "right",
      sortValue: (tenant) => tenant.windowsDevices,
      render: (tenant) => tenant.windowsDevices.toLocaleString(),
      cellClassName: "tabular-nums",
    },
    {
      id: "compliant",
      header: "Compliant",
      align: "right",
      sortValue: (tenant) => tenant.compliant,
      render: (tenant) => tenant.compliant.toLocaleString(),
      cellClassName: "tabular-nums text-[var(--color-success)]",
    },
    {
      id: "nonCompliant",
      header: "Non-compliant",
      align: "right",
      sortValue: (tenant) => tenant.nonCompliant,
      render: (tenant) => tenant.nonCompliant.toLocaleString(),
      cellClassName: "tabular-nums text-[var(--color-danger)]",
    },
    {
      id: "unknown",
      header: "Unknown",
      align: "right",
      sortValue: (tenant) => tenant.unknown,
      render: (tenant) => tenant.unknown.toLocaleString(),
      cellClassName: "tabular-nums",
    },
    {
      id: "lastRefresh",
      header: "Last refresh",
      sortValue: (tenant) => tenant.lastRefresh ?? "",
      render: (tenant) => (tenant.lastRefresh ? formatDateTime(tenant.lastRefresh) : "Unknown"),
      cellClassName: "text-xs text-[var(--color-text-muted)]",
    },
  ];

  const resultSubtitle = `${job.providerName}${job.model ? ` · ${job.model}` : ""} · ${formatDateTime(job.updatedAt)}`;
  return (
    <OutputPane
      title="Multi-tenant result"
      subtitle={<span title={resultSubtitle} className="block max-w-full truncate">{resultSubtitle}</span>}
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
                  <div className="truncate text-sm font-medium text-[var(--color-text)]" title={entry.tenantName}>
                    {entry.tenantName}
                  </div>
                  {entry.detail && (
                    <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]" title={entry.detail}>
                      {entry.detail}
                    </div>
                  )}
                </div>
                <Badge
                  tone={
                    entry.status === "ready"
                      ? "success"
                      : entry.status === "failed"
                        ? "danger"
                        : entry.status === "skipped"
                          ? "neutral"
                          : "warning"
                  }
                >
                  {statusLabel(entry.status)}
                </Badge>
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
          className="inline-flex h-8 items-center gap-2 rounded-md bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
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
        <Badge tone={complianceTone(row.complianceState)}>
          {normalizeComplianceLabel(row.complianceState)}
        </Badge>
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
      <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-3 text-sm text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
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
        tableClassName="text-sm"
      />
      {rows.length > 250 && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
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
        badge={<Badge tone="warning">Hosted batch</Badge>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
          Retrieved context from {prompt?.preflight.resolvedTenantIds.length ?? 0} tenant
          {(prompt?.preflight.resolvedTenantIds.length ?? 0) === 1 ? "" : "s"} will be sent to {prompt?.preflight.providerName}.
        </div>
        <div className="max-h-52 overflow-y-auto rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
          {prompt?.preflight.tenants.map((tenant) => (
            <div key={tenant.tenantId} className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-text)]">
                  {tenant.tenantName}
                </div>
                <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
                  {tenant.username ?? tenant.tenantId}
                </div>
              </div>
              <ReadinessBadge status={tenant.status} />
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
        badge={<Badge tone="info">Single-tenant evidence</Badge>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          This does not create a mixed-tenant workspace. Each row below becomes local evidence for that tenant only.
        </div>
        <div className="overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
          {tenants.map((tenant) => (
            <div key={tenant.tenantId} className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 text-sm last:border-b-0">
              <div className="min-w-0">
                <div className="truncate font-medium text-[var(--color-text)]">{tenant.tenantName}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  New workspace evidence · {tenant.windowsDevices} Windows devices
                </div>
              </div>
              <ReadinessBadge status={tenant.status} />
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
                {tenant.lastRefresh ? formatDateTime(tenant.lastRefresh) : "no cache"}
              </span>
            </div>
          ))}
        </div>
        {result && (
          <div className="rounded-lg bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
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
        badge={<Badge tone="info">Workspace evidence</Badge>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
          This stores the answer and visible sources in the selected workspace. Multi-tenant answers must be split into tenant-specific workspace evidence first.
        </div>
        <label htmlFor="pin-answer-workspace" className="block">
          <span className="text-xs font-medium text-[var(--color-text-muted)]">
            Workspace
          </span>
          <Select
            id="pin-answer-workspace"
            name="pin-answer-workspace"
            value={selectedWorkspaceId}
            onChange={(event) => onWorkspaceChange(event.target.value)}
            className="mt-2 h-9 w-full rounded-md bg-[var(--color-bg-raised)] px-2 text-base text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.title}
              </option>
            ))}
          </Select>
        </label>
        {message && (
          <div className="max-h-36 overflow-y-auto rounded-lg bg-[var(--color-bg)] p-3 text-sm leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
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
        badge={<Badge tone="warning">Hosted</Badge>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
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
              <div className="text-base font-medium text-[var(--color-text)]">
                What leaves this device
              </div>
              <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">
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
          className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 text-sm leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
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
      <div className="text-xs font-medium text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 truncate text-base text-[var(--color-text)]">
        {value}
      </div>
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

function ChatMessageBubble({
  message,
  progress,
  copied,
  latestAssistant,
  tenant,
  multiTenant,
  regenerateDisabled,
  onCopy,
  onEditPrompt,
  onRegenerate,
  pinDisabled,
  onPin,
}: {
  message: IntuneChatMessage;
  progress: ChatProgressState | null;
  copied: boolean;
  latestAssistant: boolean;
  tenant?: TenantRecord;
  multiTenant: boolean;
  regenerateDisabled: boolean;
  onCopy: () => void;
  onEditPrompt: () => void;
  onRegenerate: () => void;
  pinDisabled: boolean;
  onPin: () => void;
}) {
  const isUser = message.role === "user";
  const hasWebSources = message.toolTrace?.some(t => t.webSources?.length);
  // Older stored answers carry the suggested agent as a trailing sentence;
  // the Suggested agents block now shows it, so drop the duplicate line.
  const bodyContent = message.content.replace(/\n\nDetected matching agent: [^\n]*$/, "");
  const displayContent = hasWebSources ? bodyContent.split("\n\nPublic web sources:")[0] : bodyContent;
  const timestamp = formatDateTime(message.createdAt);

  if (isUser) {
    return (
      <div className="group mb-[18px] flex justify-end">
        <div className="flex max-w-[78%] flex-col items-end">
          <div
            title={`Sent ${timestamp}`}
            className="whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-[var(--color-bubble)] px-[15px] py-2.5 text-md leading-[1.55] text-[var(--color-text)]"
          >
            {displayContent}
          </div>
          <div className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton
              size="sm"
              label="Copy prompt"
              tooltip={`${copied ? "Copied" : "Copy"} · ${timestamp}`}
              icon={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              disabled={!message.content.trim()}
              onClick={onCopy}
            />
            <IconButton
              size="sm"
              label="Edit and resend prompt"
              tooltip={`Edit · ${timestamp}`}
              icon={<IconPencil size={12} />}
              onClick={onEditPrompt}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <article className="group mb-[34px] w-full" title={`Answered ${timestamp}`}>
      {progress ? (
        <AssistantPendingScopeLine tenant={tenant} label={progress.message} />
      ) : (
        <AnswerScopeDisclosure
          tenant={tenant}
          multiTenant={multiTenant}
          notice={message.engineNotice}
          sources={message.sources ?? []}
          trace={message.toolTrace ?? []}
        />
      )}
      {displayContent ? (
        <MarkdownPreview
          source={displayContent}
          numberedSections={false}
          tableTools
          className="chat-answer text-[var(--color-text)]"
        />
      ) : null}
      <AnswerSources sources={message.sources ?? []} trace={message.toolTrace ?? []} />
      {!progress ? (
        <div className={`-ml-1.5 mt-1 flex gap-0.5 transition-opacity ${latestAssistant ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
          <IconButton
            size="sm"
            label="Copy response"
            tooltip={`${copied ? "Copied" : "Copy"} · ${timestamp}`}
            icon={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            disabled={!message.content.trim()}
            onClick={onCopy}
          />
          <IconButton
            size="sm"
            label="Regenerate response"
            tooltip={`Regenerate · ${timestamp}`}
            icon={<IconRefresh size={12} />}
            disabled={regenerateDisabled}
            onClick={onRegenerate}
          />
          <IconButton
            size="sm"
            label="Pin response to workspace"
            tooltip={`Pin answer · ${timestamp}`}
            icon={<IconStar size={12} />}
            disabled={pinDisabled}
            onClick={onPin}
          />
        </div>
      ) : null}
    </article>
  );
}

function AnswerScopeDisclosure({
  tenant,
  multiTenant,
  notice,
  sources,
  trace,
}: {
  tenant?: TenantRecord;
  multiTenant: boolean;
  notice?: string;
  sources: IntuneChatSource[];
  trace: IntuneChatToolTraceEntry[];
}) {
  const refreshedAt = newestTimestamp(
    sources.flatMap((source) => source.refreshedAt ?? []),
  );
  const resourceNames = [...new Set(sources.map((source) => source.label))].join(", ");
  const scopeName = multiTenant ? "Multiple tenants" : tenant?.displayName ?? "Tenant";
  const hasDetails = Boolean(notice || sources.length > 0 || trace.length > 0);

  return (
    <details className="group/details mb-2.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md text-sm text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] [&::-webkit-details-marker]:hidden">
        {multiTenant ? (
          <MultiTenantTile size="xs" />
        ) : tenant ? (
          <TenantTile tenantId={tenant.id} displayName={tenant.displayName} size="xs" />
        ) : null}
        <span>{scopeName}</span>
        <span aria-hidden="true" className="opacity-60">·</span>
        <span>{resourceNames || "Tenant data"}</span>
        {refreshedAt ? (
          <>
            <span aria-hidden="true" className="opacity-60">·</span>
            <span>data from {formatRelativeAge(refreshedAt)}</span>
          </>
        ) : null}
        <span aria-hidden="true" className="opacity-60">·</span>
        <span className="inline-flex items-center gap-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          How I checked
          <IconChevronRight size={13} className="transition-transform duration-150 group-open/details:rotate-90" />
        </span>
      </summary>
      <div className="mt-2 border-l-2 border-[var(--color-border)] pl-3 text-sm text-[var(--color-text-soft)]">
        {notice ? (
          <div className="mb-2 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[var(--color-warning)]">
            {notice}
          </div>
        ) : null}
        {sources.length > 0 ? <SourceDetails sources={sources} /> : null}
        {trace.length > 0 ? <ToolTraceDetails trace={trace} /> : null}
        {!hasDetails ? <div className="py-1">No source trace was stored for this answer.</div> : null}
      </div>
    </details>
  );
}

function AnswerSources({
  sources,
  trace,
}: {
  sources: IntuneChatSource[];
  trace: IntuneChatToolTraceEntry[];
}) {
  const webSources = safeWebSources(trace);
  if (sources.length === 0 && webSources.length === 0) return null;
  return (
    <ol aria-label="Sources" className="mb-4 mt-1 list-none space-y-0.5 p-0 font-sans text-sm text-[var(--color-text-muted)]">
      {sources.map((source, index) => (
        <li key={`${source.resource}-${index}`} className="flex flex-wrap items-center gap-2 py-0.5">
          <span className="inline-grid h-[17px] min-w-[17px] place-items-center rounded-[5px] bg-[var(--color-hover)] px-1 text-[11px] font-medium text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border-soft)]">
            {index + 1}
          </span>
          <span className="font-medium text-[var(--color-text-soft)]">{source.label}</span>
          <span>· {source.rows.toLocaleString()} {source.rows === 1 ? "row" : "rows"}</span>
          <span>· {source.refreshedAt ? formatRelativeAge(source.refreshedAt) : "not refreshed"}</span>
        </li>
      ))}
      {webSources.map((source, webIndex) => (
        <li key={source.url} className="flex min-w-0 items-center gap-2 py-0.5">
          <span className="inline-grid h-[17px] min-w-[17px] place-items-center rounded-[5px] bg-[var(--color-hover)] px-1 text-[11px] font-medium text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border-soft)]">
            {sources.length + webIndex + 1}
          </span>
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="truncate rounded font-medium text-[var(--color-text-soft)] hover:text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]">
            {source.title || new URL(source.url).hostname}
          </a>
          <span className="shrink-0">· web source</span>
        </li>
      ))}
    </ol>
  );
}

function SourceDetails({ sources }: { sources: IntuneChatSource[] }) {
  return (
      <div>
        <div className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">Sources</div>
        <div className="grid gap-2">
          {sources.map((source) => (
            <div
              key={source.resource}
              className="rounded-md bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[var(--color-text)]">
                    {source.label}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                    {source.path ?? source.resource}
                  </div>
                </div>
                <Badge tone={source.error ? "warning" : source.source === "live" ? "success" : "neutral"}>
                  {sourceCoverageLabel(source)}
                </Badge>
              </div>
              <div className="mt-2 grid gap-1.5 text-xs leading-5 text-[var(--color-text-muted)] sm:grid-cols-2">
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
                <div className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text-soft)]">Select</span>{" "}
                  <span className="font-mono">
                    {source.select.slice(0, 10).join(", ")}
                    {source.select.length > 10 ? `, +${source.select.length - 10} more` : ""}
                  </span>
                </div>
              )}
              {source.query && Object.keys(source.query).length > 0 && (
                <div className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text-soft)]">Query</span>{" "}
                  <span className="font-mono">{formatSourceQuery(source.query)}</span>
                </div>
              )}
              {source.error && (
                <div className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-2.5 py-2 text-xs leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                  {source.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
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
                  <div className="font-mono text-xs text-[var(--color-text)]">
                    {index + 1}. {entry.tool}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
                    {summarizeToolParams(entry.params)}
                  </div>
                </div>
                <Badge tone={entry.error ? "warning" : "success"}>
                  {entry.durationMs} ms
                </Badge>
              </div>
              <div className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
                {entry.resultSummary}
              </div>
              {entry.error && (
                <div className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-2.5 py-2 text-xs leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
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

function mergeSuggestedAgents(
  matched: IntuneChatAgentSuggestion[] | undefined,
  related: RelatedAgentSuggestion | undefined,
): UnifiedAgentSuggestion[] {
  const suggestions = new Map<string, UnifiedAgentSuggestion>();
  for (const suggestion of matched ?? []) {
    suggestions.set(suggestion.agentSlug, {
      slug: suggestion.agentSlug,
      name: suggestion.agentName,
      mode: suggestion.mode,
      reason: suggestion.reason,
      scopes: suggestion.scopes,
      matchedTerms: suggestion.matchedTerms,
      matchedConcepts: suggestion.matchedConcepts,
      matchedResources: suggestion.matchedResources,
    });
  }
  if (related && !suggestions.has(related.agent.slug)) {
    suggestions.set(related.agent.slug, {
      slug: related.agent.slug,
      name: formatAgentDisplayName(related.agent),
      mode: related.agent.mode,
      reason: related.agent.description,
      scopes: related.agent.scopes,
    });
  }
  return [...suggestions.values()];
}

function SuggestedAgentsBlock({
  suggestions,
  runningAgentSlug,
  onRun,
  onDismiss,
}: {
  suggestions: UnifiedAgentSuggestion[];
  runningAgentSlug: string | null;
  onRun: (slug: string) => void;
  onDismiss: () => void;
}) {
  const [detailsSlug, setDetailsSlug] = useState<string | null>(null);
  if (suggestions.length === 0) return null;
  return (
    <div className="mb-[34px] w-full max-w-[740px] space-y-2">
      {suggestions.map((suggestion) => {
        const detailsOpen = detailsSlug === suggestion.slug;
        return (
          <div key={suggestion.slug} className="rounded-[14px] px-4 py-3 font-sans text-base text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)]">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1 leading-5">
                <span className="font-medium text-[var(--color-text)]">{suggestion.name}</span>{" "}
                <span>
                  {suggestion.mode === "write"
                    ? `${suggestion.reason} Nothing changes until you review and confirm.`
                    : suggestion.reason}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsSlug(detailsOpen ? null : suggestion.slug)}
              >
                Details
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={runningAgentSlug === suggestion.slug}
                onClick={() => onRun(suggestion.slug)}
              >
                {runningAgentSlug === suggestion.slug
                  ? "Starting"
                  : suggestion.mode === "write"
                    ? "Review change"
                    : "Run agent"}
              </Button>
              <IconButton
                size="sm"
                label="Dismiss suggested agent"
                tooltip="Dismiss"
                icon={<IconClose size={12} />}
                onClick={onDismiss}
              />
          </div>
            {detailsOpen ? (
              <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3 text-sm leading-5 text-[var(--color-text-muted)]">
                <div className="font-medium text-[var(--color-text-soft)]">Why suggested</div>
                <div>{suggestion.reason}</div>
                {(suggestion.matchedConcepts?.length ?? 0) > 0 ? (
                  <ul className="mt-2 space-y-1 text-[var(--color-text-soft)]">
                    {suggestion.matchedConcepts?.map((concept) => (
                      <li key={concept}>{concept}</li>
                    ))}
                  </ul>
                ) : null}
                {(suggestion.matchedTerms?.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestion.matchedTerms?.map((term) => <Badge key={term}>{term}</Badge>)}
                  </div>
                ) : null}
                {(suggestion.matchedResources?.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestion.matchedResources?.map((resource) => (
                      <Badge key={resource}>{chatResourceLabel(resource)}</Badge>
                    ))}
                  </div>
                ) : null}
                {suggestion.scopes.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span>Required scopes</span>
                    {suggestion.scopes.slice(0, 4).map((scope) => <Badge key={scope}>{scope}</Badge>)}
                    {suggestion.scopes.length > 4 ? <Badge>{suggestion.scopes.length - 4} more</Badge> : null}
                  </div>
                ) : null}
                {suggestion.mode === "write" ? (
                  <div className="mt-2 text-[var(--color-warning)]">
                    Write actions still use the normal plan and confirmation flow.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
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

interface ComposerAgentMatch {
  agent: AgentSummary;
  extraInstructions: string;
}

function matchComposerAgent(
  content: string,
  agents: AgentSummary[],
): ComposerAgentMatch | undefined {
  const trimmed = content.trimStart();
  const normalized = trimmed.toLocaleLowerCase();
  if (!normalized.startsWith("/")) return undefined;
  const matches = agents.flatMap((agent) =>
    [formatAgentDisplayName(agent), agent.name, agent.slug].flatMap((name) => {
      const token = `/${name.toLocaleLowerCase()}`;
      if (!normalized.startsWith(token)) return [];
      const boundary = normalized[token.length];
      if (boundary !== undefined && !/\s/u.test(boundary)) return [];
      return [{ agent, tokenLength: token.length }];
    }),
  );
  const match = matches.sort((left, right) => right.tokenLength - left.tokenLength)[0];
  if (!match) return undefined;
  return {
    agent: match.agent,
    extraInstructions: trimmed.slice(match.tokenLength).trim(),
  };
}

function suggestionLabel(prompt: string): string {
  // Keep whole words; the chip truncates visually with an ellipsis if needed.
  return prompt.replace(/[?.]$/, "");
}

function newestTimestamp(values: string[]): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return latest;
    if (!latest || time > Date.parse(latest)) return value;
    return latest;
  }, undefined);
}

function formatRelativeAge(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function safeWebSources(trace: IntuneChatToolTraceEntry[]) {
  return [
    ...new Map(
      trace
        .flatMap((entry) => entry.webSources ?? [])
        .filter((source) => {
          try {
            const url = new URL(source.url);
            return url.protocol === "https:" && !url.username && !url.password;
          } catch {
            return false;
          }
        })
        .map((source) => [source.url, source]),
    ).values(),
  ];
}

function scrollLatestUserNearTop(
  scrollRoot: HTMLElement | null,
  messages: IntuneChatMessage[],
): boolean {
  if (!scrollRoot) return false;
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const element = latestUser
    ? [...scrollRoot.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (candidate) => candidate.dataset.messageId === latestUser.id,
      )
    : undefined;
  const top = Math.max(0, (element?.offsetTop ?? scrollRoot.scrollHeight) - 18);
  if (typeof scrollRoot.scrollTo === "function") scrollRoot.scrollTo({ top, behavior: "auto" });
  else scrollRoot.scrollTop = top;
  return scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight >= 56;
}
