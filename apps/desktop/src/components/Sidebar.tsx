import { NavLink } from "react-router";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  IconAgents,
  IconChanges,
  IconChat,
  IconSettings,
  IconLogo,
  IconCommand,
} from "./icons";
import { TenantSwitcher } from "./TenantSwitcher";
import { useAppState } from "../state";
import { shortcutLabel } from "../shared/shortcuts";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  badge?: string | number;
  badgeTone?: "default" | "warning";
  indent?: boolean;
}

function NavRow({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `group relative flex items-center gap-2.5 rounded-lg py-1.5 text-[13px] font-medium transition-colors duration-150 ${
          isActive
            ? "bg-gradient-to-r from-[var(--color-surface-hover)] to-[var(--color-surface)] text-[var(--color-text)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]"
            : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        } ${item.indent ? "ml-5 px-2" : "px-2.5"}`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-[var(--color-accent)]" />
          )}
          <span
            className={
              isActive
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-muted)] group-hover:text-[var(--color-text-soft)]"
            }
          >
            {item.icon}
          </span>
          <span className="flex-1">{item.label}</span>
          {item.badge !== undefined && (
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums ${
                item.badgeTone === "warning"
                  ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                  : isActive
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]"
              }`}
            >
              {item.badgeTone === "warning" && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
              )}
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { state } = useAppState();
  const active = state.providers.find((p) => p.id === state.activeProviderId);
  const mainNav: NavItem[] = [
    {
      to: "/chat",
      label: "Chat",
      icon: <IconChat size={16} />,
    },
    {
      to: "/agents",
      label: "Agents",
      icon: <IconAgents size={16} />,
      badge: state.installedAgents.length,
    },
    { to: "/changes", label: "Changes", icon: <IconChanges size={16} /> },
    { to: "/settings", label: "Settings", icon: <IconSettings size={16} /> },
  ];

  const focusAdjacentNav = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || links.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % links.length
            : (index - 1 + links.length) % links.length;
    links[next]?.focus();
  };

  return (
    <aside
      aria-label="Application navigation"
      className="flex h-full w-[252px] shrink-0 flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)]"
      onKeyDown={focusAdjacentNav}
    >
      {/* Brand row — small */}
      <div className="flex h-12 items-center gap-2 px-3.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <IconLogo size={13} />
        </div>
        <div className="flex items-center gap-1.5 leading-none">
          <span className="text-[12px] font-semibold tracking-tight text-[var(--color-text)]">
            OpenAdminOS
          </span>
          <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--color-text-muted)]">
            v{__APP_VERSION__}
          </span>
        </div>
        <span
          title={
            active?.status === "connected"
              ? `${active.name} reachable`
              : "LLM provider not reachable"
          }
          className={`ml-auto inline-flex h-1.5 w-1.5 animate-pulse-soft rounded-full ${
            active?.status === "connected"
              ? "bg-[var(--color-success)]"
              : "bg-[var(--color-warning)]"
          }`}
        />
      </div>

      {/* Tenant switcher */}
      <TenantSwitcher />

      {/* Command palette */}
      <button
        onClick={onOpenPalette}
        className="mx-2.5 mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-soft)]"
      >
        <IconCommand size={12} />
        <span className="flex-1 text-left">Quick search</span>
        <kbd className="font-mono text-[10px]">{shortcutLabel("commandPalette")}</kbd>
      </button>

      <div className="mx-3 mb-2 mt-3 h-px bg-[var(--color-border-soft)]" />

      {/* Main nav */}
      <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
        <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Workspace
        </div>
        {mainNav.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}
      </nav>

      <div className="mt-auto px-4 pb-4 pt-6 font-mono text-[10px] leading-4 text-[var(--color-text-muted)]">
        Local desktop workspace
      </div>
    </aside>
  );
}
