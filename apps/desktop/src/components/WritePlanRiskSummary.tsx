import type { WritePlanRiskAssessment } from "../shared/openAdminOS";
import { userFacingErrorReason } from "../copy";
import { IconWarning } from "./icons";
import { Badge } from "./ui";

export function WritePlanRiskSummary({ assessment }: { assessment?: WritePlanRiskAssessment }) {
  if (!assessment || assessment.status === "failed") {
    const reason = assessment?.status === "failed"
      ? userFacingErrorReason(assessment.reason)?.replace(/[.]+$/, "") ?? "The risk rules were unavailable"
      : "This run has no recorded risk check";
    return (
      <div role="alert" className="flex items-start gap-3 break-words border-l-2 border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-text-soft)]">
        <IconWarning size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
        <p className="min-w-0">Risk check could not run: {reason}. Review every action manually.</p>
      </div>
    );
  }
  const danger = assessment.flags.some((flag) => flag.severity === "danger");
  return (
    <section aria-label="Write plan risk flags" className={`border-l-2 px-4 py-3 ${danger ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]" : "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"}`}>
      <h2 className="text-md font-semibold text-[var(--color-text)]">Risk review</h2>
      {assessment.flags.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--color-text-soft)]">No flags from the current rules. Review every action before applying.</p>
      ) : (
        <ul className="mt-2 space-y-3">
          {assessment.flags.map((flag) => (
            <li key={flag.id}>
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                <Badge tone={flag.severity === "danger" ? "danger" : "warning"}>{flag.severity === "danger" ? "Danger" : "Warning"}</Badge>
                {flag.title}
                <span className="font-normal text-[var(--color-text-muted)]">{flag.actionIds.length} {flag.actionIds.length === 1 ? "action" : "actions"}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--color-text-soft)]">{flag.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
