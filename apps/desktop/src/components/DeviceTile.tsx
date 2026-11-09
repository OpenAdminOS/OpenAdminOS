import { IconLogo } from "./icons";

const LOGO_SIZE = { xl: 52, lg: 36, sm: 20 } as const;

/**
 * This device, as every reach figure draws it: the accent tile with the
 * OpenAdminOS mark. Sizes are 104 px (first launch), 72 px (Connections)
 * and 40 px (rows). Decorative unless a label is given.
 */
export function DeviceTile({ size = "lg", label }: { size?: "xl" | "lg" | "sm"; label?: string }) {
  return (
    <span
      className="device-tile"
      data-size={size}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <IconLogo size={LOGO_SIZE[size]} />
    </span>
  );
}
