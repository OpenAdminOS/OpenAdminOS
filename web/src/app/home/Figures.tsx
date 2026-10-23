// Line figures for the homepage, drawn in isometric projection so they read
// as one set. Strokes use currentColor; nothing here is a product screenshot.

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

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
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
  return (
    <Frame label="A device with tenant terrain contained on its surface">
      <path d={plate(-80, -80, 160, 160, 0)} opacity={0.35} />
      <path
        d={path(
          [
            [80, -80, 0],
            [80, 80, 0],
            [80, 80, top],
            [80, -80, top],
          ],
        )}
      />
      <path
        d={path(
          [
            [-80, 80, 0],
            [80, 80, 0],
            [80, 80, top],
            [-80, 80, top],
          ],
        )}
      />
      <path d={plate(-80, -80, 160, 160, top)} />
      {[62, 48, 35, 23, 12].map((r, i) => (
        <path key={r} d={contour(4, -2, r, top, i * 1.3)} opacity={0.35 + i * 0.13} />
      ))}
    </Frame>
  );
}

/** FIG 0.2: stacked evidence with two numbered sources. */
export function FigureEvidence() {
  const sheets = [0, 18, 36];
  const [l1x, l1y] = iso([-40, -30, 36]);
  const [l2x, l2y] = iso([10, 20, 36]);
  return (
    <Frame label="Stacked evidence sheets with two numbered sources">
      {sheets.map((z, i) => (
        <path
          key={z}
          d={plate(-70, -55, 140, 110, z)}
          opacity={i === sheets.length - 1 ? 1 : 0.35 + i * 0.2}
        />
      ))}
      {[-35, -15, 5, 25].map((y) => (
        <path
          key={y}
          d={path(
            [
              [-50, y, 36],
              [y === 25 ? 10 : 45, y, 36],
            ],
            false,
          )}
          opacity={0.55}
        />
      ))}
      <path d={`M${l1x} ${l1y} L${l1x - 34} ${l1y - 27}`} opacity={0.6} />
      <path d={`M${l2x} ${l2y} L${l2x + 40} ${l2y - 46}`} opacity={0.6} />
      <circle cx={l1x - 40} cy={l1y - 34} r={9} />
      <circle cx={l2x + 46} cy={l2y - 54} r={9} />
      <text
        x={l1x - 40}
        y={l1y - 30.5}
        fontSize={10}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-sans)"
      >
        1
      </text>
      <text
        x={l2x + 46}
        y={l2y - 50.5}
        fontSize={10}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-sans)"
      >
        2
      </text>
    </Frame>
  );
}

/** FIG 0.3: a proposed change that waits on a typed confirmation. */
export function FigureApproval() {
  const z = 34;
  const [cx, cy] = iso([-58, 71, 0]);
  return (
    <Frame label="A proposed change sheet waiting on a typed confirmation field">
      <path d={plate(-70, -80, 140, 110, z)} />
      {[-60, -42, -24, -6, 12].map((y, i) => (
        <path
          key={y}
          d={path(
            [
              [-52, y, z],
              [i % 2 === 0 ? 46 : 20, y, z],
            ],
            false,
          )}
          opacity={i === 1 ? 1 : 0.45}
          strokeDasharray={i === 3 ? "4 4" : undefined}
        />
      ))}
      <path d={plate(-70, 60, 140, 22, 0)} />
      <path d={path([[-50, 71, 0], [-6, 71, 0]], false)} strokeWidth={2.4} opacity={0.7} />
      <path d={`M${cx + 40} ${cy + 15} l0 -12`} strokeWidth={1.6} className="figure-caret" />
    </Frame>
  );
}
