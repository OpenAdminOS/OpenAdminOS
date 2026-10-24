import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { NavLink, useNavigate } from "react-router";

import {
  SIDEBAR_COLLAPSED_KEY,
  useAppState,
  useConversations,
  useShellChrome,
  useUpdateState,
} from "../state";
import { isNightlyVersion } from "../shared/update-channel";
import { SHORTCUTS, shortcutLabel } from "../shared/shortcuts";
import { openNovaPanel } from "../shared/nova-panel";
import { userFacingErrorReason } from "../copy";
import {
  IconActivity,
  IconAgentTeam,
  IconAgents,
  IconArrowLeft,
  IconChanges,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconCommand,
  IconDownload,
  IconHardDrive,
  IconLogo,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSparkle,
  IconStar,
} from "./icons";
import { MultiTenantTile, TenantTile } from "./TenantTile";
import { Modal, ModalHeader } from "./Modal";
import { useToast } from "./Toast";
import { Kbd, Menu, Tooltip } from "./ui";

export { SIDEBAR_COLLAPSED_KEY };

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
  tooltip?: string;
}

function NavRow({ item }: { item: NavItem }) {
  const row = (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `group flex h-[var(--nav-h)] items-center gap-2 rounded-[8px] px-2.5 text-base transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${
          isActive
            ? "bg-[var(--color-active)] font-medium text-[var(--color-text)]"
            : "text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
        }`
      }
    >
      <span className="inline-flex w-4 shrink-0 justify-center text-[var(--color-text-muted)]">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count ? (
        <span className="min-w-5 rounded-md bg-[var(--color-active)] px-1.5 py-0.5 text-center text-xs font-medium tabular-nums text-[var(--color-text)]">
          {item.count}
        </span>
      ) : null}
    </NavLink>
  );
  return item.tooltip ? <Tooltip content={item.tooltip} side="right">{row}</Tooltip> : row;
}

function formatMonth(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
}

function recentGroup(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((today.getTime() - target.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days <= 7) return "Previous 7 days";
  return formatMonth(value);
}

export function Sidebar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { state } = useAppState();
  const { collapsed, toggleSidebar } = useShellChrome();
  const {
    conversations,
    activeConversationId,
    workspaceSearch,
    setWorkspaceSearch,
    allWorkspaces,
    pinnedSectionOpen,
    setPinnedSectionOpen,
    openConversation,
    openWorkspaces,
    requestWorkspaceCreate,
    requestRename,
    requestDelete,
    togglePinned,
    exportConversation,
    moveToWorkspace,
  } = useConversations();
  const { state: updateState, retry, restart } = useUpdateState();
  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const running = state.runs.filter((run) => run.status === "queued" || run.status === "running");
  const reviewCount = state.runs.filter((run) => run.status === "awaiting-confirmation").length;
  const findingCount = (state.office?.findings ?? []).filter(
    (finding) => finding.tenantId === state.activeTenantId && finding.state === "open",
  ).length;
  const runningLabel = useMemo(() => {
    if (running.length !== 1) return `${running.length} runs in progress`;
    const personaId = running[0]?.office?.personaId;
    const persona = state.office?.personas.find((entry) => entry.id === personaId);
    return persona ? `${persona.name} is working` : "1 run in progress";
  }, [running, state.office?.personas]);
  const pinned = conversations.filter((conversation) => conversation.pinnedAt);
  const recentGroups = useMemo(() => {
    const groups = new Map<string, typeof conversations>();
    for (const conversation of conversations.filter((entry) => !entry.pinnedAt)) {
      const label = recentGroup(conversation.updatedAt);
      groups.set(label, [...(groups.get(label) ?? []), conversation]);
    }
    return [...groups.entries()];
  }, [conversations]);
  const filteredWorkspaces = allWorkspaces.filter((workspace) =>
    `${workspace.title} ${workspace.tenantName ?? ""}`
      .toLocaleLowerCase()
      .includes(workspaceSearch.trim().toLocaleLowerCase()),
  );

  const newChat = () => {
    navigate("/chat?new=1");
  };

  const runConversationAction = (label: string, action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => {
      const detail = userFacingErrorReason(
        error instanceof Error ? error.message : String(error),
      );
      toast.error(
        `${label} failed.${detail ? ` ${detail}` : ""} Try again from the conversation menu.`,
      );
    });
  };

  const focusAdjacent = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches("a[href], button:not([disabled])")) return;
    if (target.closest('[role="menu"], [role="listbox"]')) return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      ),
    ).filter((control) => !control.closest('[role="menu"], [role="listbox"]'));
    const index = controls.indexOf(target);
    if (index < 0 || controls.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % controls.length
            : (index - 1 + controls.length) % controls.length;
    controls[next]?.focus();
  };

  const nav: NavItem[] = [
    {
      to: "/office",
      label: "Agent Team",
      icon: <IconAgentTeam size={14} />,
      count: findingCount || undefined,
      tooltip: findingCount ? `${findingCount} findings to review` : undefined,
    },
    { to: "/agents", label: "Agents", icon: <IconAgents size={14} /> },
    { to: "/runs", label: "Runs", icon: <IconActivity size={14} />, count: reviewCount || undefined },
    { to: "/changes", label: "Changes", icon: <IconChanges size={14} /> },
  ];

  const isMac = window.openAdminOS?.platform === "macos";
  const brand = (
    <>
      <IconLogo size={21} className="text-[var(--color-text)]" />
      <span className="font-semibold tracking-[-0.01em] text-[var(--color-text)]">OpenAdminOS</span>
      {isNightlyVersion(state.appVersion) ? (
        <Tooltip content={`OpenAdminOS ${state.appVersion} is a nightly prerelease built from main. It is less tested than a stable release.`} side="right">
          <span className="app-region-no-drag rounded-md bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]">Nightly</span>
        </Tooltip>
      ) : null}
    </>
  );

  return (
    <aside
      aria-label="Application navigation"
      aria-hidden={collapsed}
      inert={collapsed}
      data-collapsed={collapsed}
      onKeyDown={focusAdjacent}
      className={`app-sidebar shrink-0 overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)] transition-[width,border] duration-150 motion-reduce:transition-none ${
        collapsed ? "w-0 border-r-0" : "w-[268px]"
      }`}
    >
      <div className="flex h-full w-[268px] flex-col">
        {/* macOS keeps a dedicated top row for the traffic-light buttons; elsewhere
            the brand shares the row with the collapse control. */}
        <div className={`flex h-[52px] shrink-0 items-center gap-2 px-3 ${isMac || window.openAdminOS?.platform === "windows" ? "app-region-drag" : ""}`}>
          {isMac ? <span className="w-[76px]" /> : brand}
          <Tooltip content="Collapse sidebar" side="right" className="ml-auto">
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              className="app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--color-text-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              <IconArrowLeft size={14} />
            </button>
          </Tooltip>
        </div>

        {isMac ? <div className="flex h-10 shrink-0 items-center gap-2 px-3">{brand}</div> : null}

        <nav aria-label="Primary" className="space-y-0.5 px-2 py-2">
          <button
            type="button"
            onClick={newChat}
            className="group flex h-[var(--nav-h)] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-base text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            <IconPlus size={14} className="w-4 text-[var(--color-text-muted)]" />
            <span className="flex-1">New chat</span>
            <Kbd className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{shortcutLabel("newConversation")}</Kbd>
          </button>
          <button
            type="button"
            onClick={onOpenPalette}
            className="group flex h-[var(--nav-h)] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-base text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            <IconSearch size={14} className="w-4 text-[var(--color-text-muted)]" />
            <span className="flex-1">Search</span>
            <Kbd className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{shortcutLabel("commandPalette")}</Kbd>
          </button>
          {nav.map((item) => <NavRow key={item.to} item={item} />)}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {pinned.length > 0 ? (
            <SidebarSection
              label="Pinned"
              count={pinned.length}
              open={pinnedSectionOpen}
              onToggle={() => setPinnedSectionOpen((current) => !current)}
            >
              {pinned.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  tenants={state.tenants}
                  onOpen={() => openConversation(conversation.id)}
                  onRename={() => requestRename(conversation)}
                  onPin={() => runConversationAction("Pinning the conversation", () => togglePinned(conversation))}
                  onExport={() => runConversationAction("Exporting the conversation", () => exportConversation(conversation))}
                  onMove={() => runConversationAction("Moving the conversation", () => moveToWorkspace(conversation))}
                  onDelete={() => requestDelete(conversation)}
                />
              ))}
            </SidebarSection>
          ) : null}

          <SidebarSection
            label="Workspaces"
            count={allWorkspaces.length}
            open={workspacesOpen}
            onToggle={() => setWorkspacesOpen((current) => !current)}
            action={
              <button
                type="button"
                aria-label="Create workspace"
                onClick={(event) => {
                  event.stopPropagation();
                  requestWorkspaceCreate();
                  openWorkspaces();
                }}
                className="rounded-[6px] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              >
                <IconPlus size={11} />
              </button>
            }
          >
            <div className="relative mb-1.5 px-1">
              <IconCommand size={11} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="search"
                name="workspace-search"
                autoComplete="off"
                aria-label="Search workspaces"
                value={workspaceSearch}
                onChange={(event) => setWorkspaceSearch(event.target.value)}
                placeholder="Search workspaces…"
                className="h-7 w-full rounded-[7px] bg-[var(--color-raised)] pl-7 pr-2 text-xs text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-placeholder)] focus:ring-[var(--color-accent)]"
              />
            </div>
            {filteredWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                title={workspace.title}
                onClick={() => openWorkspaces(workspace.id)}
                className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-sm text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              >
                <IconHardDrive size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="truncate">{workspace.title}</span>
              </button>
            ))}
            {filteredWorkspaces.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">{workspaceSearch ? "No matching workspaces." : "No workspaces yet."}</div>
            ) : null}
          </SidebarSection>

          {recentGroups.map(([label, entries]) => (
            <div key={label} className="mt-3">
              <div className="px-2.5 pb-1 text-sm text-[var(--color-text-muted)]">{label}</div>
              {entries.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  tenants={state.tenants}
                  onOpen={() => openConversation(conversation.id)}
                  onRename={() => requestRename(conversation)}
                  onPin={() => runConversationAction("Pinning the conversation", () => togglePinned(conversation))}
                  onExport={() => runConversationAction("Exporting the conversation", () => exportConversation(conversation))}
                  onMove={() => runConversationAction("Moving the conversation", () => moveToWorkspace(conversation))}
                  onDelete={() => requestDelete(conversation)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-[var(--color-border-soft)] p-2">
          {running.length > 0 ? (
            <NavLink to="/runs" className="flex min-h-8 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-xs text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-[var(--color-info)]" />
              <span className="truncate">{runningLabel}</span>
            </NavLink>
          ) : null}
          {updateState.status === "downloading" ? (
            <div role="status" className="flex min-h-8 items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--color-text-muted)]">
              <IconRefresh size={11} className="animate-spin" />
              <span>Downloading update{typeof updateState.progress === "number" ? ` · ${Math.round(updateState.progress)}%` : ""}</span>
            </div>
          ) : updateState.status === "ready" ? (
            <div role="status" className="flex min-h-8 items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--color-text-soft)]">
              <span className="min-w-0 flex-1 truncate">Update ready</span>
              <button type="button" onClick={() => void restart()} className="rounded-[4px] font-medium text-[var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">Restart</button>
            </div>
          ) : updateState.status === "error" ? (
            <div role="alert" className="rounded-[8px] bg-[var(--color-danger-soft)] px-2.5 py-2 text-xs text-[var(--color-danger)]">
              <div className="line-clamp-2">{updateState.message ?? "The update check failed."}</div>
              <button type="button" onClick={() => void retry()} className="mt-1 inline-flex items-center gap-1 rounded-[4px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-danger)]"><IconRefresh size={10} /> Retry</button>
            </div>
          ) : null}
          <AccountRow activeTenant={activeTenant} tenantCount={state.tenants.length} nightly={isNightlyVersion(state.appVersion)} />
        </div>
      </div>
    </aside>
  );
}

function SidebarSection({
  label,
  count,
  open,
  onToggle,
  action,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[7px] px-2 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          {open ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />}
          <span>{label}</span>
          <span className="tabular-nums opacity-70">{count}</span>
        </button>
        {action}
      </div>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  tenants,
  onOpen,
  onRename,
  onPin,
  onExport,
  onMove,
  onDelete,
}: {
  conversation: ReturnType<typeof useConversations>["conversations"][number];
  active: boolean;
  tenants: ReturnType<typeof useAppState>["state"]["tenants"];
  onOpen: () => void;
  onRename: () => void;
  onPin: () => void;
  onExport: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const tenant = tenants.find((entry) => entry.id === conversation.tenantId);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [contextMenu]);

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 112)),
    });
  };

  return (
    <div className={`group relative flex items-center rounded-[8px] ${active ? "bg-[var(--color-active)]" : "hover:bg-[var(--color-hover)]"}`}>
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={openContextMenu}
        title={conversation.title}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2.5 pr-8 text-left text-sm text-[var(--color-text-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
      >
        {conversation.scopeKind === "multi-tenant" ? (
          <MultiTenantTile />
        ) : tenant ? (
          <TenantTile tenantId={tenant.id} displayName={tenant.displayName} size="xs" />
        ) : (
          <span className="h-4 w-4 rounded-[4px] bg-[var(--color-raised)] ring-1 ring-[var(--color-border-soft)]" />
        )}
        <span className={`truncate ${active ? "font-medium text-[var(--color-text)]" : ""}`}>{conversation.title}</span>
      </button>
      <Menu
        ariaLabel={`Actions for ${conversation.title}`}
        trigger={
          <button
            type="button"
            aria-label={`More actions for ${conversation.title}`}
            className="absolute right-1 inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-raised)] hover:text-[var(--color-text)] focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] group-hover:opacity-100"
          >
            <span aria-hidden="true" className="text-base leading-none">···</span>
          </button>
        }
        items={[
          { id: "pin", label: conversation.pinnedAt ? "Unpin" : "Pin", icon: <IconStar size={11} />, onSelect: onPin },
          { id: "rename", label: "Rename", icon: <IconChat size={11} />, onSelect: onRename },
          { id: "move", label: "Move to workspace", icon: <IconHardDrive size={11} />, disabled: conversation.scopeKind === "multi-tenant", onSelect: onMove },
          { id: "export", label: "Export", icon: <IconDownload size={11} />, onSelect: onExport },
          { type: "separator", id: "delete-separator" },
          { id: "delete", label: "Delete", danger: true, onSelect: onDelete },
        ]}
      />
      {contextMenu ? (
        <div
          role="menu"
          aria-label={`Local conversation actions for ${conversation.title}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-[90] w-[220px] overflow-hidden rounded-[14px] bg-[var(--color-raised)] shadow-[var(--shadow-pop)]"
        >
          <div className="border-b border-[var(--color-border-soft)] px-3 py-2">
            <div className="truncate text-sm font-medium text-[var(--color-text)]">
              {conversation.title}
            </div>
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Local conversation
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              onDelete();
            }}
            className="flex w-full items-center px-3 py-2 text-left text-base text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-danger)]"
          >
            Delete conversation
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AccountRow({
  activeTenant,
  tenantCount,
  nightly,
}: {
  activeTenant: ReturnType<typeof useAppState>["state"]["tenants"][number] | undefined;
  tenantCount: number;
  nightly: boolean;
}) {
  const navigate = useNavigate();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const initials = activeTenant?.username
    .split("@")[0]
    ?.split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "OA";
  return (
    <>
      <Menu
        align="start"
        ariaLabel="Account and application"
        className="mt-1 w-full"
        trigger={
          <button type="button" className="flex min-h-11 w-full items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-raised)] text-xs font-semibold text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)]">{initials}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--color-text)]">{activeTenant?.username ?? "No tenant"}</span>
              <span className="block text-xs text-[var(--color-text-muted)]">{tenantCount} tenant{tenantCount === 1 ? "" : "s"}</span>
            </span>
            <IconChevronRight size={11} className="text-[var(--color-text-muted)]" />
          </button>
        }
        items={[
          { id: "settings", label: `Settings (${shortcutLabel("settings")})`, icon: <IconSettings size={12} />, onSelect: () => navigate("/settings") },
          { id: "tenants", label: "Tenants", onSelect: () => navigate("/settings/tenants") },
          { id: "voice", label: "Voice (Alt+V)", icon: <IconSparkle size={12} />, onSelect: openNovaPanel },
          { id: "shortcuts", label: "Keyboard shortcuts", onSelect: () => setShortcutsOpen(true) },
          { type: "separator", id: "about-separator" },
          { id: "about", label: nightly ? "About and updates · Nightly" : "About and updates", onSelect: () => navigate("/settings/about") },
        ]}
      />
      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} size="md">
        <ModalHeader title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)} />
        <div className="divide-y divide-[var(--color-border-soft)] px-6 py-3">
          {Object.values(SHORTCUTS).map((shortcut) => (
            <div key={shortcut.command} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span className="text-[var(--color-text-soft)]">{shortcut.label}</span>
              <Kbd>{shortcutLabel(shortcut.command)}</Kbd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 py-3 text-sm">
            <span className="text-[var(--color-text-soft)]">Open Voice</span>
            <Kbd>Alt+V</Kbd>
          </div>
        </div>
      </Modal>
    </>
  );
}
