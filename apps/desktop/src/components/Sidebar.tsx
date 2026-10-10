import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { NavLink } from "react-router";
import {
  IconActivity,
  IconAgents,
  IconChanges,
  IconChat,
  IconChevronRight,
  IconCommand,
  IconSettings,
  IconSparkle,
} from "./icons";
import { TenantSwitcher } from "./TenantSwitcher";
import { useAppState } from "../state";
import { shortcutLabel } from "../shared/shortcuts";
import { openNovaPanel } from "../shared/nova-panel";
import { Badge, Kbd, Tooltip } from "./ui";

export const SIDEBAR_COLLAPSED_KEY = "openadminos:sidebar-collapsed:v1";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group relative flex h-9 items-center rounded-lg text-base font-medium transition-colors duration-150 ${
          collapsed ? "justify-center px-2" : "gap-2.5 px-2.5"
        } ${
          isActive
            ? "bg-[var(--color-bg-raised)] text-[var(--color-text)]"
            : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-[var(--color-accent)]" />
          ) : null}
          <span
            className={`inline-flex shrink-0 ${
              isActive
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-muted)] group-hover:text-[var(--color-text-soft)]"
            }`}
          >
            {item.icon}
          </span>
          <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>
            {item.label}
          </span>
          {item.badge && item.badge > 0 ? (
            <Badge
              tone="warning"
              className={
                collapsed
                  ? "absolute right-0.5 top-0.5 min-w-4 justify-center px-1 tabular-nums"
                  : "shrink-0 tabular-nums"
              }
            >
              {item.badge}
            </Badge>
          ) : null}
        </>
      )}
    </NavLink>
  );

  return (
    <Tooltip content={item.label} side="right" disabled={!collapsed} className="block w-full">
      {link}
    </Tooltip>
  );
}

function readInitialCollapsed() {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return window.innerWidth < 1000;
}

export function Sidebar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { state } = useAppState();
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);
  const reviewCount = state.runs.filter(
    (run) => run.status === "awaiting-confirmation",
  ).length;

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const items: NavItem[] = [
    { to: "/chat", label: "Chat", icon: <IconChat size={17} /> },
    { to: "/agents", label: "Agents", icon: <IconAgents size={17} /> },
    {
      to: "/runs",
      label: "Runs",
      icon: <IconActivity size={17} />,
      badge: reviewCount || undefined,
    },
    { to: "/changes", label: "Changes", icon: <IconChanges size={17} /> },
    { to: "/settings", label: "Settings", icon: <IconSettings size={17} /> },
  ];

  const focusAdjacentNav = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled])",
      ),
    );
    const index = controls.indexOf(document.activeElement as HTMLElement);
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

  return (
    <aside
      aria-label="Application navigation"
      data-collapsed={collapsed}
      className="app-sidebar flex h-full shrink-0 flex-col overflow-visible border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)] transition-[width] duration-150 motion-reduce:transition-none"
      onKeyDown={focusAdjacentNav}
    >
      <div className="pt-2">
        <TenantSwitcher collapsed={collapsed} />
      </div>

      <div className={collapsed ? "mx-2 mt-3" : "mx-2.5 mt-3"}>
        <Tooltip content="Search" side="right" disabled={!collapsed} className="block w-full">
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Search"
            className={`flex h-9 w-full items-center rounded-lg bg-[var(--color-bg-raised)] text-sm text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${
              collapsed ? "justify-center px-2" : "gap-2 px-2.5"
            }`}
          >
            <IconCommand size={14} />
            <span className={collapsed ? "sr-only" : "flex-1 text-left"}>Search</span>
            {!collapsed ? <Kbd>{shortcutLabel("commandPalette")}</Kbd> : null}
          </button>
        </Tooltip>
      </div>

      <nav aria-label="Primary" className="mt-3 flex flex-col gap-1 px-2">
        {items.map((item) => (
          <NavRow key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>

      <div className="mt-auto space-y-1 border-t border-[var(--color-border-soft)] p-2">
        <Tooltip content="Voice" side="right" disabled={!collapsed} className="block w-full">
          <button
            type="button"
            onClick={openNovaPanel}
            aria-label="Voice"
            className={`flex h-9 w-full items-center rounded-lg text-base font-medium text-[var(--color-text-soft)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${
              collapsed ? "justify-center px-2" : "gap-2.5 px-2.5"
            }`}
          >
            <IconSparkle size={17} />
            <span className={collapsed ? "sr-only" : "flex-1 text-left"}>Voice</span>
            {!collapsed ? <Kbd>Alt+V</Kbd> : null}
          </button>
        </Tooltip>

        <Tooltip
          content={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          side="right"
          disabled={!collapsed}
          className="block w-full"
        >
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`flex h-8 w-full items-center rounded-md text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${
              collapsed ? "justify-center" : "justify-end gap-2 px-2.5"
            }`}
          >
            {!collapsed ? <span>Collapse</span> : null}
            <IconChevronRight
              size={14}
              className={collapsed ? "" : "rotate-180"}
            />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
