import { Modal, ModalHeader } from "../components/Modal";
import { Pill, StatusDot } from "../components/Pill";
import { Button } from "../components/Button";
import { IconCheck, IconHardDrive, IconSparkle } from "../components/icons";
import {
  sampleActivity,
  sampleReasoning,
  sampleRunSteps,
} from "../data/runs";
import type { Agent, RunStep } from "../types";

export function LiveRunModal({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
  return (
    <Modal open={agent !== null} onClose={onClose} size="lg">
      {agent && <LiveRunContent agent={agent} onClose={onClose} />}
    </Modal>
  );
}

function LiveRunContent({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  return (
    <>
      <ModalHeader
        title={agent.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="warning" /> Running · llama3.1:8b · local
          </span>
        }
        onClose={onClose}
        badge={<Pill tone="warning">Running</Pill>}
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Telemetry */}
        <div className="mb-5 grid grid-cols-4 gap-3">
          <Stat label="Elapsed" value="00:08" mono />
          <Stat label="Tokens" value="3,142" mono />
          <Stat label="Cost" value="$0.00 local" tone="success" />
          <Stat label="Steps" value="3 / 5" mono />
        </div>

        {/* Reasoning block */}
        <div className="mb-5 rounded-xl bg-[var(--color-think-soft)] p-4 ring-1 ring-[var(--color-think)]/25">
          <div className="mb-2 flex items-center gap-2">
            <IconSparkle size={12} className="text-[var(--color-think)]" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-think)]">
              Reasoning
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--color-think)]" />
              streaming
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--color-text-soft)] animate-fade-in">
            {sampleReasoning}
            <span className="ml-1 inline-block h-3.5 w-1.5 -translate-y-px animate-pulse-soft bg-[var(--color-think)]" />
          </p>
        </div>

        {/* Pipeline */}
        <div className="mb-5">
          <SectionLabel>Pipeline</SectionLabel>
          <div className="mt-3 flex flex-col gap-1.5">
            {sampleRunSteps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        </div>

        {/* Activity */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>Activity</SectionLabel>
            <div className="flex items-center gap-1 rounded-md bg-[var(--color-bg-raised)] p-0.5 ring-1 ring-[var(--color-border-soft)]">
              <button className="rounded px-2 py-0.5 text-[11px] font-medium bg-[var(--color-surface)] text-[var(--color-text)]">
                Plain
              </button>
              <button className="rounded px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-soft)]">
                Raw logs
              </button>
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            {sampleActivity.map((entry, i) => (
              <div
                key={i}
                className={`flex items-baseline gap-3 py-1 text-[12.5px] ${
                  entry.tone === "soft"
                    ? "text-[var(--color-text-muted)]"
                    : entry.tone === "accent"
                      ? "text-[var(--color-accent)]"
                      : "text-[var(--color-text-soft)]"
                }`}
              >
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-faint)]">
                  +{entry.time}
                </span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-soft)] px-6 py-4">
        <div className="inline-flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          <IconHardDrive size={12} className="text-[var(--color-success)]" />
          Local-only · No data leaves this device
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Run in background
          </Button>
          <Button variant="danger">Stop</Button>
        </div>
      </div>
    </>
  );
}

function StepRow({ step }: { step: RunStep }) {
  const stateStyles: Record<RunStep["state"], { dot: string; text: string }> = {
    done: {
      dot: "bg-[var(--color-success)]",
      text: "text-[var(--color-text)]",
    },
    active: {
      dot: "bg-[var(--color-warning)] ring-4 ring-[var(--color-warning)]/20 animate-pulse-soft",
      text: "text-[var(--color-text)]",
    },
    pending: {
      dot: "bg-[var(--color-text-faint)]",
      text: "text-[var(--color-text-muted)]",
    },
    error: {
      dot: "bg-[var(--color-danger)]",
      text: "text-[var(--color-danger)]",
    },
  };
  const s = stateStyles[step.state];

  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      <span className={`text-[13px] font-medium ${s.text}`}>{step.label}</span>
      {step.detail && (
        <span className="ml-auto truncate text-[11px] text-[var(--color-text-muted)]">
          {step.detail}
        </span>
      )}
      {step.state === "done" && (
        <IconCheck size={12} className="text-[var(--color-success)]" />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "success";
}) {
  const valueClass =
    tone === "success" ? "text-[var(--color-success)]" : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-[14px] font-semibold tabular-nums ${valueClass} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
