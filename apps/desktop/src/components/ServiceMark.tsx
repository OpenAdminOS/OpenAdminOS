import defenderIcon from "../assets/service-logos/defender-for-cloud.svg";
import entraIcon from "../assets/service-logos/entra-id-color.svg";
import intuneIcon from "../assets/service-logos/intune.svg";
import splashtopIcon from "../assets/service-logos/splashtop-logo-120.png";
import {
  AVAILABLE_SERVICES,
  serviceById,
  serviceStatus,
  type ServiceId,
  type TenantRecord,
} from "../shared/openAdminOS";

/**
 * The owner's icon for each service, unmodified (sources in
 * `assets/service-logos/NOTICE.md`). Microsoft's are single colour files
 * for light and dark surfaces alike; Splashtop's sits on a white tile.
 */
const ICONS: Readonly<Partial<Record<string, string>>> = {
  intune: intuneIcon,
  entra: entraIcon,
  defender: defenderIcon,
  splashtop: splashtopIcon,
};

/** Every Microsoft 365 service OpenAdminOS connects has its icon; another service shows its first two letters. */
export function serviceLogoKind(service: string): "logo" | "neutral" {
  return ICONS[service] ? "logo" : "neutral";
}

function titleOf(service: string): string {
  try {
    return serviceById(service as ServiceId).title;
  } catch {
    return service.charAt(0).toUpperCase() + service.slice(1);
  }
}

/** The service's icon alone, for a surface that draws its own tile, such as the onboarding stage. */
export function ServiceLogo({ service, size, label }: { service: string; size: number; label?: string }) {
  const icon = ICONS[service];
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (icon) {
    return (
      <span {...a11y} data-service-logo={service} data-kind="logo" className="inline-flex shrink-0" style={{ width: size, height: size }}>
        <img src={icon} alt="" draggable={false} className="h-full w-full object-contain" />
      </span>
    );
  }
  return (
    <span {...a11y} data-service-logo={service} data-kind="neutral" className="inline-flex shrink-0 items-center justify-center font-medium" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) }}>
      {titleOf(service).slice(0, 2)}
    </span>
  );
}

const INNER: Readonly<Record<"sm" | "md" | "lg", number>> = { sm: 13, md: 16, lg: 20 };

/**
 * A Microsoft 365 service as its icon on a small tile (mockup 32). A
 * service that is not connected is always a dashed tile, wherever it
 * shows; the icon inside stays as Microsoft provides it. Decorative next
 * to a visible name; `label` names it when it stands alone.
 */
export function ServiceMark({
  serviceId,
  size = "md",
  off = false,
  label,
}: {
  serviceId: ServiceId | string;
  size?: "sm" | "md" | "lg";
  off?: boolean;
  label?: string;
}) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <span {...a11y} className="svc-mark" data-service={serviceId} data-size={size} data-off={off ? "true" : undefined}>
      <ServiceLogo service={serviceId} size={INNER[size]} />
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

/**
 * Tile for a Marketplace listing or its host: the owner's logo when the
 * listing has one (both Splashtop Help Centers), else letters from `name`.
 */
export function ListingMark({ logo, name, size = "md", off = false }: { logo?: string; name: string; size?: "sm" | "md" | "lg"; off?: boolean }) {
  return logo ? <ServiceMark serviceId={logo} size={size} off={off} /> : <ReferenceMark name={name} size={size} off={off} />;
}

/** Services with at least one part granted for the tenant, in registry order. */
export function connectedServiceIds(tenant: TenantRecord | undefined): ServiceId[] {
  if (!tenant) return [];
  return AVAILABLE_SERVICES.filter((service) => serviceStatus(tenant, service.id) !== "missing").map(
    (service) => service.id,
  );
}
