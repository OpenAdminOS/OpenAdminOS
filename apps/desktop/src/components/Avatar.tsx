function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const palettes = [
  ["#e8a87c", "#c97b5a"],
  ["#a3bfd9", "#6d8db0"],
  ["#9cc88f", "#6ea566"],
  ["#c4a5d9", "#9579b5"],
  ["#e5c678", "#bc9a4a"],
  ["#dd9090", "#b46c6c"],
  ["#7fb6b4", "#4f8987"],
  ["#d49da8", "#a8757f"],
];

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
  const hash = hashString(name);
  const [a, b] = palettes[hash % palettes.length];
  const angle = (hash % 360);
  return (
    <div
      className={`inline-flex shrink-0 items-center justify-center font-medium text-[#1a120c] select-none ${
        ring ? "ring-2 ring-[var(--color-bg)]" : ""
      } ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(${angle}deg, ${a}, ${b})`,
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
