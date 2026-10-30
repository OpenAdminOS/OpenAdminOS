import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "../components/Button";
import { Modal, ModalHeader } from "../components/Modal";
import { Pill } from "../components/Pill";
import { useToast } from "../components/Toast";
import type {
  GraphCacheStatus,
  IntuneChatConversation,
  SaveTextFileResult,
  WorkspaceSummary,
} from "../shared/openAdminOS";
import {
  buildConversationExportMarkdown,
  conversationCacheSummary,
} from "../shared/conversation-export";
import { userFacingErrorReason } from "../copy";
import { useAppState } from "./AppStateContext";

export type ConversationPanelMode = "chats" | "workspaces";

interface ConversationWorkspaceContextValue {
  conversations: IntuneChatConversation[];
  pendingConversation: IntuneChatConversation | null;
  activeConversationId: string | null;
  activeConversation?: IntuneChatConversation;
  shellLoaded: boolean;
  conversationSearch: string;
  workspaceSearch: string;
  panelMode: ConversationPanelMode;
  workspaceCreateRequest: number;
  allWorkspaces: WorkspaceSummary[];
  tenantWorkspaces: WorkspaceSummary[];
  cacheStatus: GraphCacheStatus | null;
  pinnedSectionOpen: boolean;
  setPendingConversation: (conversation: IntuneChatConversation | null) => void;
  setCacheStatus: (status: GraphCacheStatus | null) => void;
  setConversationSearch: (query: string) => void;
  setWorkspaceSearch: (query: string) => void;
  setPanelMode: (mode: ConversationPanelMode) => void;
  setPinnedSectionOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  requestWorkspaceCreate: () => void;
  consumeWorkspaceCreateRequest: (request: number) => void;
  replaceWorkspaces: (workspaces: WorkspaceSummary[]) => void;
  reloadWorkspaces: () => Promise<WorkspaceSummary[]>;
  openConversation: (id: string | null, options?: { replace?: boolean }) => void;
  openWorkspaces: (workspaceId?: string | null) => void;
  upsertConversation: (conversation: IntuneChatConversation) => void;
  reloadConversations: (
    preferredActiveConversationId?: string | null,
    searchOverride?: string,
  ) => Promise<void>;
  requestRename: (conversation: IntuneChatConversation) => void;
  requestDelete: (conversation: IntuneChatConversation) => void;
  togglePinned: (conversation: IntuneChatConversation) => Promise<void>;
  exportConversation: (
    conversation: IntuneChatConversation,
  ) => Promise<SaveTextFileResult | undefined>;
  moveToWorkspace: (conversation: IntuneChatConversation) => Promise<void>;
}

const ConversationWorkspaceContext =
  createContext<ConversationWorkspaceContextValue | undefined>(undefined);

function routeConversationId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)$/);
  if (!match || match[1] === "workspaces") return null;
  return decodeURIComponent(match[1]!);
}

function routeWorkspaceId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/workspaces\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Whether a conversation may be shown under the given active tenant.
 * Mirrors the host rule from the tenant-scoping fix: the tenant's own
 * conversations, multi-tenant-scope conversations, and legacy rows
 * without a tenant are visible; another tenant's are not.
 */
function conversationVisibleForTenant(
  conversation: IntuneChatConversation,
  activeTenantId: string | null | undefined,
): boolean {
  return (
    conversation.scopeKind === "multi-tenant" ||
    !conversation.tenantId ||
    !activeTenantId ||
    conversation.tenantId === activeTenantId
  );
}

export function ConversationWorkspaceProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { state } = useAppState();
  const initialConversationId = routeConversationId(location.pathname);
  const navigateRef = useRef(navigate);
  const [conversations, setConversations] = useState<IntuneChatConversation[]>([]);
  const [pendingConversation, setPendingConversation] =
    useState<IntuneChatConversation | null>(null);
  const [activeConversationId, setActiveConversationId] =
    useState<string | null>(initialConversationId);
  const activeConversationIdRef = useRef<string | null>(initialConversationId);
  const activeTenantIdRef = useRef(state.activeTenantId);
  activeTenantIdRef.current = state.activeTenantId;
  const locationRef = useRef(location);
  const [shellLoaded, setShellLoaded] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const conversationSearchRef = useRef("");
  const skipInitialSearchRef = useRef(true);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [panelMode, setPanelModeState] = useState<ConversationPanelMode>(
    routeWorkspaceId(location.pathname) ||
      new URLSearchParams(location.search).get("panel") === "workspaces"
      ? "workspaces"
      : "chats",
  );
  const [workspaceCreateRequest, setWorkspaceCreateRequest] = useState(0);
  const [allWorkspaces, setAllWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus | null>(null);
  const [pinnedSectionOpen, setPinnedSectionOpen] = useState(true);
  const [renameTarget, setRenameTarget] = useState<IntuneChatConversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<IntuneChatConversation | null>(null);
  const [busy, setBusy] = useState(false);
  navigateRef.current = navigate;
  locationRef.current = location;
  conversationSearchRef.current = conversationSearch;

  const openConversation = useCallback(
    (id: string | null, options: { replace?: boolean } = {}) => {
      setPanelModeState("chats");
      setActiveConversationId(id);
      activeConversationIdRef.current = id;
      const destination = id ? `/chat/${encodeURIComponent(id)}` : "/chat";
      if (`${locationRef.current.pathname}${locationRef.current.search}` !== destination) {
        navigateRef.current(destination, { replace: options.replace });
      }
    },
    [],
  );

  const openWorkspaces = useCallback(
    (workspaceId?: string | null) => {
      setPanelModeState("workspaces");
      navigateRef.current(
        workspaceId
          ? `/chat/workspaces/${encodeURIComponent(workspaceId)}`
          : "/chat?panel=workspaces",
      );
    },
    [],
  );

  const setPanelMode = useCallback(
    (mode: ConversationPanelMode) => {
      if (mode === "workspaces") openWorkspaces();
      else openConversation(activeConversationIdRef.current);
    },
    [openConversation, openWorkspaces],
  );

  const upsertConversation = useCallback((conversation: IntuneChatConversation) => {
    if (!conversationVisibleForTenant(conversation, activeTenantIdRef.current)) return;
    setPendingConversation(conversation);
    setConversations((current) =>
      current.some((entry) => entry.id === conversation.id)
        ? current.map((entry) => (entry.id === conversation.id ? conversation : entry))
        : [conversation, ...current],
    );
  }, []);

  const reloadGenerationRef = useRef(0);
  const reloadConversations = useCallback(
    async (
      preferredActiveConversationId?: string | null,
      searchOverride?: string,
    ) => {
      const api = window.openAdminOS;
      if (!api) return undefined;
      const generation = (reloadGenerationRef.current += 1);
      const requestedTenantId = activeTenantIdRef.current;
      const query = (searchOverride ?? conversationSearchRef.current).trim();
      const [loadedConversations, nextCache] = await Promise.all([
        query
          ? api.searchIntuneChatConversations(query)
          : api.listIntuneChatConversations(),
        api.getGraphCacheStatus().catch(() => null),
      ]);
      // A reload started under the previous tenant (or superseded by a
      // newer reload) must not restore that tenant's sidebar or cache
      // status over the current tenant's shell.
      if (
        generation !== reloadGenerationRef.current ||
        requestedTenantId !== activeTenantIdRef.current
      ) {
        return undefined;
      }
      const nextConversations = loadedConversations.filter((conversation) =>
        conversationVisibleForTenant(conversation, activeTenantIdRef.current),
      );
      const activeId = activeConversationIdRef.current;
      setConversations((current) => {
        if (!activeId) return nextConversations;
        const active = current.find((conversation) => conversation.id === activeId);
        // Reinserting the open conversation across a tenant switch put
        // the previous tenant's conversation back into the new tenant's
        // shell (and kept its transcript addressable by route).
        return active &&
          conversationVisibleForTenant(active, activeTenantIdRef.current) &&
          !nextConversations.some((conversation) => conversation.id === activeId)
          ? [active, ...nextConversations]
          : nextConversations;
      });
      setCacheStatus(nextCache);
      setShellLoaded(true);
      if (preferredActiveConversationId !== undefined) {
        const preferredVisible =
          preferredActiveConversationId &&
          nextConversations.some(
            (conversation) => conversation.id === preferredActiveConversationId,
          )
            ? preferredActiveConversationId
            : null;
        const nextId = preferredVisible ?? nextConversations[0]?.id ?? null;
        openConversation(nextId, { replace: true });
      }
    },
    [openConversation],
  );

  const reloadWorkspaces = useCallback(async () => {
    const next = (await window.openAdminOS?.listWorkspaces()) ?? [];
    setAllWorkspaces(next);
    return next;
  }, []);

  const requestWorkspaceCreate = useCallback(() => {
    setWorkspaceCreateRequest((current) => current + 1);
  }, []);

  const consumeWorkspaceCreateRequest = useCallback((request: number) => {
    setWorkspaceCreateRequest((current) => (current === request ? 0 : current));
  }, []);

  useEffect(() => {
    const id = routeConversationId(location.pathname);
    const workspace = routeWorkspaceId(location.pathname);
    const workspacesSelected =
      Boolean(workspace) || new URLSearchParams(location.search).get("panel") === "workspaces";
    setPanelModeState(workspacesSelected ? "workspaces" : "chats");
    if (!workspacesSelected) {
      setActiveConversationId(id);
      activeConversationIdRef.current = id;
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    setShellLoaded(false);
    setPendingConversation(null);
    // Drop the previous tenant's conversations immediately on switch;
    // waiting for the reload left them listed and openable in between.
    setConversations((current) =>
      current.filter((conversation) =>
        conversationVisibleForTenant(conversation, state.activeTenantId),
      ),
    );
    void Promise.all([reloadConversations(), reloadWorkspaces()]).catch((error: unknown) => {
      toast.error(conversationActionError("Loading conversations", error));
    });
  }, [reloadConversations, reloadWorkspaces, state.activeTenantId, toast]);

  useEffect(() => {
    if (skipInitialSearchRef.current) {
      skipInitialSearchRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void reloadConversations(undefined, conversationSearch).catch((error: unknown) => {
        toast.error(conversationActionError("Conversation search", error));
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [conversationSearch, reloadConversations, toast]);

  const activeConversation = (
    conversations.find((conversation) => conversation.id === activeConversationId) ??
    (pendingConversation?.id === activeConversationId ? pendingConversation : undefined)
  ) as IntuneChatConversation | undefined;
  const visibleActiveConversation =
    activeConversation &&
    conversationVisibleForTenant(activeConversation, state.activeTenantId)
      ? activeConversation
      : undefined;
  const tenantWorkspaces = useMemo(
    () =>
      state.activeTenantId
        ? allWorkspaces.filter((workspace) => workspace.tenantId === state.activeTenantId)
        : [],
    [allWorkspaces, state.activeTenantId],
  );

  const togglePinned = useCallback(
    async (conversation: IntuneChatConversation) => {
      const updated = await window.openAdminOS?.setIntuneChatConversationPinned(
        conversation.id,
        !conversation.pinnedAt,
      );
      if (updated) {
        upsertConversation(updated);
        await reloadConversations();
      }
    },
    [reloadConversations, upsertConversation],
  );

  const exportConversation = useCallback(
    async (conversation: IntuneChatConversation) => {
      const api = window.openAdminOS;
      if (!api) return;
      const messages = await api.getIntuneChatMessages(conversation.id);
      const tenant = state.tenants.find((entry) => entry.id === conversation.tenantId);
      const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
      const result = await api.saveTextFile({
        suggestedName: `${safeFileName(conversation.title)}.md`,
        content: buildConversationExportMarkdown({
          conversation,
          messages,
          tenantName: tenant?.displayName,
          providerName: provider?.name,
          cacheSummary: conversationCacheSummary(cacheStatus),
          sampleData: tenant?.kind === "sample",
        }),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!result.canceled) toast.success("Conversation exported.");
      return result;
    },
    [cacheStatus, state.activeProviderId, state.providers, state.tenants, toast],
  );

  const moveToWorkspace = useCallback(
    async (conversation: IntuneChatConversation) => {
      if (conversation.scopeKind === "multi-tenant") return;
      const workspace = await window.openAdminOS?.createWorkspace({
        title: conversation.title,
        ...(conversation.tenantId ? { tenantId: conversation.tenantId } : {}),
        conversationId: conversation.id,
      });
      if (!workspace) return;
      await reloadWorkspaces();
      toast.success(`Created workspace ${workspace.title} and linked this conversation.`);
    },
    [reloadWorkspaces, toast],
  );

  const value = useMemo<ConversationWorkspaceContextValue>(
    () => ({
      conversations,
      pendingConversation,
      activeConversationId,
      activeConversation: visibleActiveConversation,
      shellLoaded,
      conversationSearch,
      workspaceSearch,
      panelMode,
      workspaceCreateRequest,
      allWorkspaces,
      tenantWorkspaces,
      cacheStatus,
      pinnedSectionOpen,
      setPendingConversation,
      setCacheStatus,
      setConversationSearch,
      setWorkspaceSearch,
      setPanelMode,
      setPinnedSectionOpen,
      requestWorkspaceCreate,
      consumeWorkspaceCreateRequest,
      replaceWorkspaces: setAllWorkspaces,
      reloadWorkspaces,
      openConversation,
      openWorkspaces,
      upsertConversation,
      reloadConversations,
      requestRename: (conversation) => {
        setRenameTarget(conversation);
        setRenameTitle(conversation.title);
      },
      requestDelete: setDeleteTarget,
      togglePinned,
      exportConversation,
      moveToWorkspace,
    }),
    [
      visibleActiveConversation,
      activeConversationId,
      allWorkspaces,
      cacheStatus,
      conversationSearch,
      conversations,
      exportConversation,
      moveToWorkspace,
      openConversation,
      openWorkspaces,
      panelMode,
      pendingConversation,
      pinnedSectionOpen,
      requestWorkspaceCreate,
      reloadConversations,
      reloadWorkspaces,
      consumeWorkspaceCreateRequest,
      setPanelMode,
      shellLoaded,
      tenantWorkspaces,
      togglePinned,
      workspaceCreateRequest,
      workspaceSearch,
    ],
  );

  const rename = async () => {
    const title = renameTitle.trim();
    if (!renameTarget || !title) return;
    setBusy(true);
    try {
      const renamed = await window.openAdminOS?.renameIntuneChatConversation(
        renameTarget.id,
        title,
      );
      if (renamed) {
        upsertConversation(renamed);
        await reloadConversations();
      }
      setRenameTarget(null);
      setRenameTitle("");
    } catch (error) {
      toast.error(conversationActionError("Renaming the conversation", error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const wasActive = deleteTarget.id === activeConversationIdRef.current;
      await window.openAdminOS?.deleteIntuneChatConversation(deleteTarget.id);
      setDeleteTarget(null);
      if (wasActive) openConversation(null, { replace: true });
      await reloadConversations();
    } catch (error) {
      toast.error(conversationActionError("Deleting the conversation", error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConversationWorkspaceContext.Provider value={value}>
      {children}
      <Modal
        open={renameTarget !== null}
        onClose={() => {
          if (!busy) setRenameTarget(null);
        }}
        size="md"
      >
        <ModalHeader title="Rename conversation" onClose={() => setRenameTarget(null)} />
        <form
          className="space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <label className="block text-sm font-medium text-[var(--color-text-soft)]">
            Conversation title
            <input
              data-autofocus
              name="conversation-title"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              className="mt-2 h-10 w-full rounded-[10px] bg-[var(--color-raised)] px-3 text-base text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border)] focus:ring-[var(--color-accent)]"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !renameTitle.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!busy) setDeleteTarget(null);
        }}
        size="md"
      >
        <ModalHeader
          title="Delete conversation"
          subtitle={deleteTarget?.title}
          badge={<Pill tone="danger">Local history</Pill>}
          onClose={() => setDeleteTarget(null)}
        />
        <div className="space-y-4 p-6">
          <p className="text-base leading-6 text-[var(--color-text-soft)]">
            This removes the conversation and its messages from this device. Tenant data and Microsoft 365 resources are not changed.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting" : "Delete"}
            </Button>
          </div>
        </div>
      </Modal>
    </ConversationWorkspaceContext.Provider>
  );
}

export function useConversations(): ConversationWorkspaceContextValue {
  const value = useContext(ConversationWorkspaceContext);
  if (!value) throw new Error("useConversations must be used within ConversationWorkspaceProvider.");
  return value;
}

export function useConversationsOptional(): ConversationWorkspaceContextValue | undefined {
  return useContext(ConversationWorkspaceContext);
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

function conversationActionError(action: string, error: unknown): string {
  const detail = userFacingErrorReason(error instanceof Error ? error.message : String(error));
  return `${action} failed.${detail ? ` ${detail}` : ""} Try again.`;
}

