"use client";

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";

import { primary, secondary } from "./shared";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
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
      {children}
      <button type="submit" className={quiet ? secondary : primary} disabled={busy || disabled}>
        {busy ? "Submitting…" : label}
      </button>
      {error && <p role="alert" className="rounded-[10px] bg-brand-danger-surface px-3 py-2 text-sm leading-6 text-brand-danger">{error}</p>}
      {notice && <p role="status" className="rounded-[10px] bg-brand-ok-surface px-3 py-2 text-sm leading-6 text-brand-ink">{notice}</p>}
    </form>
  );
}

export function VerifyLink() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    setToken((current) => current ?? fragment);
    if (fragment) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  if (token === null) return <p role="status" className="text-sm text-brand-muted">Reading the sign-in link…</p>;
  if (!token) return <p role="alert" className="text-sm text-brand-danger">This link is incomplete. Open the original email or request a new link.</p>;
  return (
    <ActionForm action="verify" label="Continue to My Advent">
      <input type="hidden" name="token" value={token} />
    </ActionForm>
  );
}
