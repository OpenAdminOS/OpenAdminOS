import type { AgentNeedChip, AgentNeeds } from "../shared/agent-needs";
import { serviceById } from "../shared/openAdminOS";
import { ServiceMark } from "./ServiceMark";

/** A chip for a part of a service rather than the whole service. */
function isPartChip(chip: AgentNeedChip): boolean {
  return Boolean(chip.serviceId) && chip.label !== serviceById(chip.serviceId!).title;
}

/** "Defender, not connected", "Sign-in logs, not granted", or the plain name. */
export function needChipLabel(chip: AgentNeedChip): string {
  if (chip.state !== "missing") return chip.label;
  if (!isPartChip(chip)) return `${chip.label}, not connected`;
  const short = chip.label.slice(serviceById(chip.serviceId!).title.length + 1);
  return `${short.charAt(0).toUpperCase()}${short.slice(1)}, not granted`;
}

/** The text a screen reader hears for an agent's service needs. */
export function agentNeedsText(needs: AgentNeeds): string {
  return needs.serviceFree
    ? "No service needed"
    : `Needs ${needs.chips.map((chip) => (isPartChip(chip) && chip.state === "missing" ? `${chip.label}, not granted` : needChipLabel(chip))).join("; ")}`;
}

/**
 * The services an agent reads, marked connected or missing for the active
 * organization. The chips are visual; the same facts are visually hidden
 * text, so a screen reader reads them in place.
 */
export function AgentNeedChips({ needs }: { needs: AgentNeeds }) {
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      <span className="sr-only">{agentNeedsText(needs)}</span>
      {needs.chips.map((chip) => (
        <span key={chip.key} className="need-chip" data-state={chip.state} data-kind={isPartChip(chip) ? "part" : undefined} aria-hidden="true">
          {chip.serviceId && !isPartChip(chip) ? (
            <ServiceMark serviceId={chip.serviceId} size="sm" off={chip.state === "missing"} />
          ) : null}
          {needChipLabel(chip)}
        </span>
      ))}
    </span>
  );
}
