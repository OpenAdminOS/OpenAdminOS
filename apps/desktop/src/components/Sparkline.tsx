interface SparklineProps {
  data: number[];
  height?: number;
  className?: string;
  highlightLast?: boolean;
}

/**
 * A minimal SVG bar-sparkline. Bars use the accent color, last bar can be highlighted.
 * Width is responsive — uses preserveAspectRatio: none so it stretches to container.
 */
export function Sparkline({
  data,
  height = 32,
  className = "",
  highlightLast = true,
}: SparklineProps) {
  const max = Math.max(...data, 1);
  const barWidth = 100 / data.length;
  const gap = barWidth * 0.2;
  const innerWidth = barWidth - gap;

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={`w-full ${className}`}
      style={{ height }}
      aria-hidden
    >
      {data.map((v, i) => {
        const h = (v / max) * (height - 2);
        const y = height - h;
        const x = i * barWidth + gap / 2;
        const isLast = i === data.length - 1 && highlightLast;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={innerWidth}
            height={h}
            rx={0.6}
            fill={isLast ? "var(--color-accent)" : "var(--color-accent-strong)"}
            opacity={isLast ? 1 : 0.55 - (data.length - i - 1) * 0.04}
          />
        );
      })}
    </svg>
  );
}
