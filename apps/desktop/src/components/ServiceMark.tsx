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

/** Tile for a public reference or result connector, from its name. */
export function ReferenceMark({ name, size = "md", off = false }: { name: string; size?: "sm" | "md" | "lg"; off?: boolean }) {
  const words = name.replace(/^www\./, "").split(/[\s.]+/).filter(Boolean);
  const text = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
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
