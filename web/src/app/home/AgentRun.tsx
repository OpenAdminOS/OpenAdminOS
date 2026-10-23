"use client";

import { useEffect, useRef, useState } from "react";

import { LockIcon } from "./icons";

type Tone = "neutral" | "ok" | "warn";

const STEPS: readonly {
  verb: string;
  title: string;
  detail: string;
  tone: Tone;
  mono?: boolean;
}[] = [
  {
    verb: "Scope",
    title: "Contoso Demo",
    detail: "Active tenant, shown in the title bar",
    tone: "neutral",
  },
  {
    verb: "Read",
    title: "Intune managed devices",
    detail: "DeviceManagementManagedDevices.Read.All",
    tone: "ok",
    mono: true,
  },
  {
    verb: "Read",
    title: "Entra devices",
    detail: "Device.Read.All",
    tone: "ok",
    mono: true,
  },
  {
    verb: "Answer",
    title: "WIN-01 is stale",
    detail: "2 sources · data from just now",
    tone: "neutral",
  },
  {
    verb: "Plan",
    title: "Offboarding agent · Makes changes",
    detail: "Retire two stale Windows devices",
    tone: "warn",
  },
];

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-brand-ink",
  ok: "bg-brand-ok",
  warn: "bg-brand-warn",
};

/**
 * A stylized replay of one Chat question in the desktop app: scope, reads,
 * a cited answer, and a write plan that stops for review. Strings mirror the
 * app's demo tenant; nothing here talks to a tenant.
 */
export function AgentRun() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Steps are only hidden once JavaScript can reveal them again.
    setArmed(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setActive(true);
        observer.disconnect();
      },
      { threshold: 0.35 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className={`overflow-hidden rounded-[18px] bg-brand-raised shadow-(--shadow-frame) ${
        armed ? "run-armed" : ""
      } ${active ? "run-active" : ""}`}
    >
      <div className="flex items-center justify-between gap-4 border-b border-brand-line-soft px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[#2f5b85] text-[10px] font-semibold text-white">
            CD
          </span>
          <span className="truncate text-sm font-medium">Contoso Demo</span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-brand-muted">
          <LockIcon />
          Local · Ollama
        </span>
      </div>

      <div className="px-5 pb-2 pt-5">
        <p className="ml-auto w-fit max-w-[85%] rounded-[14px] bg-brand-bubble px-4 py-2.5 text-[15px] leading-6">
          Which managed devices have not synced in the last 7 days?
        </p>
      </div>

      <ol className="relative px-5 pb-5 pt-3">
        <span
          aria-hidden
          className="absolute bottom-10 left-[1.95rem] top-6 w-px bg-brand-line"
        />
        {STEPS.map((step, index) => (
          <li
            key={`${step.verb}-${step.title}`}
            className="run-step relative grid grid-cols-[1.25rem_4.25rem_minmax(0,1fr)] items-start gap-x-2 py-2"
            style={{ ["--step" as string]: index }}
          >
            <span className="mt-[7px] grid h-2.5 w-2.5 place-items-center justify-self-center rounded-full bg-brand-raised">
              <span className={`h-2 w-2 rounded-full ${TONE_DOT[step.tone]}`} />
            </span>
            <span className="pt-px text-sm text-brand-faint">{step.verb}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-6">
                {step.title}
              </span>
              <span
                className={`block truncate text-xs leading-5 text-brand-muted ${
                  step.mono ? "font-mono" : ""
                }`}
              >
                {step.detail}
              </span>
            </span>
          </li>
        ))}
        <li
          className="run-step relative mt-2 grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2 rounded-[12px] border border-brand-line bg-brand-warn-surface py-3 pr-3"
          style={{ ["--step" as string]: STEPS.length }}
        >
          <span className="mt-[7px] grid h-2.5 w-2.5 place-items-center justify-self-center">
            <span className="run-pulse h-2 w-2 rounded-full bg-brand-warn text-brand-warn" />
          </span>
          <span className="min-w-0 text-sm leading-6">
            <span className="font-medium text-brand-warn">
              Awaiting confirmation.
            </span>{" "}
            <span className="text-brand-muted">
              Nothing changes until you review the diff and type{" "}
              <code className="rounded bg-brand-code px-1 py-0.5 text-[12px] text-brand-ink">
                RETIRE 2 DEVICES
              </code>
              .
            </span>
          </span>
        </li>
      </ol>

      <p className="flex items-center gap-1.5 border-t border-brand-line-soft px-5 py-3 text-xs text-brand-muted">
        <LockIcon />
        Local model. Tenant data stays on this device.
      </p>
    </div>
  );
}
