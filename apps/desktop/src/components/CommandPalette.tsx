import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  IconActivity,
  IconAgents,
  IconBolt,
  IconHub,
  IconPlay,
  IconSearch,
  IconSettings,
  IconShield,
} from "./icons";
import { installedAgents, hubAgents } from "../data/agents";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: "Agents" | "Hub" | "Navigate" | "Actions";
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items: PaletteItem[] = useMemo(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    return [
      ...installedAgents.map((a) => ({
        id: `agent-${a.id}`,
        label: a.name,
        hint: `${a.mode === "write" ? "Write" : "Read-only"} · ${a.author.name}`,
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
      ...hubAgents.map((a) => ({
        id: `hub-${a.id}`,
        label: a.name,
        hint: `Hub · ${a.author.name}`,
        group: "Hub" as const,
        icon: <IconHub size={13} className="text-[var(--color-text-soft)]" />,
        action: go("/hub"),
      })),
      {
        id: "nav-agents",
        label: "Go to Agents",
        group: "Navigate",
        icon: <IconAgents size={13} className="text-[var(--color-accent)]" />,
        action: go("/"),
      },
      {
        id: "nav-hub",
        label: "Go to Agent Hub",
        group: "Navigate",
        icon: <IconHub size={13} className="text-[var(--color-accent)]" />,
        action: go("/hub"),
      },
      {
        id: "nav-activity",
        label: "Go to Activity",
        group: "Navigate",
        icon: <IconActivity size={13} className="text-[var(--color-accent)]" />,
        action: go("/activity"),
      },
      {
        id: "nav-settings",
        label: "Open Settings",
        group: "Navigate",
        icon: <IconSettings size={13} className="text-[var(--color-accent)]" />,
        action: go("/settings"),
      },
      {
        id: "act-run-fid",
        label: "Run · Find inactive devices",
        hint: "Read-only · Ollama",
        group: "Actions",
        icon: <IconPlay size={13} className="text-[var(--color-accent)]" />,
        action: go("/runs/last"),
      },
      {
        id: "act-run-retire",
        label: "Run · Retire inactive devices",
        hint: "Write · pauses for diff confirmation",
        group: "Actions",
        icon: <IconPlay size={13} className="text-[var(--color-warning)]" />,
        action: go("/agents/retire-inactive-devices/confirm"),
      },
    ];
  }, [navigate, onClose]);

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
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatList.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        flatList[activeIndex]?.action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flatList, activeIndex, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-6 pt-[12vh]"
      style={{ background: "rgba(10, 8, 6, 0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[640px] overflow-hidden rounded-2xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
          <IconSearch size={15} className="text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, agent name, or page…"
            className="flex-1 bg-transparent text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
          />
          <kbd className="rounded-md bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
            ESC
          </kbd>
        </div>

        <div className="max-h-[440px] overflow-y-auto py-1">
          {grouped.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
              No matches for "{query}"
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
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => it.action()}
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
