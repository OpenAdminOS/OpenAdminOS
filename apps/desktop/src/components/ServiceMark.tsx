import {
  AVAILABLE_SERVICES,
  serviceById,
  serviceStatus,
  type ServiceId,
  type TenantRecord,
} from "../shared/openAdminOS";

const SERVICE_MARK_TEXT: Record<string, string> = {
  intune: "In",
  entra: "En",
  defender: "De",
};

/** Two-letter tile for a service. Decorative: callers label the row. */
export function ServiceMark({
  serviceId,
  size = "md",
  off = false,
}: {
  serviceId: ServiceId;
  size?: "sm" | "md" | "lg";
  off?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="svc-mark"
      data-service={serviceId}
      data-size={size}
      data-off={off ? "true" : undefined}
    >
      {SERVICE_MARK_TEXT[serviceId] ?? serviceById(serviceId).title.slice(0, 2)}
    </span>
  );
}

/**
 * Two letters for a reference or connector tile. A host name leads with its
 * brand, the label before the top-level domain, so it never reads like a
 * product name: learn.microsoft.com is ML (not LM, which is LM Studio) and
 * www.kqlsearch.com is KQ. Any other name uses the initials of its first
 * two words.
 */
export function referenceMarkText(name: string): string {
  const trimmed = name.trim();
  if (/^[\w-]+(\.[\w-]+)+$/.test(trimmed)) {
    const labels = trimmed.toLowerCase().split(".").filter((label) => label !== "www");
    const brand = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
    const sub = labels.length >= 3 ? labels[0] : undefined;
    return (sub ? `${brand[0]}${sub[0]}` : brand.slice(0, 2)).toUpperCase();
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** Tile for a public reference or result connector, from its name. */
export function ReferenceMark({ name, size = "md", off = false }: { name: string; size?: "sm" | "md" | "lg"; off?: boolean }) {
  const text = referenceMarkText(name);
  return (
    <span aria-hidden="true" className="svc-mark" data-service="reference" data-size={size} data-off={off ? "true" : undefined}>
      {off ? "" : text.toUpperCase()}
    </span>
  );
}

/** Services with at least one part granted for the tenant, in registry order. */
export function connectedServiceIds(tenant: TenantRecord | undefined): ServiceId[] {
  if (!tenant) return [];
  return AVAILABLE_SERVICES.filter((service) => serviceStatus(tenant, service.id) !== "missing").map(
    (service) => service.id,
  );
}
