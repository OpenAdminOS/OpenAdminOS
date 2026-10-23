"use client";

import { useState } from "react";

export function CopyPromptButton({ prompt }: { prompt: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
      window.setTimeout(() => setState("idle"), 2400);
    }
  }

  return (
    <button
      type="button"
      aria-live="polite"
      onClick={copyPrompt}
      className="inline-flex min-h-10 items-center justify-center rounded-[10px] border border-brand-line-strong bg-brand-surface px-3 text-xs font-semibold text-brand-muted transition hover:border-brand-accent hover:bg-brand-raised hover:text-brand-ink"
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : "Copy prompt"}
    </button>
  );
}
