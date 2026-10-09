"use client";

import { useEffect, useRef, useState } from "react";

const DEVICES = ["WIN-FINANCE-042", "MACBOOK-AUDIT-17", "SURFACE-FIELD-31"];

export function DiffConfirmationDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [isApproved, setIsApproved] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || hasPlayed) return;

        setHasPlayed(true);
        window.setTimeout(() => setIsApproved(true), 4300);
        observer.disconnect();
      },
      { threshold: 0.55 },
    );

    observer.observe(root);

    return () => observer.disconnect();
  }, [hasPlayed]);

  return (
    <div
      ref={rootRef}
      className={`relative overflow-hidden rounded-xl border-2 border-brand-ink/40 bg-brand-surface p-4 shadow-[0_16px_40px_-16px_rgba(23,25,29,0.3)] ${
        hasPlayed ? "diff-demo-active" : ""
      } ${isApproved ? "diff-demo-approved" : ""}`}
    >
      <div className="flex items-center justify-between border-b border-brand-ink/25 pb-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wider text-amber-800">
            Diff confirmation
          </p>
          <h3 className="mt-1 text-base font-semibold">
            Retire inactive devices
          </h3>
        </div>
        <span className="diff-badge rounded-md border border-amber-800/40 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
          Destructive
        </span>
      </div>
      <div className="mt-4 space-y-2">
        {DEVICES.map((device) => (
          <div
            key={device}
            className="diff-row grid grid-cols-[1fr_auto] gap-3 rounded-md border border-brand-ink/25 bg-brand-raised px-3 py-2 text-sm"
          >
            <span className="font-mono text-brand-ink">{device}</span>
            <span className="text-rose-800">retire</span>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg border-2 border-amber-800/40 bg-amber-50 p-3">
        <p className="text-sm leading-6 text-brand-muted">
          This will retire 47 devices. Type{" "}
          <code className="font-mono text-amber-800">RETIRE 47 DEVICES</code>{" "}
          to confirm.
        </p>
        <div
          aria-hidden
          className="diff-confirm-control relative mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2"
        >
          <div className="rounded-md border border-amber-800/50 bg-brand-surface px-3 py-2 font-mono text-sm text-amber-800">
            <span className="diff-confirm-input inline-block overflow-hidden whitespace-nowrap align-bottom">
              RETIRE 47 DEVICES
            </span>
            {!isApproved && (
              <span className="diff-confirm-caret ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-amber-800" />
            )}
          </div>
          <div
            className={`diff-confirm-button rounded-md border px-3 py-2 text-sm font-medium ${
              isApproved
                ? "border-emerald-900 bg-emerald-800 text-white"
                : "border-amber-900 bg-amber-800 text-white"
            }`}
          >
            <span className="diff-click-ripple" />
            {isApproved ? "Approved" : "Confirm"}
          </div>
          <div className="diff-demo-cursor">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-brand-ink text-brand-bg">
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
  );
}
