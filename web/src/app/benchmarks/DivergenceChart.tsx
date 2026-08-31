"use client";

import { useCallback, useRef, useState } from "react";

import type { BenchmarkData } from "~/lib/benchmarks/data";

const WIDTH = 900;
const HEIGHT = 340;
const LEFT = 44;
const RIGHT = 132;
const TOP = 20;
const BOTTOM = 48;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;

/**
 * Cumulative correct answers across the run, one line per model.
 *
 * The rising-line form the general leaderboards use, applied to something it
 * actually describes: where the models diverge and by how much. A flat step is
 * a miss, so the shape carries information a bar chart throws away.
 */
export function DivergenceChart({
  data,
  colours,
}: {
  data: BenchmarkData;
  colours: Record<string, string>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const n = data.taskCount;
  const x = useCallback((index: number) => LEFT + (PLOT_W * index) / (n - 1), [n]);
  const y = useCallback((value: number) => TOP + PLOT_H - (PLOT_H * value) / n, [n]);

  const onMove = useCallback(
    (event: React.MouseEvent<SVGRectElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const local = ((event.clientX - rect.left) * WIDTH) / rect.width;
      const index = Math.round(((local - LEFT) / PLOT_W) * (n - 1));
      setHover(Math.max(0, Math.min(n - 1, index)));
    },
    [n],
  );

  const gridValues: number[] = [];
  for (let value = 0; value <= n; value += Math.max(10, Math.round(n / 10))) {
    gridValues.push(value);
  }

  const ranked = [...data.models].sort(
    (a, b) => (b.cumulative.at(-1) ?? 0) - (a.cumulative.at(-1) ?? 0),
  );
  const labelYs: number[] = [];

  return (
    <figure className="m-0">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`Cumulative correct answers across ${n} tasks, one line per model`}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={LEFT}
              x2={LEFT + PLOT_W}
              y1={y(value)}
              y2={y(value)}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={LEFT - 10}
              y={y(value) + 4}
              textAnchor="end"
              className="fill-white/35 text-[11px]"
            >
              {value}
            </text>
          </g>
        ))}

        {/* a flawless run, as the ceiling every line is measured against */}
        <line
          x1={x(0)}
          y1={y(1)}
          x2={x(n - 1)}
          y2={y(n)}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1}
          strokeDasharray="3 5"
        />
        <text x={x(n - 1) + 8} y={y(n) + 4} className="fill-white/35 text-[11px]">
          perfect
        </text>

        {data.models.map((model) => (
          <polyline
            key={model.id}
            fill="none"
            stroke={colours[model.id]}
            strokeWidth={2}
            strokeLinejoin="round"
            points={model.cumulative
              .map((value, index) => `${x(index)},${y(value)}`)
              .join(" ")}
          />
        ))}

        {ranked.map((model) => {
          const final = model.cumulative.at(-1) ?? 0;
          let labelY = y(final) + 4;
          while (labelYs.some((placed) => Math.abs(placed - labelY) < 15)) {
            labelY += 15;
          }
          labelYs.push(labelY);
          return (
            <g key={model.id}>
              <circle cx={x(n - 1)} cy={y(final)} r={3.5} fill={colours[model.id]} />
              <text
                x={x(n - 1) + 8}
                y={labelY}
                className="text-[11px] font-medium"
                fill={colours[model.id]}
              >
                {model.name} {final}
              </text>
            </g>
          );
        })}

        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={TOP}
            y2={TOP + PLOT_H}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        )}

        <text x={LEFT} y={HEIGHT - 16} className="fill-white/35 text-[11px]">
          task 1
        </text>
        <text
          x={LEFT + PLOT_W}
          y={HEIGHT - 16}
          textAnchor="end"
          className="fill-white/35 text-[11px]"
        >
          task {n}
        </text>

        <rect
          x={LEFT}
          y={TOP}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      <figcaption className="mt-3 min-h-[3.25rem] text-sm text-white/50">
        {hover === null ? (
          <>Hover the chart to read every model&rsquo;s score at a given task.</>
        ) : (
          <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span className="text-white/70">
              Task {hover + 1} · {data.taskIds[hover]?.replace("v2-", "")}
            </span>
            {data.models.map((model) => (
              <span key={model.id} className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: colours[model.id] }}
                />
                {model.name} {model.cumulative[hover]}
              </span>
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
