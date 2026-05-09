"use client";

import { useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "loading") return;
    setStatus({ kind: "loading" });

    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setStatus({
          kind: "error",
          message: data.error ?? "Something went wrong. Please try again.",
        });
        return;
      }
      setStatus({ kind: "success" });
    } catch {
      setStatus({
        kind: "error",
        message: "Network error. Please try again.",
      });
    }
  }

  if (status.kind === "success") {
    return (
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
        <p className="text-base font-medium text-white">You're on the list.</p>
        <p className="mt-2 text-sm text-white/60">
          We'll email you the moment your spot in the private preview opens up.
        </p>
      </div>
    );
  }

  const isLoading = status.kind === "loading";

  return (
    <form
      onSubmit={onSubmit}
      className="flex w-full max-w-md flex-col gap-3"
      noValidate
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status.kind === "error") setStatus({ kind: "idle" });
          }}
          disabled={isLoading}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-base text-white placeholder:text-white/30 focus:border-white/30 focus:bg-white/10 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={isLoading || email.length === 0}
          className="rounded-lg bg-white px-5 py-3 text-base font-medium text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? "Joining…" : "Request access"}
        </button>
      </div>
      <p
        className={`text-sm ${
          status.kind === "error" ? "text-red-400" : "text-white/40"
        }`}
        role={status.kind === "error" ? "alert" : undefined}
      >
        {status.kind === "error"
          ? status.message
          : "We only use your email to send your invite. No spam."}
      </p>
    </form>
  );
}
