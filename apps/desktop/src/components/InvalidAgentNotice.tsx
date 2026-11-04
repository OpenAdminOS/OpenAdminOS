import { AGENT_COPY } from "../copy";
import type { InvalidAgentManifest } from "../shared/openAdminOS";
import { Button } from "./ui";

/**
 * The designed state for an agent whose manifest failed validation: what
 * failed, the validation reason and file, and the recovery actions the app
 * supports for that agent. Never blocks the rest of the page.
 */
export function InvalidAgentNotice({
  name,
  reason,
  manifestPath,
  source,
  onEdit,
  onUninstall,
}: {
  name: string;
  reason: string;
  manifestPath?: string;
  source?: InvalidAgentManifest["source"];
  onEdit?: () => void;
  onUninstall?: () => void;
}) {
  return (
    <div
      role="alert"
      aria-label={`${name} ${AGENT_COPY.invalidTitle.toLowerCase()}`}
      className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 ring-1 ring-[var(--color-danger)]/30"
    >
      <div className="text-sm font-medium text-[var(--color-danger)]">{AGENT_COPY.invalidTitle}</div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--color-text)]">
        {AGENT_COPY.invalidBody(name)}
        {source === "bundled" ? ` ${AGENT_COPY.invalidBundledHint}` : null}
        {source === "update" ? ` ${AGENT_COPY.invalidUpdateHint}` : null}
      </p>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg-raised)] px-2.5 py-1.5 font-mono text-xs text-[var(--color-text)] ring-1 ring-[var(--color-border)]">
        {reason}
      </pre>
      {manifestPath ? (
        <div className="mt-1.5 break-all font-mono text-xs text-[var(--color-text-muted)]">{manifestPath}</div>
      ) : null}
      {onEdit || onUninstall ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {onEdit ? (
            <Button size="sm" variant="primary" onClick={onEdit}>
              {AGENT_COPY.invalidEditAction}
            </Button>
          ) : null}
          {onUninstall ? (
            <Button size="sm" variant="ghost" onClick={onUninstall}>
              {AGENT_COPY.invalidUninstallAction}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
