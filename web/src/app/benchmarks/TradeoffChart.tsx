import type { BenchmarkData } from "~/lib/benchmarks/data";

const WIDTH = 620;
const HEIGHT = 320;
const LEFT = 52;
const RIGHT = 24;
const TOP = 26;
const BOTTOM = 56;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;

/**
 * Quality against a cost of some kind, the trade-off chart the general model
 * leaderboards are built around. The desirable corner is named in words:
 * "up and to the left is good" is not obvious from a single chart.
 */
export function TradeoffChart({
  data,
  colours,
  valueOf,
  format,
  axisLabel,
  cornerLabel,
  title,
}: {
  data: BenchmarkData;
  colours: Record<string, string>;
  valueOf: (model: BenchmarkData["models"][number]) => number;
  format: (value: number) => string;
  axisLabel: string;
  cornerLabel: string;
  title: string;
}) {
  const values = data.models.map(valueOf);
  const xMax = Math.max(...values) * 1.18;
  const yMin = Math.max(0, Math.min(...data.models.map((m) => m.score)) - 12);

  const x = (value: number) => LEFT + (PLOT_W * value) / xMax;
  const y = (value: number) =>
    TOP + PLOT_H - (PLOT_H * (value - yMin)) / (data.taskCount - yMin);

  const yTicks: number[] = [];
  for (let value = yMin; value <= data.taskCount; value += 5) yTicks.push(value);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      role="img"
      aria-label={title}
    >
      {yTicks.map((value) => (
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

      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = xMax * fraction;
        return (
          <g key={fraction}>
            <line
              x1={x(value)}
              x2={x(value)}
              y1={TOP}
              y2={TOP + PLOT_H}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={x(value)}
              y={TOP + PLOT_H + 20}
              textAnchor="middle"
              className="fill-white/35 text-[11px]"
            >
              {format(value)}
            </text>
          </g>
        );
      })}

      <text
        x={LEFT + PLOT_W / 2}
        y={HEIGHT - 12}
        textAnchor="middle"
        className="fill-white/40 text-[11px]"
      >
        {axisLabel}
      </text>
      <text x={LEFT + 6} y={TOP - 8} className="fill-white/40 text-[11px]">
        {cornerLabel}
      </text>

      {data.models.map((model) => {
        const cx = x(valueOf(model));
        const cy = y(model.score);
        const flip = cx > LEFT + PLOT_W * 0.66;
        return (
          <g key={model.id}>
            <circle
              cx={cx}
              cy={cy}
              r={8}
              fill={colours[model.id]}
              fillOpacity={0.2}
              stroke={colours[model.id]}
              strokeWidth={2}
            >
              <title>{`${model.name}: ${model.score} of ${data.taskCount}, ${format(valueOf(model))}`}</title>
            </circle>
            <text
              x={cx + (flip ? -14 : 14)}
              y={cy + 4}
              textAnchor={flip ? "end" : "start"}
              className="text-[11px] font-medium"
              fill={colours[model.id]}
            >
              {model.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
