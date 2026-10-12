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
      className="inline-flex min-h-10 items-center justify-center rounded-md border border-brand-ink/10 bg-brand-ink/[0.04] px-3 text-xs font-semibold text-brand-muted transition hover:border-brand-ink/20 hover:bg-brand-ink/[0.07] hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/45"
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : "Copy prompt"}
    </button>
  );
}
