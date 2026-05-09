import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconCopy,
  IconDownload,
  IconHardDrive,
  IconPlay,
  IconShare,
  IconWarning,
} from "../components/icons";
import { inactiveDevicesResult, sampleRunSummary } from "../data/results";

export default function RunResult() {
  const navigate = useNavigate();
  const summary = sampleRunSummary;
  const rows = inactiveDevicesResult;

  return (
    <>
      <PageHeader
        eyebrow={
          <button
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <IconArrowLeft size={12} /> Run history
          </button>
        }
        title={summary.agentName}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Pill tone="success">
              <IconCheck size={10} /> Completed
            </Pill>
            <span>{summary.finishedAt}</span>
            <span className="opacity-50">·</span>
            <span>{summary.tenant}</span>
            <span className="opacity-50">·</span>
            <span>by {summary.startedBy}</span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" size="md" leadingIcon={<IconCopy size={12} />}>
              Copy report
            </Button>
            <Button variant="secondary" size="md" leadingIcon={<IconDownload size={12} />}>
              Export
            </Button>
            <Button variant="secondary" size="md" leadingIcon={<IconShare size={12} />}>
              Share
            </Button>
            <Button
              variant="primary"
              size="md"
              leadingIcon={<IconPlay size={12} />}
              onClick={() => navigate(`/agents/${summary.agentSlug}`)}
            >
              Run again
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Top: Headline + stats */}
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card>
            <div className="flex items-stretch gap-6 p-6">
              <div className="flex flex-col justify-center">
                <div className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Devices flagged
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="text-[44px] font-semibold leading-none tracking-tight text-[var(--color-text)]">
                    {summary.flagged}
                  </span>
                  <span className="text-[14px] text-[var(--color-text-muted)]">
                    of {summary.totalScanned.toLocaleString()} scanned
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Pill tone="warning">
                    <IconBolt size={10} /> {summary.recommendRetire} recommend retire
                  </Pill>
                  <Pill tone="info">
                    <IconWarning size={10} /> {summary.recommendReview} need review
                  </Pill>
                </div>
              </div>
              <div className="ml-auto flex flex-col items-end justify-center gap-2 border-l border-[var(--color-border-soft)] pl-6">
                <SmallStat label="Duration" value={`${summary.durationSeconds}s`} mono />
                <SmallStat label="Tokens" value={summary.tokenCount.toLocaleString()} mono />
                <SmallStat
                  label="Cost"
                  value={summary.cost}
                  valueClass="text-[var(--color-success)]"
                  caption={summary.costLabel}
                />
              </div>
            </div>
          </Card>

          <Card>
            <div className="p-6">
              <SectionLabel>Local-first guarantee</SectionLabel>
              <div className="mt-3 flex items-center gap-2">
                <IconHardDrive size={16} className="text-[var(--color-success)]" />
                <span className="text-[14px] font-medium text-[var(--color-text)]">
                  No data left this device
                </span>
              </div>
              <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                Tenant payload, prompt, and reasoning all stayed on{" "}
                <span className="font-mono text-[var(--color-text)]">
                  {summary.modelUsed}
                </span>{" "}
                running locally on this machine.
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <span className="font-mono">model</span>
                <span className="opacity-50">·</span>
                <span>{summary.modelUsed}</span>
                <span className="opacity-50">·</span>
                <Pill tone="success">Local</Pill>
              </div>
            </div>
          </Card>
        </div>

        {/* Summary card */}
        <Card className="mb-6">
          <div className="p-6">
            <SectionLabel>Summary</SectionLabel>
            <p className="mt-3 max-w-[820px] text-[14px] leading-relaxed text-[var(--color-text-soft)]">
              Looking at the {summary.flagged} candidates, they group into two clusters:{" "}
              <span className="font-medium text-[var(--color-text)]">
                {summary.recommendRetire} Windows devices
              </span>{" "}
              last seen 90–180 days ago — likely off-boarded users or stored devices,
              safe to retire. The remaining{" "}
              <span className="font-medium text-[var(--color-text)]">
                {summary.recommendReview} macOS devices
              </span>{" "}
              have a sync gap of 180+ days, which is unusual for active users — worth
              confirming with the device owner before retiring.
            </p>
            <div className="mt-4 flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
              <Pill>Generated by</Pill>
              <span className="font-mono">{summary.modelUsed}</span>
              <span className="opacity-50">·</span>
              <span>{summary.tokenCount.toLocaleString()} tokens · {summary.durationSeconds}s</span>
            </div>
          </div>
        </Card>

        {/* Table */}
        <Card>
          <div className="border-b border-[var(--color-border-soft)] px-6 pt-5 pb-3 flex items-center justify-between">
            <div>
              <SectionLabel>Flagged devices</SectionLabel>
              <div className="mt-1 text-[14px] text-[var(--color-text)]">
                {rows.length} devices · sortable, filterable
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Pill>Sorted by inactivity</Pill>
              <Button variant="secondary" size="sm">
                Open in detail
              </Button>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<IconBolt size={11} />}
              >
                Retire all 31
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th className="px-6 py-3 text-left">Device</th>
                  <th className="px-3 py-3 text-left">OS</th>
                  <th className="px-3 py-3 text-left">User</th>
                  <th className="px-3 py-3 text-left">Last sync</th>
                  <th className="px-3 py-3 text-right">Days inactive</th>
                  <th className="px-6 py-3 text-right">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
                  >
                    <td className="px-6 py-3">
                      <div className="font-mono text-[13px] text-[var(--color-text)]">
                        {r.name}
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">
                        {r.id}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[var(--color-text-soft)]">{r.os}</td>
                    <td className="px-3 py-3 font-mono text-[11.5px] text-[var(--color-text-soft)]">
                      {r.user}
                    </td>
                    <td className="px-3 py-3 font-mono text-[11.5px] text-[var(--color-text-soft)]">
                      {r.lastSync}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-[var(--color-text)]">
                      {r.daysInactive}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {r.recommendation === "retire" ? (
                        <Pill tone="warning">
                          <IconBolt size={9} /> Retire
                        </Pill>
                      ) : r.recommendation === "review" ? (
                        <Pill tone="info">
                          <IconWarning size={9} /> Review
                        </Pill>
                      ) : (
                        <Pill tone="success">Keep</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function SmallStat({
  label,
  value,
  caption,
  mono = false,
  valueClass = "text-[var(--color-text)]",
}: {
  label: string;
  value: string;
  caption?: string;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <span
        className={`mt-0.5 text-[16px] font-semibold tabular-nums ${valueClass} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
      {caption && (
        <span className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
          {caption}
        </span>
      )}
    </div>
  );
}
