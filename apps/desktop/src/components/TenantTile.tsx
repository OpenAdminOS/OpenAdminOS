import { IconUsers } from "./icons";

const TENANT_COLORS = [
  "#315A78",
  "#326457",
  "#5C4E78",
  "#75512F",
  "#6D414A",
  "#376170",
  "#5D5B31",
  "#4D5866",
] as const;

const SIZE_CLASSES = {
  xs: "h-4 w-4 text-[8px] rounded-[4px]",
  sm: "h-5 w-5 text-[9px] rounded-[5px]",
  md: "h-10 w-10 text-sm rounded-[10px]",
} as const;

function tenantInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

function colorIndex(tenantId: string): number {
  let hash = 0;
  for (let index = 0; index < tenantId.length; index += 1) {
    hash = (hash * 31 + tenantId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % TENANT_COLORS.length;
}

export function TenantTile({
  tenantId,
  displayName,
  size = "sm",
  className = "",
}: {
  tenantId: string;
  displayName: string;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center font-semibold leading-none text-white ${SIZE_CLASSES[size]} ${className}`}
      style={{ backgroundColor: TENANT_COLORS[colorIndex(tenantId)] }}
    >
      {tenantInitials(displayName)}
    </span>
  );
}

export function MultiTenantTile({ size = "xs" }: { size?: "xs" | "sm" }) {
  const dimension = size === "xs" ? "h-4 w-4 rounded-[4px]" : "h-5 w-5 rounded-[5px]";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center bg-[var(--color-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)] ${dimension}`}
    >
      <IconUsers size={size === "xs" ? 10 : 12} />
    </span>
  );
}
