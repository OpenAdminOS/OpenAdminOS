import type { AgentNeeds } from "../shared/agent-needs";
import { serviceById } from "../shared/openAdminOS";
import { ServiceMark } from "./ServiceMark";

/** The services an agent reads, marked connected or missing for the active organization. */
export function AgentNeedChips({ needs }: { needs: AgentNeeds }) {
  return (
    <span
      className="mt-1.5 flex flex-wrap gap-1.5"
      aria-label={
        needs.serviceFree
          ? "No service needed"
          : `Needs ${needs.chips.map((chip) => `${chip.label}${chip.state === "missing" ? ", not connected" : ""}`).join("; ")}`
      }
    >
      {needs.chips.map((chip) => (
        <span key={chip.key} className="need-chip" data-state={chip.state} aria-hidden="true">
          {chip.serviceId && chip.label === serviceById(chip.serviceId).title ? (
            <ServiceMark serviceId={chip.serviceId} size="sm" />
          ) : null}
          {chip.label}
        </span>
      ))}
    </span>
  );
}
