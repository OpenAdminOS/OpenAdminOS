import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconLock,
  IconShield,
  IconWarning,
} from "../components/icons";
import { retireDevicesDiff } from "../data/results";

const CONFIRM_PHRASE = "RETIRE 31 DEVICES";

export default function DiffConfirm() {
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const armed = typed === CONFIRM_PHRASE;
  const operations = useMemo(
    () => Array.from({ length: 31 }, (_, i) =>
      retireDevicesDiff[i % retireDevicesDiff.length]
    ).slice(0, 31),
    [],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top warning bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-10 py-3">
        <IconWarning size={14} className="text-[var(--color-warning)]" />
        <span className="text-[12.5px] font-medium text-[var(--color-warning)]">
          Write operation paused for confirmation. Open Agents will not proceed
          until the exact phrase is typed.
        </span>
        <button
          onClick={() => navigate(-1)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--color-text-soft)] hover:bg-[var(--color-warning)]/10 hover:text-[var(--color-text)]"
        >
          <IconArrowLeft size={12} /> Cancel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-8 animate-fade-in">
        <div className="mx-auto max-w-[1100px]">
          {/* Header */}
          <div className="mb-7 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center gap-2">
                <Pill tone="warning">
                  <IconBolt size={10} /> Write
                </Pill>
                <Pill>
                  <IconShield size={10} /> Pre-flight diff
                </Pill>
              </div>
              <h1 className="text-[24px] font-semibold tracking-tight text-[var(--color-text)]">
                Retire 31 inactive devices?
              </h1>
              <div className="mt-1 text-[13px] text-[var(--color-text-soft)]">
                Companion run from{" "}
                <span className="font-mono text-[var(--color-text)]">
                  Find inactive devices
                </span>{" "}
                · Tenant{" "}
                <span className="font-medium text-[var(--color-text)]">UgurLabs</span>{" "}
                · Triggered by Ugur Koc
              </div>
            </div>
          </div>

          {/* Stats strip */}
          <div className="mb-6 grid grid-cols-4 gap-3">
            <Stat label="Devices retired" value="31" tone="warning" mono />
            <Stat label="Devices skipped" value="16" mono caption="manual review" />
            <Stat label="Affected users" value="29" mono />
            <Stat label="Reversible?" value="No" tone="danger" caption="enrollment must be redone" />
          </div>

          {/* Diff list */}
          <Card className="mb-6">
            <div className="border-b border-[var(--color-border-soft)] px-5 py-3 flex items-center justify-between">
              <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Operations · before → after
              </div>
              <div className="flex items-center gap-1.5">
                <Pill tone="default">31 retire</Pill>
                <Pill tone="info">0 modify</Pill>
                <Pill tone="default">0 delete</Pill>
              </div>
            </div>

            <div className="divide-y divide-[var(--color-border-soft)]">
              {operations.slice(0, 6).map((op, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[40px_1fr_1.4fr_auto] items-center gap-4 px-5 py-3"
                >
                  <div className="font-mono text-[10.5px] text-[var(--color-text-muted)] tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <div className="font-mono text-[12.5px] text-[var(--color-text)]">
                      {op.target}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {op.detail}
                    </div>
                  </div>
                  <div className="grid grid-cols-[1fr_18px_1fr] items-center gap-2">
                    <div className="rounded-md bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-text-soft)] line-through decoration-[var(--color-text-faint)]">
                      {op.before}
                    </div>
                    <IconArrowRight
                      size={12}
                      className="justify-self-center text-[var(--color-text-muted)]"
                    />
                    <div className="rounded-md bg-[var(--color-warning-soft)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                      {op.after}
                    </div>
                  </div>
                  <Pill tone="warning">
                    <IconBolt size={9} /> retire
                  </Pill>
                </div>
              ))}
              <div className="px-5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">
                + 25 more retire operations · scroll to review all
              </div>
            </div>
          </Card>

          {/* Scopes */}
          <Card className="mb-6">
            <div className="p-5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Graph scopes used
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
                <IconLock size={12} className="text-[var(--color-warning)]" />
                <span className="font-mono text-[12px] text-[var(--color-text)]">
                  DeviceManagementManagedDevices.PrivilegedOperations.All
                </span>
                <Pill tone="warning" className="ml-auto">
                  Privileged
                </Pill>
              </div>
            </div>
          </Card>

          {/* Confirm */}
          <Card className={armed ? "ring-[var(--color-warning)]/35" : ""}>
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)]">
                  <IconWarning size={18} className="text-[var(--color-warning)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium text-[var(--color-text)]">
                    Type the phrase below to confirm
                  </div>
                  <div className="mt-1 text-[12.5px] text-[var(--color-text-soft)]">
                    There is no "remember my choice." Every destructive operation
                    requires a typed phrase. Always.
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[280px_1fr_auto]">
                    <div className="flex h-11 items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-4 ring-1 ring-[var(--color-border)]">
                      <span className="font-mono text-[13px] tracking-wide text-[var(--color-warning)]">
                        {CONFIRM_PHRASE}
                      </span>
                    </div>
                    <input
                      autoFocus
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder="Type here to enable Retire"
                      className={`h-11 rounded-lg bg-[var(--color-bg)] px-4 font-mono text-[13px] text-[var(--color-text)] ring-1 placeholder:text-[var(--color-text-muted)] focus:outline-none ${
                        armed
                          ? "ring-[var(--color-warning)]/55 focus:ring-[var(--color-warning)]"
                          : "ring-[var(--color-border)] focus:ring-[var(--color-accent)]/50"
                      }`}
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" size="md" onClick={() => navigate(-1)}>
                        Cancel
                      </Button>
                      <Button
                        size="md"
                        disabled={!armed}
                        className={
                          armed
                            ? "!bg-[var(--color-warning)] !text-[#1a120c] hover:!bg-[var(--color-warning)]/90"
                            : ""
                        }
                        leadingIcon={<IconBolt size={11} />}
                      >
                        Retire 31 devices
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: string;
  caption?: string;
  mono?: boolean;
  tone?: "default" | "warning" | "danger";
}) {
  const colorClass =
    tone === "warning"
      ? "text-[var(--color-warning)]"
      : tone === "danger"
        ? "text-[var(--color-danger)]"
        : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-4 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-[22px] font-semibold tabular-nums leading-tight ${colorClass} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
      {caption && (
        <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
          {caption}
        </div>
      )}
    </div>
  );
}
