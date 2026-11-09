import { useNavigate } from "react-router";

import { POLICY_COPY } from "../copy";
import {
  MANAGED_POLICY_SETTING_KEYS,
  providerCatalog,
  type ManagedPolicyIssue,
  type ManagedPolicySettingKey,
  type ManagedPolicyStatus,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { Button } from "./Button";
import { IconLock, IconWarning } from "./icons";

/** Marks a setting the IT policy file controls. */
export function SetByItBadge({ className = "" }: { className?: string }) {
  return (
    <span
      data-testid="set-by-it"
      className={`inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-[var(--color-hover)] px-2 text-xs font-medium text-[var(--color-text-soft)] ${className}`}
    >
      <IconLock size={11} aria-hidden="true" />
      {POLICY_COPY.setBy}
    </span>
  );
}

function IssueList({ issues }: { issues: readonly ManagedPolicyIssue[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {issues.map((issue, index) => (
        <li key={`${issue.path}:${issue.line ?? 0}:${index}`} className="text-sm leading-5">
          <span className="block break-all font-mono text-xs text-[var(--color-text-muted)]">
            {POLICY_COPY.problemPlace(issue.path, issue.line)}
          </span>
          <span className="text-[var(--color-text)]">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown once per set of problems, across the app, until dismissed. The
 * same problems stay listed in Settings for as long as the file has them.
 */
export function ManagedPolicyNotice() {
  const { state, dismissManagedPolicyNotice } = useAppState();
  const navigate = useNavigate();
  const policy = state.managedPolicy;
  if (!policy || policy.issues.length === 0 || policy.noticeDismissed) return null;
  return (
    <div
      role="alert"
      aria-label={POLICY_COPY.noticeTitle(policy.issues.length)}
      className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-[var(--color-border-soft)] bg-[var(--color-danger-soft)] px-4 py-2 text-sm text-[var(--color-text)]"
    >
      <div className="flex min-w-0 flex-1 gap-2">
        <IconWarning size={14} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0">
          <div className="font-medium">{POLICY_COPY.noticeTitle(policy.issues.length)}</div>
          <div className="text-[var(--color-text-soft)]">{POLICY_COPY.noticeBody}</div>
          <IssueList issues={policy.issues.slice(0, 3)} />
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="secondary" onClick={() => navigate("/settings/providers#it-policy")}>
          {POLICY_COPY.noticeView}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void dismissManagedPolicyNotice()}>
          {POLICY_COPY.noticeDismiss}
        </Button>
      </div>
    </div>
  );
}

function providerName(id: string): string {
  return providerCatalog.find((provider) => provider.id === id)?.name ?? id;
}

function valueText(policy: ManagedPolicyStatus, key: ManagedPolicySettingKey, referenceName: (id: string) => string): string {
  const { values } = policy;
  switch (key) {
    case "allowedProviders":
      return values.allowedProviders?.length ? values.allowedProviders.map(providerName).join(", ") : POLICY_COPY.none;
    case "defaultProvider":
      return providerName(values.defaultProvider ?? "");
    case "defaultModel":
      return values.defaultModel ?? "";
    case "allowedPublicReferences":
      return values.allowedPublicReferences?.length ? values.allowedPublicReferences.map(referenceName).join(", ") : POLICY_COPY.none;
    case "appRegistration": {
      const registration = values.appRegistration;
      if (!registration) return "";
      return [registration.label, registration.clientId, registration.tenantId].filter(Boolean).join(" · ");
    }
    case "skipFirstRunScan":
      return values.skipFirstRunScan ? POLICY_COPY.yes : POLICY_COPY.no;
  }
}

/** What the IT policy file sets, where it was read from, and every problem with its line. */
export function ManagedPolicyPanel({ policy }: { policy: ManagedPolicyStatus }) {
  const { state } = useAppState();
  const referenceName = (id: string) => state.mcpServers?.find((server) => server.id === id)?.name ?? id;
  const keys = MANAGED_POLICY_SETTING_KEYS.filter((key) => policy.values[key] !== undefined);
  return (
    <section
      id="it-policy"
      aria-labelledby="it-policy-heading"
      className="rounded-[10px] bg-[var(--color-surface)] px-5 py-4 ring-1 ring-[var(--color-border)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="it-policy-heading" className="text-base font-medium text-[var(--color-text)]">
          {POLICY_COPY.panelTitle}
        </h2>
        <SetByItBadge />
      </div>
      <p className="mt-1 text-sm leading-5 text-[var(--color-text-soft)]">{POLICY_COPY.panelBody}</p>

      {policy.issues.length > 0 ? (
        <div role="alert" className="mt-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 ring-1 ring-[var(--color-danger)]/30">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
            <IconWarning size={14} />
            {POLICY_COPY.problemsHeading(policy.issues.length)}
          </div>
          <p className="mt-1 text-sm text-[var(--color-text-soft)]">{POLICY_COPY.problemsBody}</p>
          <IssueList issues={policy.issues} />
        </div>
      ) : null}

      <h3 className="mt-4 text-xs font-medium text-[var(--color-text-muted)]">{POLICY_COPY.settingsHeading}</h3>
      {keys.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{POLICY_COPY.noSettings}</p>
      ) : (
        <dl className="mt-1 divide-y divide-[var(--color-border-soft)]">
          {keys.map((key) => (
            <div key={key} className="grid grid-cols-[minmax(140px,180px)_minmax(0,1fr)] gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-soft)]">{POLICY_COPY.keyLabel(key)}</dt>
              <dd className="min-w-0">
                <span className="break-words text-[var(--color-text)]">{valueText(policy, key, referenceName)}</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  {policy.locked.includes(key) ? POLICY_COPY.locked : POLICY_COPY.unlocked}
                  {policy.sources[key] ? ` · ${POLICY_COPY.scope(policy.sources[key]!)}` : ""}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <h3 className="mt-4 text-xs font-medium text-[var(--color-text-muted)]">{POLICY_COPY.filesHeading}</h3>
      <ul className="mt-1 space-y-1">
        {policy.files.map((file) => (
          <li key={file.path} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-[var(--color-text-soft)]">{POLICY_COPY.scope(file.scope)}</span>
            <span className="min-w-0 break-all font-mono text-xs text-[var(--color-text)]">{file.path}</span>
            <span className="text-xs text-[var(--color-text-muted)]">{file.found ? POLICY_COPY.fileFound : POLICY_COPY.fileMissing}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
