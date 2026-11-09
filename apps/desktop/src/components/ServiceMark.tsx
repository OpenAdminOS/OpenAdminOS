import defenderIcon from "../assets/service-logos/defender-for-cloud.svg";
import entraIcon from "../assets/service-logos/entra-id-color.svg";
import intuneIcon from "../assets/service-logos/intune.svg";

/**
 * Microsoft's product icon for each service, unmodified (sources in
 * `assets/service-logos/NOTICE.md`). Each is a single colour file that
 * Microsoft provides for light and dark surfaces alike.
 */
const ICONS: Readonly<Partial<Record<string, string>>> = {
  intune: intuneIcon,
  entra: entraIcon,
  defender: defenderIcon,
};

/** Every Microsoft 365 service OpenAdminOS connects has its icon; another service shows its first two letters. */
export function serviceLogoKind(service: string): "logo" | "neutral" {
  return ICONS[service] ? "logo" : "neutral";
}

/** The service's icon alone, for a surface that draws its own tile, such as the onboarding stage. */
export function ServiceLogo({ service, title, size, label }: { service: string; title: string; size: number; label?: string }) {
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
      {title.slice(0, 2)}
    </span>
  );
}

const INNER: Readonly<Record<17 | 22 | 30, number>> = { 17: 13, 22: 16, 30: 20 };

/**
 * A Microsoft 365 service as its icon on a small tile (mockup 32). A
 * service that is not connected is always a dashed tile, wherever it
 * shows; the icon inside stays as Microsoft provides it.
 */
export function ServiceMark({
  service,
  title,
  size = 22,
  off = false,
  label,
}: {
  service: string;
  title: string;
  size?: 17 | 22 | 30;
  off?: boolean;
  /** Only when no visible name sits next to the mark. */
  label?: string;
}) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <span
      {...a11y}
      data-off={off ? "true" : undefined}
      data-service={service}
      className="service-mark inline-flex shrink-0 items-center justify-center text-[var(--color-text-muted)]"
      style={{ width: size, height: size, borderRadius: size >= 30 ? 8 : size >= 22 ? 6 : 5 }}
    >
      <ServiceLogo service={service} title={title} size={INNER[size]} />
    </span>
  );
}
