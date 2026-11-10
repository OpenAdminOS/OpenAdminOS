import defenderIcon from "../assets/service-logos/defender-for-cloud.svg";
import discordSymbol from "../assets/service-logos/discord-symbol-blurple.svg";
import endoflifeIcon from "../assets/service-logos/endoflife-ai.svg";
import entraIcon from "../assets/service-logos/entra-id-color.svg";
import intuneIcon from "../assets/service-logos/intune.svg";
import intuneAutomationIcon from "../assets/service-logos/intuneautomation.png";
import kqlSearchIcon from "../assets/service-logos/kqlsearch.png";
import microsoftLogo from "../assets/service-logos/microsoft-logo.png";
import outlookIcon from "../assets/service-logos/microsoft-outlook.png";
import teamsIcon from "../assets/service-logos/microsoft-teams.png";
import signalLogoWhite from "../assets/service-logos/signal-logo-white.svg";
import signalLogo from "../assets/service-logos/signal-logo.svg";
import slackMark from "../assets/service-logos/slack-mark.svg";
import splashtopIcon from "../assets/service-logos/splashtop-logo-120.png";
import whatsappLogo from "../assets/service-logos/whatsapp-logo.svg";
import windowsForumIcon from "../assets/service-logos/windowsforum.png";
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

const HOST_NAME = /^[\w-]+(\.[\w-]+)+$/;

/**
 * Two letters for a reference or connector tile. A host name leads with its
 * brand, the label before the top-level domain, so it never reads like a
 * product name: learn.microsoft.com is ML (not LM, which is LM Studio) and
 * www.kqlsearch.com is KQ. Any other name uses the initials of its first
 * two words.
 */
export function referenceMarkText(name: string): string {
  const trimmed = name.trim();
  if (HOST_NAME.test(trimmed)) {
    const labels = trimmed.toLowerCase().split(".").filter((label) => label !== "www");
    const brand = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
    const sub = labels.length >= 3 ? labels[0] : undefined;
    return (sub ? `${brand[0]}${sub[0]}` : brand.slice(0, 2)).toUpperCase();
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/**
 * A logo file as its owner provides it (sources in
 * `assets/service-logos/NOTICE.md`). `dark` is the owner's variant for dark
 * surfaces; without one the single file shows on both. `scale` renders a
 * file whose artwork carries its own clear space larger; the file is never
 * cropped. `whiteTile` keeps the tile white in both themes for artwork that
 * only reads on a light surface.
 */
interface ReferenceLogoFile {
  id: string;
  light: string;
  dark?: string;
  scale?: number;
  whiteTile?: boolean;
}

// The four squares fill their canvas edge to edge.
const MICROSOFT: ReferenceLogoFile = { id: "microsoft", light: microsoftLogo, scale: 0.88 };
// The site icon has an opaque white background.
const KQL_SEARCH: ReferenceLogoFile = { id: "kqlsearch", light: kqlSearchIcon, whiteTile: true };
const INTUNE_AUTOMATION: ReferenceLogoFile = { id: "intuneautomation", light: intuneAutomationIcon };
const WINDOWS_FORUM: ReferenceLogoFile = { id: "windowsforum", light: windowsForumIcon };
const ENDOFLIFE_AI: ReferenceLogoFile = { id: "endoflife-ai", light: endoflifeIcon };
const TEAMS: ReferenceLogoFile = { id: "microsoft-teams", light: teamsIcon };
const OUTLOOK: ReferenceLogoFile = { id: "microsoft-outlook", light: outlookIcon };
const SLACK: ReferenceLogoFile = { id: "slack", light: slackMark };
const DISCORD: ReferenceLogoFile = { id: "discord", light: discordSymbol };
const SIGNAL: ReferenceLogoFile = { id: "signal", light: signalLogo, dark: signalLogoWhite };
const WHATSAPP: ReferenceLogoFile = { id: "whatsapp", light: whatsappLogo };

/**
 * Public reference hosts by the domain of whoever runs them. A host shows
 * a logo only when it is that domain or one of its subdomains, so a
 * lookalike such as learn-microsoft.com keeps its letters. A listing that
 * names its own logo (the Splashtop references) is drawn by ListingMark.
 */
const HOST_LOGOS: ReadonlyArray<readonly [domain: string, logo: ReferenceLogoFile]> = [
  ["microsoft.com", MICROSOFT],
  ["kqlsearch.com", KQL_SEARCH],
  ["intuneautomation.com", INTUNE_AUTOMATION],
  ["windowsforum.com", WINDOWS_FORUM],
  ["endoflife.ai", ENDOFLIFE_AI],
];

/** Result connectors by the name they go by, in lower case. A Map, so a name such as "constructor" finds nothing. */
const CONNECTOR_LOGOS: ReadonlyMap<string, ReferenceLogoFile> = new Map([
  ["microsoft teams", TEAMS],
  ["outlook", OUTLOOK],
  ["slack", SLACK],
  ["discord", DISCORD],
  ["signal", SIGNAL],
  ["whatsapp", WHATSAPP],
  ["whatsapp web", WHATSAPP],
]);

function referenceLogo(name: string): ReferenceLogoFile | undefined {
  const key = name.trim().toLowerCase();
  if (HOST_NAME.test(key)) return HOST_LOGOS.find(([domain]) => key === domain || key.endsWith(`.${domain}`))?.[1];
  return CONNECTOR_LOGOS.get(key);
}

/** The logo a reference host or result connector shows, or undefined when it keeps its two letters. */
export function referenceLogoId(name: string): string | undefined {
  return referenceLogo(name)?.id;
}

/**
 * The logo of a public reference host or result connector alone, for a
 * surface that draws its own tile; two letters when OpenAdminOS has no
 * logo for it. `surface="light"` keeps the light-surface file in both
 * themes, for a tile that is always white.
 */
export function ReferenceLogo({ name, size, surface }: { name: string; size: number; surface?: "light" }) {
  const logo = referenceLogo(name);
  if (!logo) {
    return (
      <span aria-hidden="true" data-kind="neutral" className="inline-flex shrink-0 items-center justify-center font-semibold" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)), ...(surface === "light" ? { color: "#3a3631" } : {}) }}>
        {referenceMarkText(name)}
      </span>
    );
  }
  const image = "h-full w-full object-contain";
  const style = logo.scale ? { transform: `scale(${logo.scale})` } : undefined;
  return (
    <span aria-hidden="true" data-reference-logo={logo.id} data-kind="logo" className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {logo.dark && surface !== "light" ? (
        <>
          <img src={logo.light} alt="" draggable={false} className={`provider-logo-light ${image}`} style={style} />
          <img src={logo.dark} alt="" draggable={false} className={`provider-logo-dark ${image}`} style={style} />
        </>
      ) : (
        <img src={logo.light} alt="" draggable={false} className={image} style={style} />
      )}
    </span>
  );
}

/**
 * Tile for a public reference or result connector, from its host or name:
 * the owner's logo where OpenAdminOS has it, two letters otherwise.
 */
export function ReferenceMark({ name, size = "md", off = false }: { name: string; size?: "sm" | "md" | "lg"; off?: boolean }) {
  const logo = off ? undefined : referenceLogo(name);
  return (
    <span
      aria-hidden="true"
      className="svc-mark"
      data-service="reference"
      data-size={size}
      data-off={off ? "true" : undefined}
      data-tile={logo?.whiteTile ? "white" : undefined}
    >
      {off ? "" : logo ? <ReferenceLogo name={name} size={INNER[size]} {...(logo.whiteTile ? { surface: "light" as const } : {})} /> : referenceMarkText(name)}
    </span>
  );
}

/**
 * Tile for a Marketplace listing or its host: the owner's logo when the
 * listing names one (both Splashtop Help Centers), else what ReferenceMark
 * shows for `name`: the logo of the host's owner, or two letters.
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
