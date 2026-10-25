// Line figures for the homepage, drawn in isometric projection so they read
// as one set. Strokes use currentColor; nothing here is a product screenshot.
//
// Each figure draws itself once when its card is revealed (see the fig-*
// classes in globals.css). Without JavaScript, or with reduced motion, the
// figures render finished and still.

import type { CSSProperties, ReactNode } from "react";

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
const CX = 160;
const CY = 92;

type Point = readonly [number, number, number];

function iso([x, y, z]: Point) {
  return [CX + (x - y) * COS, CY + (x + y) * SIN - z] as const;
}

function path(points: readonly Point[], close = true) {
  const d = points
    .map((point, index) => {
      const [px, py] = iso(point);
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
  return close ? `${d} Z` : d;
}

/** A flat rectangle in the x/y plane at height z. */
function plate(x: number, y: number, w: number, d: number, z: number) {
  return path([
    [x, y, z],
    [x + w, y, z],
    [x + w, y + d, z],
    [x, y + d, z],
  ]);
}

/** A closed contour: a wobbly ring in the x/y plane at height z. */
function contour(cx: number, cy: number, r: number, z: number, seed: number) {
  const points: Point[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const wobble =
      1 + 0.08 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 5 + seed * 2);
    points.push([cx + Math.cos(a) * r * wobble, cy + Math.sin(a) * r * wobble, z]);
  }
  return path(points);
}

/** Animation timing for one element: start delay and duration in ms. */
function at(delay: number, duration?: number): CSSProperties {
  return {
    ["--fig-delay" as string]: `${delay}ms`,
    ...(duration ? { ["--fig-duration" as string]: `${duration}ms` } : {}),
  };
}

/** A stroke that draws itself from start to end. */
function Draw({
  d,
  delay,
  duration,
  opacity,
  strokeWidth,
}: {
  d: string;
  delay: number;
  duration?: number;
  opacity?: number;
  strokeWidth?: number;
}) {
  return (
    <path
      d={d}
      pathLength={1}
      className="fig-draw"
      style={at(delay, duration)}
      opacity={opacity}
      strokeWidth={strokeWidth}
    />
  );
}

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 -36 320 246"
      className="h-auto w-full"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {children}
    </svg>
  );
}

/** FIG 0.1: a device with the tenant's terrain held on top of it. */
export function FigureLocal() {
  const top = 40;
  const radii = [12, 23, 35, 48, 62];
  return (
    <Frame label="A device with tenant terrain contained on its surface">
      <Draw d={plate(-80, -80, 160, 160, 0)} delay={0} opacity={0.35} />
      <Draw
        delay={120}
        d={path([
          [80, -80, 0],
          [80, 80, 0],
          [80, 80, top],
          [80, -80, top],
        ])}
      />
      <Draw
        delay={220}
        d={path([
          [-80, 80, 0],
          [80, 80, 0],
          [80, 80, top],
          [-80, 80, top],
        ])}
      />
      <Draw d={plate(-80, -80, 160, 160, top)} delay={340} />
      {radii.map((r, i) => (
        <Draw
          key={r}
          d={contour(4, -2, r, top, (radii.length - 1 - i) * 1.3)}
          delay={760 + i * 150}
          duration={700}
          opacity={1 - i * 0.13}
        />
      ))}
    </Frame>
  );
}

/** FIG 0.2: stacked evidence with two numbered sources. */
export function FigureEvidence() {
  const sheets = [0, 18, 36];
  const [l1x, l1y] = iso([-40, -30, 36]);
  const [l2x, l2y] = iso([10, 20, 36]);
  const markers = [
    { n: 1, x: l1x - 40, y: l1y - 34, delay: 1350 },
    { n: 2, x: l2x + 46, y: l2y - 54, delay: 1480 },
  ];
  return (
    <Frame label="Stacked evidence sheets with two numbered sources">
      {sheets.map((z, i) => (
        <g key={z} className="fig-drop" style={at(i * 170)}>
          <path
            d={plate(-70, -55, 140, 110, z)}
            opacity={i === sheets.length - 1 ? 1 : 0.35 + i * 0.2}
          />
        </g>
      ))}
      {[-35, -15, 5, 25].map((y, i) => (
        <Draw
          key={y}
          d={path(
            [
              [-50, y, 36],
              [y === 25 ? 10 : 45, y, 36],
            ],
            false,
          )}
          delay={650 + i * 100}
          duration={450}
          opacity={0.55}
        />
      ))}
      <Draw d={`M${l1x} ${l1y} L${l1x - 34} ${l1y - 27}`} delay={1080} duration={350} opacity={0.6} />
      <Draw d={`M${l2x} ${l2y} L${l2x + 40} ${l2y - 46}`} delay={1200} duration={350} opacity={0.6} />
      {markers.map((marker) => (
        <g key={marker.n} className="fig-pop" style={at(marker.delay)}>
          <circle cx={marker.x} cy={marker.y} r={9} />
          <text
            x={marker.x}
            y={marker.y + 3.5}
            fontSize={10}
            textAnchor="middle"
            fill="currentColor"
            stroke="none"
            fontFamily="var(--font-sans)"
          >
            {marker.n}
          </text>
        </g>
      ))}
    </Frame>
  );
}

/** FIG 0.3: a proposed change that waits on a typed confirmation. */
export function FigureApproval() {
  const z = 34;
  const [caretX, caretY] = iso([0, 71, 0]);
  return (
    <Frame label="A proposed change sheet waiting on a typed confirmation field">
      <Draw d={plate(-70, -80, 140, 110, z)} delay={0} />
      {[-60, -42, -24, -6, 12].map((y, i) => {
        const d = path(
          [
            [-52, y, z],
            [i % 2 === 0 ? 46 : 20, y, z],
          ],
          false,
        );
        // The dashed line fades in: a dash pattern cannot also draw itself.
        return i === 3 ? (
          <g key={y} className="fig-fade" style={at(380 + i * 110)}>
            <path d={d} opacity={0.45} strokeDasharray="4 4" />
          </g>
        ) : (
          <Draw
            key={y}
            d={d}
            delay={380 + i * 110}
            duration={450}
            opacity={i === 1 ? 1 : 0.45}
          />
        );
      })}
      <Draw d={plate(-70, 60, 140, 22, 0)} delay={1000} duration={600} />
      <Draw
        d={path(
          [
            [-50, 71, 0],
            [-6, 71, 0],
          ],
          false,
        )}
        delay={1450}
        duration={900}
        strokeWidth={2.4}
        opacity={0.7}
      />
      <g className="fig-pop" style={at(2300)}>
        <path
          d={`M${caretX.toFixed(1)} ${(caretY - 6).toFixed(1)} l0 12`}
          strokeWidth={1.6}
          className="figure-caret"
        />
      </g>
    </Frame>
  );
}
