import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  IconActivity,
  IconAgents,
  IconBolt,
  IconChanges,
  IconChat,
  IconClock,
  IconConnectors,
  IconHardDrive,
  IconHub,
  IconPlay,
  IconSearch,
  IconSettings,
  IconShield,
} from "./icons";
import { useAppState } from "../state";
import { SETTINGS_ITEMS, SETTINGS_SECTIONS } from "../copy";
import { formatAgentDisplayName } from "../shared/agent-display";
import { registerOverlay } from "../shared/overlay-stack";
import { createPendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: "Agents" | "Hub" | "Navigate" | "Actions";
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { state, registryAgents, startRun } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const overlayIdRef = useRef(`command-palette-${window.crypto.randomUUID()}`);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const items: PaletteItem[] = useMemo(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    return [
      ...state.installedAgents.map((a) => ({
        id: `agent-${a.id}`,
        label: formatAgentDisplayName(a),
        hint: `${a.mode === "write" ? "Write" : "Read-only"} · ${a.version}`,
        group: "Agents" as const,
        icon:
          a.mode === "write" ? (
            <IconBolt size={13} className="text-[var(--color-warning)]" />
          ) : (
            <IconShield size={13} className="text-[var(--color-text-soft)]" />
          ),
        shortcut: "↵ Open",
        action: go(`/agents/${a.slug}`),
      })),
      ...registryAgents.map((a) => ({
        id: `hub-${a.id}`,
        label: formatAgentDisplayName(a),
        hint: `Hub · ${a.author.name}`,
        group: "Hub" as const,
        icon: <IconHub size={13} className="text-[var(--color-text-soft)]" />,
        action: go("/agents/hub"),
      })),
      {
        id: "nav-chat",
        label: "Go to Chat",
        group: "Navigate",
        icon: <IconChat size={13} className="text-[var(--color-accent)]" />,
        action: go("/chat"),
      },
      {
        id: "nav-agents",
        label: "Go to Agents",
        group: "Navigate",
        icon: <IconAgents size={13} className="text-[var(--color-accent)]" />,
        action: go("/agents"),
      },
      {
        id: "nav-hub",
        label: "Go to Hub",
        group: "Navigate",
        icon: <IconHub size={13} className="text-[var(--color-accent)]" />,
        action: go("/agents/hub"),
      },
      {
        id: "nav-schedules",
        label: "Go to Schedules",
        hint: "Review active agent schedules",
        group: "Navigate",
        icon: <IconClock size={13} className="text-[var(--color-accent)]" />,
        action: go("/agents/schedules"),
      },
      {
        id: "nav-changes",
        label: "Go to Changes",
        group: "Navigate",
        icon: <IconChanges size={13} className="text-[var(--color-accent)]" />,
        action: go("/changes"),
      },
      {
        id: "nav-activity",
        label: "Go to Run history",
        group: "Navigate",
        icon: <IconActivity size={13} className="text-[var(--color-accent)]" />,
        action: go("/activity"),
      },
      {
        id: "nav-workspaces",
        label: "Go to Workspaces",
        group: "Navigate",
        icon: <IconHardDrive size={13} className="text-[var(--color-accent)]" />,
        action: go("/workspaces"),
      },
      {
        id: "nav-connectors",
        label: "Go to Connectors",
        group: "Navigate",
        icon: <IconConnectors size={13} className="text-[var(--color-accent)]" />,
        action: go("/connectors"),
      },
      {
        id: "nav-settings",
        label: "Open Settings",
        group: "Navigate",
        icon: <IconSettings size={13} className="text-[var(--color-accent)]" />,
        action: go("/settings"),
      },
      ...SETTINGS_SECTIONS.map((entry) => ({
        id: `settings-section-${entry.id}`,
        label: `Settings: ${entry.title}`,
        hint: entry.description,
        group: "Navigate" as const,
        icon: <IconSettings size={13} className="text-[var(--color-accent)]" />,
        action: go(`/settings/${entry.id}`),
      })),
      ...Object.entries(SETTINGS_ITEMS).map(([id, entry]) => ({
        id: `settings-item-${id}`,
        label: entry.title,
        hint: `Settings · ${entry.description}`,
        group: "Navigate" as const,
        icon: <IconSettings size={13} className="text-[var(--color-text-soft)]" />,
        action: go(`/settings/${entry.section}?target=${id}`),
      })),
      ...(state.installedAgents.length > 0
        ? ([
            {
              id: "act-run-first",
              label: `Run ${state.installedAgents[0]!.name}`,
              hint:
                state.installedAgents.length === 1
                  ? "Queue your installed agent"
                  : `Run the first of ${state.installedAgents.length} installed agents`,
              group: "Actions",
              icon: <IconPlay size={13} className="text-[var(--color-accent)]" />,
              action: async () => {
                const agent = state.installedAgents[0]!;
                if (
                  !requireTenantAndProvider(
                    createPendingIntent({
                      kind: "agent-run",
                      slug: agent.slug,
                      returnTo: `/agents/${encodeURIComponent(agent.slug)}`,
                    }),
                  )
                ) {
                  onClose();
                  return;
                }
                const run = await startRun(agent.slug);
                navigate(`/runs/${run.id}`);
                onClose();
              },
            },
          ] as PaletteItem[])
        : ([
            {
              id: "act-browse-hub",
              label: "Browse agents to install",
              hint: "Install an agent before running",
              group: "Actions",
              icon: <IconHub size={13} className="text-[var(--color-accent)]" />,
              action: go("/agents/hub"),
            },
          ] as PaletteItem[])),
    ];
  }, [navigate, onClose, registryAgents, requireTenantAndProvider, startRun, state.installedAgents]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.hint?.toLowerCase().includes(q) ||
        i.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  const grouped = useMemo(() => {
    const order: PaletteItem["group"][] = ["Actions", "Navigate", "Agents", "Hub"];
    const map: Record<string, PaletteItem[]> = {};
    for (const i of filtered) {
      if (!map[i.group]) map[i.group] = [];
      map[i.group].push(i);
    }
    return order.filter((g) => map[g]).map((g) => ({ group: g, items: map[g] }));
  }, [filtered]);

  // flat order for keyboard nav
  const flatList = grouped.flatMap((g) => g.items);

  useEffect(() => {
    if (open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setActiveIndex(0);
      setActionError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
      const unregister = registerOverlay({
        id: overlayIdRef.current,
        onEscape: () => onCloseRef.current(),
      });
      return () => {
        unregister();
        window.requestAnimationFrame(() => returnFocusRef.current?.focus());
      };
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
    setActionError(null);
  }, [query]);

  const runAction = (item: PaletteItem) => {
    setActionError(null);
    void Promise.resolve(item.action()).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const onPaletteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0] ?? dialog;
      const last = focusable.at(-1) ?? dialog;
      const active = document.activeElement;
      if (
        focusable.length <= 1 ||
        (e.shiftKey && active === first) ||
        (!e.shiftKey && active === last)
      ) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, flatList.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatList[activeIndex];
      if (item) runAction(item);
    }
  };

  useEffect(() => {
    const activeId = flatList[activeIndex]?.id;
    if (!activeId) return;
    document.getElementById(`command-option-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flatList]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-6 pt-[12vh]"
      style={{ background: "rgba(10, 8, 6, 0.55)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        tabIndex={-1}
        className="w-full max-w-[640px] overflow-hidden rounded-2xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPaletteKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
          <IconSearch size={15} className="text-[var(--color-text-muted)]" />
          <label htmlFor="command-palette-search" className="sr-only">
            Search commands, agents, or pages
          </label>
          <input
            id="command-palette-search"
            name="command-palette-search"
            type="search"
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, agent name, or page…"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-autocomplete="list"
            aria-activedescendant={
              flatList[activeIndex] ? `command-option-${flatList[activeIndex]!.id}` : undefined
            }
            className="flex-1 bg-transparent text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none"
          />
          <kbd className="rounded-md bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
            esc
          </kbd>
        </div>

        {actionError && (
          <div
            role="alert"
            className="mx-3 mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
          >
            {actionError}
          </div>
        )}

        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Command results"
          className="max-h-[440px] overscroll-contain overflow-y-auto py-1"
        >
          {grouped.length === 0 && (
            <div role="status" className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
              No matches for “{query}”. Try a page, setting, or agent name.
            </div>
          )}
          {grouped.map((g) => (
            <div key={g.group} className="px-1.5 py-1">
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                {g.group}
              </div>
              {g.items.map((it) => {
                const flatIdx = flatList.indexOf(it);
                const isActive = flatIdx === activeIndex;
                return (
                  <button
                    key={it.id}
                    id={`command-option-${it.id}`}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => runAction(it)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "bg-[var(--color-surface-hover)]"
                        : "hover:bg-[var(--color-surface)]"
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
                      {it.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--color-text)]">
                        {it.label}
                      </span>
                      {it.hint && (
                        <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                          {it.hint}
                        </span>
                      )}
                    </span>
                    {isActive && (
                      <kbd className="rounded-md bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)]">
                        ↵
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-2.5 text-[10.5px] text-[var(--color-text-muted)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> Select
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>esc</Kbd> Close
            </span>
          </div>
          <span className="font-mono">{flatList.length} results</span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-[var(--color-bg-raised)] px-1.5 py-px font-mono text-[10px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)]">
      {children}
    </kbd>
  );
}
