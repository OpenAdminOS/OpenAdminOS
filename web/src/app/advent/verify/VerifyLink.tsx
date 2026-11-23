"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { MARKETING_CONSENT_LABEL, REMINDERS_CONSENT_LABEL } from "~/lib/advent/config";
import type { LoginPreview } from "~/lib/advent/login";
import { ActionForm } from "../ActionForm";
import { field, textLink } from "../shared";

export function VerifyLink() {
  const token = useRef<string | undefined>(undefined);
  const [preview, setPreview] = useState<LoginPreview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (token.current === undefined) {
      token.current = window.location.hash.slice(1);
      if (token.current) window.history.replaceState(null, "", window.location.pathname);
    }
    if (!token.current) {
      setError("This link is incomplete. Open the original email or request a new link.");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/advent/verify-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token.current }),
          signal: controller.signal,
        });
        const result = await response.json() as { preview?: LoginPreview; error?: string };
        if (controller.signal.aborted) return;
        if (response.ok && result.preview) setPreview(result.preview);
        else setError(result.error ?? "This link could not be checked. Request a new link.");
      } catch {
        if (!controller.signal.aborted) setError("The link could not be checked. Check your connection and reload it from the email.");
      }
    })();
    return () => controller.abort();
  }, []);

  if (error) return <p role="alert" className="text-sm text-brand-danger">{error}</p>;
  if (!preview) return <p role="status" className="text-sm text-brand-muted">Reading your sign-in link…</p>;

  return (
    <ActionForm action="verify" label={preview.kind === "signup" ? "Create my account" : "Continue to My Advent"}>
      <input type="hidden" name="token" value={token.current} />
      <input type="hidden" name="intent" value={preview.kind} />
      {preview.kind === "signup" ? (
        <>
          <p className="break-all text-sm text-brand-muted">Email <strong className="text-brand-ink">{preview.email}</strong></p>
          <label className="block text-sm font-medium">
            Handle
            <input name="handle" className={`${field} mt-2 block`} defaultValue={preview.handle} autoComplete="username" autoCapitalize="none" minLength={3} maxLength={24} required />
          </label>
          {preview.referral && (
            <>
              <p className="text-sm text-brand-muted">Referral <strong className="font-mono text-brand-ink">{preview.referral}</strong></p>
              <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="discard_referral" />Don’t use this referral</label>
            </>
          )}
          <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="age" required />I am 18 or older.</label>
          <div className="flex items-baseline gap-2 text-sm">
            <input type="checkbox" id="confirm-rules" name="rules" required />
            <span><label htmlFor="confirm-rules">I accept the campaign rules.</label>{" "}<Link href="/advent/rules" target="_blank" rel="noreferrer" className={textLink}>Read the rules</Link></span>
          </div>
          <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="marketing" defaultChecked={preview.marketing} />{MARKETING_CONSENT_LABEL}</label>
          <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="reminders" defaultChecked={preview.reminders} />{REMINDERS_CONSENT_LABEL}</label>
        </>
      ) : (
        <p className="break-all text-sm text-brand-muted">Sign in as <strong className="text-brand-ink">{preview.handle}</strong> ({preview.maskedEmail}).</p>
      )}
    </ActionForm>
  );
}
