import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";

const runs = [
  {
    agent: "Find inactive devices",
    when: "2 hours ago",
    duration: "8.2s",
    result: "47 devices flagged",
    status: "ok",
    tenant: "UgurLabs",
    cost: "$0.00",
  },
  {
    agent: "Encryption status audit",
    when: "5 hours ago",
    duration: "12.4s",
    result: "12 devices unencrypted",
    status: "ok",
    tenant: "UgurLabs",
    cost: "$0.00",
  },
  {
    agent: "Compliance overview",
    when: "Yesterday",
    duration: "18.7s",
    result: "Compliance posture: 94%",
    status: "ok",
    tenant: "UgurLabs",
    cost: "$0.00",
  },
  {
    agent: "Find inactive devices",
    when: "Yesterday",
    duration: "7.8s",
    result: "44 devices flagged",
    status: "ok",
    tenant: "UgurLabs",
    cost: "$0.00",
  },
  {
    agent: "Retire inactive devices",
    when: "2 days ago",
    duration: "—",
    result: "Cancelled at diff confirmation",
    status: "cancelled",
    tenant: "UgurLabs",
    cost: "$0.00",
  },
];

export default function Activity() {
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="A local, append-only history of every agent run on this device."
      />
      <PageBody>
        <Card>
          <div className="divide-y divide-[var(--color-border-soft)]">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              <span>Agent</span>
              <span>Tenant</span>
              <span>When</span>
              <span>Duration</span>
              <span>Cost</span>
              <span>Status</span>
            </div>
            {runs.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-[13px] hover:bg-[var(--color-surface-hover)]"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-[var(--color-text)]">
                    {r.agent}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                    {r.result}
                  </div>
                </div>
                <span className="text-[var(--color-text-soft)]">{r.tenant}</span>
                <span className="text-[var(--color-text-soft)]">{r.when}</span>
                <span className="font-mono text-[12px] text-[var(--color-text-soft)] tabular-nums">
                  {r.duration}
                </span>
                <span className="font-mono text-[12px] text-[var(--color-success)] tabular-nums">
                  {r.cost}
                </span>
                {r.status === "ok" ? (
                  <Pill tone="success">Done</Pill>
                ) : (
                  <Pill>Cancelled</Pill>
                )}
              </div>
            ))}
          </div>
        </Card>
      </PageBody>
    </>
  );
}
