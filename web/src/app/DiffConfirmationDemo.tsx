"use client";

import { useEffect, useRef, useState } from "react";

import { LockIcon } from "./home/icons";

const PHRASE = "RETIRE 2 DEVICES";

const CHANGES = [
  { id: "01", device: "WIN-OLD-001", synced: "Last synced 96 days ago." },
  { id: "02", device: "WIN-OLD-002", synced: "Last synced 104 days ago." },
];

/**
 * A replay of the desktop write confirmation (see
 * docs/screenshots/app/brand-light-write-confirmation.png): the plan, the
 * Graph calls it will make, and the typed phrase that unlocks Apply.
 */
export function DiffConfirmationDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isArmed, setIsArmed] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [isApproved, setIsApproved] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    setIsArmed(true);
    let timeout: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setHasPlayed(true);
        timeout = window.setTimeout(() => setIsApproved(true), 4300);
        observer.disconnect();
      },
      { threshold: 0.55 },
    );

    observer.observe(root);

    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`relative overflow-hidden rounded-[18px] bg-brand-raised text-left shadow-(--shadow-frame) ${
        isArmed ? "diff-demo-armed" : ""
      } ${hasPlayed ? "diff-demo-active" : ""} ${
        isApproved ? "diff-demo-approved" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-brand-line-soft px-5 pb-4 pt-5">
        <div>
          <p className="text-xs text-brand-faint">Runs</p>
          <h3 className="font-display mt-1 text-[1.6rem] leading-tight">
            Offboarding agent
          </h3>
        </div>
        <span
          className={`diff-badge mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            isApproved
              ? "bg-brand-ok-surface text-brand-ok"
              : "bg-brand-warn-surface text-brand-warn"
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {isApproved ? "Approved" : "Awaiting confirmation"}
        </span>
      </div>

      <div className="space-y-4 p-5">
        <div className="rounded-[12px] border border-brand-danger-line bg-brand-danger-surface px-4 py-3 text-[13px] leading-5 text-brand-danger">
          <p className="font-medium">Microsoft Graph write</p>
          <p className="mt-1">
            Approving will call Microsoft Graph. 2 planned changes will be
            applied to Contoso Demo. Graph changes may not be reversible.
          </p>
        </div>

        <div className="divide-y divide-brand-line-soft overflow-hidden rounded-[12px] border border-brand-line bg-brand-card">
          {CHANGES.map((change) => (
            <div
              key={change.id}
              className="diff-row grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-2 px-4 py-3"
            >
              <span className="pt-0.5 text-xs text-brand-faint">
                {change.id}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">Retire {change.device}</p>
                <p className="text-xs text-brand-muted">{change.synced}</p>
                <p className="mt-1 truncate font-mono text-xs text-brand-danger">
                  Current tenant state → Retire {change.device}
                </p>
              </div>
              <span className="rounded-md bg-brand-danger-surface px-1.5 py-0.5 font-mono text-[11px] font-medium text-brand-danger">
                POST
              </span>
            </div>
          ))}
        </div>

        <div>
          <p className="text-sm font-medium">Type the phrase below to confirm</p>
          <p className="mt-0.5 text-xs text-brand-muted">
            Every destructive operation requires a typed phrase. There is no
            &ldquo;remember my choice.&rdquo;
          </p>
          <div
            aria-hidden
            className="diff-confirm-control relative mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2"
          >
            <div className="flex min-h-10 items-center overflow-hidden rounded-[10px] border border-brand-line bg-brand-bg px-3 font-mono text-[13px] text-brand-ink">
              <span className="diff-confirm-input inline-block overflow-hidden whitespace-nowrap">
                {PHRASE}
              </span>
              {!isApproved && (
                <span className="diff-confirm-caret ml-0.5 inline-block h-4 w-px bg-brand-ink" />
              )}
            </div>
            <div
              className={`diff-confirm-button inline-flex min-h-10 items-center justify-center rounded-[10px] px-3.5 text-[13px] font-medium ${
                isApproved || !isArmed
                  ? "bg-brand-danger text-brand-on-danger"
                  : "bg-brand-danger/45 text-brand-on-danger"
              }`}
            >
              <span className="diff-click-ripple" />
              Apply 2 changes
            </div>
            <div className="diff-demo-cursor">
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5 fill-brand-ink text-brand-bg"
              >
                <path
                  stroke="currentColor"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M4.5 3.75 18.8 13.1l-6.35 1.03 3.44 5.96-2.88 1.66-3.41-5.9-4.18 4.94L4.5 3.75Z"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <p className="flex items-center gap-1.5 border-t border-brand-line-soft px-5 py-3 text-xs text-brand-muted">
        <LockIcon />
        Tenant data stays on this device. Prompts use Ollama locally.
      </p>
    </div>
  );
}
