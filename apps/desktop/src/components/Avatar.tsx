function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  size = 28,
  ring = false,
  className = "",
}: {
  name: string;
  size?: number;
  ring?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex shrink-0 items-center justify-center font-medium text-[var(--color-text-soft)] select-none ${
        ring ? "ring-2 ring-[var(--color-bg)]" : "ring-1 ring-[var(--color-border)]"
      } ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-raised)",
        fontSize: Math.round(size * 0.42),
        letterSpacing: "0.01em",
      }}
      aria-label={name}
    >
      {initials(name)}
    </div>
  );
}

export function AvatarStack({
  names,
  size = 22,
  max = 3,
}: {
  names: string[];
  size?: number;
  max?: number;
}) {
  const visible = names.slice(0, max);
  const overflow = names.length - max;
  return (
    <div className="flex items-center">
      {visible.map((n, i) => (
        <div
          key={n}
          style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: visible.length - i }}
          className="relative"
        >
          <Avatar name={n} size={size} ring />
        </div>
      ))}
      {overflow > 0 && (
        <div
          style={{
            marginLeft: -size * 0.32,
            width: size,
            height: size,
            fontSize: Math.round(size * 0.36),
          }}
          className="inline-flex items-center justify-center rounded-full bg-[var(--color-bg-raised)] font-medium text-[var(--color-text-soft)] ring-2 ring-[var(--color-bg)]"
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
