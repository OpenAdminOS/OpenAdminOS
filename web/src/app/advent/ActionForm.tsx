"use client";

import { useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";

import { primary, secondary } from "./shared";

const subscribe = () => () => {};

export function ActionForm({
  action, children, label, disabled, quiet, refreshOnSuccess = false,
}: {
  action: string;
  children?: ReactNode;
  label: string;
  disabled?: boolean;
  quiet?: boolean;
  refreshOnSuccess?: boolean;
}) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || disabled) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch(`/api/advent/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = await response.json() as { error?: string; message?: string; redirect?: string };
      if (!response.ok) {
        setError(body.error ?? "This form is unavailable. Reload the page and try again.");
        return;
      }
      if (body.redirect) {
        const destination = new URL(body.redirect, window.location.origin);
        if (destination.origin !== window.location.origin || !["https:", "http:"].includes(destination.protocol)) {
          setError("The campaign returned an invalid destination. Reload the page and try again.");
          return;
        }
        if (destination.pathname === window.location.pathname) {
          // A fragment-only navigation would keep the old server-rendered state.
          window.history.replaceState(null, "", body.redirect);
          window.location.reload();
        } else {
          window.location.assign(body.redirect);
        }
        return;
      }
      setNotice(body.message ?? "");
      if (refreshOnSuccess) router.refresh();
    } catch {
      setError("The campaign could not be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action={`/api/advent/${action}`} onSubmit={submit} className="space-y-4" aria-busy={busy}>
      <fieldset className="min-w-0 space-y-4" disabled={!ready || busy || disabled}>
        {children}
        <button type="submit" className={quiet ? secondary : primary}>
          {busy ? "Submitting…" : label}
        </button>
      </fieldset>
      {error && <p role="alert" className="rounded-[10px] bg-brand-danger-surface px-3 py-2 text-sm leading-6 text-brand-danger">{error}</p>}
      {notice && <p role="status" className="rounded-[10px] bg-brand-ok-surface px-3 py-2 text-sm leading-6 text-brand-ink">{notice}</p>}
    </form>
  );
}
