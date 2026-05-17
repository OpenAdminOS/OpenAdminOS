import { NavLink } from "react-router";
import type { ReactNode } from "react";
import {
  IconAgents,
  IconHub,
  IconActivity,
  IconSettings,
  IconLogo,
  IconHardDrive,
  IconCommand,
  IconChevronDown,
} from "./icons";
import { StatusDot } from "./Pill";
import { Avatar } from "./Avatar";
import { Sparkline } from "./Sparkline";
import { TenantSwitcher } from "./TenantSwitcher";
import { useAppState } from "../state";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  badge?: string | number;
  badgeTone?: "default" | "warning";
}

function NavRow({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all duration-150 ${
          isActive
            ? "bg-gradient-to-r from-[var(--color-surface-hover)] to-[var(--color-surface)] text-[var(--color-text)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]"
            : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        }`
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
  const activeRunCount = state.runs.filter(
    (run) =>
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting-confirmation",
  ).length;
  const mainNav: NavItem[] = [
    {
      to: "/",
      label: "Agents",
      icon: <IconAgents size={16} />,
      end: true,
      badge: state.installedAgents.length,
    },
    { to: "/hub", label: "Agent Hub", icon: <IconHub size={16} /> },
    {
      to: "/activity",
      label: "Activity",
      icon: <IconActivity size={16} />,
      badge: activeRunCount > 0 ? activeRunCount : undefined,
      badgeTone: activeRunCount > 0 ? "warning" : undefined,
    },
  ];

  const runsByDay = runsForLastSevenDays(state.runs.map((run) => run.queuedAt));
  const runsByDayLabels = ["M", "T", "W", "T", "F", "S", "S"];
  const runsThisWeek = runsByDay.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...runsByDay);
  const peakIdx = peak > 0 ? runsByDay.indexOf(peak) : -1;

  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-sidebar-solid)]">
      {/* Brand row — small */}
      <div className="flex h-12 items-center gap-2 px-3.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <IconLogo size={13} />
        </div>
        <div className="flex items-center gap-1.5 leading-none">
          <span className="text-[12px] font-semibold tracking-tight text-[var(--color-text)]">
            Open Agents
          </span>
          <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--color-text-muted)]">
            v0.1.4
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
        <kbd className="font-mono text-[10px]">⌘K</kbd>
      </button>

      <div className="mx-3 mb-2 mt-3 h-px bg-[var(--color-border-soft)]" />

      {/* Main nav */}
      <nav className="flex flex-col gap-0.5 px-2">
        <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Workspace
        </div>
        {mainNav.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}
      </nav>

      {/* Activity sparkline card */}
      <div className="mx-2.5 mt-5 rounded-xl bg-[var(--color-surface)] p-3 ring-1 ring-[var(--color-border-soft)]">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Runs · last 7d
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-[var(--color-text-soft)]">
            {runsThisWeek}
          </span>
        </div>
        <div className="mt-2">
          <Sparkline data={runsByDay} height={28} />
        </div>
        <div className="mt-1 grid grid-cols-7 text-center font-mono text-[9px] text-[var(--color-text-faint)]">
          {runsByDayLabels.map((d, i) => (
            <span
              key={i}
              className={
                i === peakIdx
                  ? "font-medium text-[var(--color-accent)]"
                  : i === runsByDay.length - 1
                    ? "text-[var(--color-text-soft)]"
                    : ""
              }
            >
              {d}
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--color-text-muted)]">
          <StatusDot tone="warning" />
          <span className="truncate">
            {runsThisWeek === 0 ? "No runs recorded yet" : "Recent run activity"}
          </span>
        </div>
      </div>

      {/* Spacer pushes footer down */}
      <div className="flex-1" />

      {/* User row + Settings + Provider strip */}
      <div className="mx-2.5 mb-3 flex flex-col gap-2 rounded-xl bg-[var(--color-surface)] p-2 ring-1 ring-[var(--color-border-soft)]">
        {/* User row */}
        <button className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-[var(--color-surface-hover)]">
          <Avatar name="Ugur Koc" size={26} />
          <div className="min-w-0 flex-1 text-left leading-tight">
            <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
              Ugur Koc
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              you · admin
            </div>
          </div>
          <IconChevronDown size={11} className="text-[var(--color-text-muted)]" />
        </button>

        {/* Provider chip */}
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-2.5 py-2 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Provider
            </span>
            <StatusDot tone={active?.status === "connected" ? "success" : "warning"} />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <IconHardDrive size={11} className="text-[var(--color-success)]" />
            <span className="text-[12px] font-medium text-[var(--color-text)]">
              {active?.name ?? "No provider"}
            </span>
            <span className="ml-auto font-mono text-[9.5px] text-[var(--color-text-muted)]">
              {active?.defaultModel ?? "-"}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
            {state.trust.detail}
          </div>
        </div>

        {/* Settings */}
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors ${
              isActive
                ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            }`
          }
        >
          <IconSettings size={13} className="text-[var(--color-text-muted)]" />
          <span>Settings</span>
        </NavLink>
      </div>
    </aside>
  );
}

function runsForLastSevenDays(startedAtValues: string[]) {
  const days = Array.from({ length: 7 }, () => 0);
  const now = new Date();

  for (const startedAt of startedAtValues) {
    const started = new Date(startedAt);
    if (Number.isNaN(started.getTime())) {
      continue;
    }

    const ageDays = Math.floor(
      (startOfDay(now).getTime() - startOfDay(started).getTime()) / 86_400_000,
    );

    if (ageDays >= 0 && ageDays < 7) {
      days[6 - ageDays] += 1;
    }
  }

  return days;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}
