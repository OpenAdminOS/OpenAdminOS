import { NavLink, Outlet } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";

const tabs = [
  { to: "/agents", label: "Installed", end: true },
  { to: "/agents/hub", label: "Hub", end: false },
  { to: "/agents/schedules", label: "Schedules", end: false },
] as const;

export default function Agents() {
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Installed agents, the community hub, and recurring schedules."
      />
      <PageBody>
        <div className="mb-6 flex flex-wrap items-center gap-1.5">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                    : "bg-transparent text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
        <Outlet />
      </PageBody>
    </>
  );
}
