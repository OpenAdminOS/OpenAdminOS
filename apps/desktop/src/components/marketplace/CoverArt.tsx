import { useMemo } from "react";

/**
 * Generative cover art for Marketplace listings, after
 * docs/mockups/25-marketplace.html. Each listing gets a stable ink and
 * pattern from its id, so a cover is recognisable without vendor logos.
 */
export interface Ink {
  ground: string;
  line: string;
  highlight: string;
}

const INKS: Record<string, Ink> = {
  ink: { ground: "#16213a", line: "#a6bbe0", highlight: "#eef2fb" },
  ochre: { ground: "#2a2315", line: "#dfc283", highlight: "#fbf1d6" },
  plum: { ground: "#241b30", line: "#c6addf", highlight: "#f3ebfc" },
  teal: { ground: "#11292b", line: "#8fcac4", highlight: "#e3f7f4" },
  oxblood: { ground: "#2c171a", line: "#e3a5a0", highlight: "#fce7e4" },
  moss: { ground: "#18281e", line: "#a7c99b", highlight: "#eaf6e5" },
  slate: { ground: "#1c2128", line: "#b5bfcc", highlight: "#f3f5f8" },
};

type Art = (ink: Ink, random: () => number) => string;

const f = (value: number) => value.toFixed(1);
const polar = (cx: number, cy: number, radius: number, angle: number) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;

const ART: Record<string, Art> = {
  devices(c, r) {
    let s = "";
    for (let i = 0; i < 11; i += 1) for (let j = 0; j < 14; j += 1) {
      const x = 122 + j * 20, y = 16 + i * 20, v = r();
      if (v < 0.17) s += `<rect x="${x}" y="${y}" width="12" height="12" rx="3" fill="none" stroke="${c.line}" stroke-opacity=".5" stroke-dasharray="2 2"/>`;
      else if (v > 0.95) s += `<rect x="${x}" y="${y}" width="12" height="12" rx="3" fill="${c.highlight}"/>`;
      else s += `<rect x="${x}" y="${y}" width="12" height="12" rx="3" fill="${c.line}" fill-opacity="${f(0.14 + r() * 0.42)}"/>`;
    }
    return s;
  },
  rings(c, r) {
    const cx = 300, cy = 128;
    let s = "";
    for (let k = 1; k <= 11; k += 1) {
      const radius = k * 17;
      s += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${c.line}" stroke-opacity=".16"/>`;
      if (r() < 0.75) {
        const a0 = r() * Math.PI * 2, sweep = 0.5 + r() * 2.2;
        const [x1, y1] = polar(cx, cy, radius, a0), [x2, y2] = polar(cx, cy, radius, a0 + sweep);
        const hot = k === 7;
        s += `<path d="M${f(x1)} ${f(y1)} A${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(x2)} ${f(y2)}" fill="none" stroke="${hot ? c.highlight : c.line}" stroke-width="${hot ? 3 : 2.2}" stroke-linecap="round" stroke-opacity="${hot ? 1 : 0.75}"/>`;
      }
    }
    return `${s}<circle cx="${cx}" cy="${cy}" r="4" fill="${c.highlight}"/>`;
  },
  graph(c, r) {
    const points = Array.from({ length: 30 }, () => [140 + r() * 250, 18 + r() * 214] as const);
    let s = "";
    points.forEach((p, i) => {
      points
        .map((q, j) => [j, (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2] as const)
        .filter(([j]) => j !== i)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 2)
        .forEach(([j]) => {
          const q = points[j]!, dash = r() < 0.22;
          s += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(q[0])}" y2="${f(q[1])}" stroke="${c.line}" stroke-opacity="${dash ? 0.55 : 0.32}"${dash ? ' stroke-dasharray="3 4"' : ""}/>`;
        });
    });
    points.forEach((p, i) => {
      s += `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(2.5 + r() * 3)}" fill="${i % 9 === 0 ? c.highlight : c.line}" fill-opacity="${i % 9 === 0 ? 1 : 0.8}"/>`;
      if (i % 9 === 0) s += `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="13" fill="none" stroke="${c.highlight}" stroke-opacity=".45"/>`;
    });
    return s;
  },
  waves(c) {
    let s = "";
    for (let k = 0; k < 17; k += 1) {
      const y0 = 30 + k * 12, hot = k === 9;
      let d = "";
      for (let x = 100; x <= 400; x += 8) {
        const y = y0 + Math.sin(x / 34 + k * 0.55) * (5 + k * 0.6) + Math.sin(x / 13 + k) * 2;
        d += `${x === 100 ? "M" : "L"}${x} ${f(y)} `;
      }
      s += `<path d="${d}" fill="none" stroke="${hot ? c.highlight : c.line}" stroke-width="${hot ? 2 : 1.1}" stroke-opacity="${hot ? 1 : f(0.18 + k * 0.025)}"/>`;
    }
    return s;
  },
  keys(c, r) {
    let s = "";
    for (let i = 0; i < 11; i += 1) {
      const y = 24 + i * 20, x0 = 130 + r() * 110, length = 40 + r() * 130, open = r() < 0.33;
      s += `<line x1="120" y1="${y}" x2="392" y2="${y}" stroke="${c.line}" stroke-opacity=".12"/>`;
      s += `<rect x="${f(x0)}" y="${y - 3}" width="${f(length)}" height="6" rx="3" fill="${c.line}" fill-opacity="${open ? 0.3 : 0.7}"/>`;
      if (open) s += `<line x1="${f(x0 + length)}" y1="${y}" x2="392" y2="${y}" stroke="${c.line}" stroke-opacity=".5" stroke-dasharray="2 5"/>`;
    }
    return s;
  },
  checks(c, r) {
    let s = "";
    for (let i = 0; i < 7; i += 1) for (let j = 0; j < 9; j += 1) {
      const x = 150 + j * 27, y = 22 + i * 30, v = r();
      s += `<rect x="${x}" y="${y}" width="20" height="20" rx="5" fill="none" stroke="${c.line}" stroke-opacity="${v < 0.12 ? 0.6 : 0.25}"${v < 0.12 ? ' stroke-dasharray="2 2"' : ""}/>`;
      if (v >= 0.12) s += `<path d="M${x + 5} ${y + 10.5} l3.5 3.5 l6.5 -7.5" fill="none" stroke="${v > 0.93 ? c.highlight : c.line}" stroke-width="${v > 0.93 ? 2.2 : 1.6}" stroke-opacity="${v > 0.93 ? 1 : 0.7}"/>`;
    }
    return s;
  },
  layers(c) {
    let s = "";
    for (let k = 0; k < 7; k += 1) {
      const x = 150 + k * 18, y = 26 + k * 14, top = k === 6;
      s += `<rect x="${x}" y="${y}" width="170" height="104" rx="10" fill="${c.ground}" stroke="${top ? c.highlight : c.line}" stroke-opacity="${top ? 1 : f(0.2 + k * 0.08)}"/>`;
      if (top) [110, 80, 128, 60].forEach((width, n) => {
        s += `<rect x="${x + 16}" y="${y + 18 + n * 18}" width="${width}" height="6" rx="3" fill="${c.line}" fill-opacity=".7"/>`;
      });
    }
    return s;
  },
};

/** Fixed art for the catalog servers; agents get theirs from a hash of the slug. */
const FIXED: Record<string, { ink: string; art: string }> = {
  "microsoft-learn": { ink: "ink", art: "layers" },
  "kql-search": { ink: "teal", art: "waves" },
  intuneautomation: { ink: "ochre", art: "keys" },
  "release-communications": { ink: "slate", art: "rings" },
  windowsforum: { ink: "plum", art: "graph" },
  "endoflife-ai": { ink: "oxblood", art: "checks" },
};

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function inkFor(id: string): Ink {
  const inks = Object.keys(INKS);
  return INKS[FIXED[id]?.ink ?? inks[hash(id) % inks.length]!]!;
}

function artFor(id: string): Art {
  const names = Object.keys(ART);
  return ART[FIXED[id]?.art ?? names[(hash(id) >>> 3) % names.length]!]!;
}

/** Decorative only: the listing name is always rendered as text beside it. */
export function CoverArt({ id, variant = "cover", className = "" }: { id: string; variant?: "cover" | "icon"; className?: string }) {
  // The markup holds only generated numbers and the fixed ink colours; the
  // id feeds the hash and is never interpolated.
  const markup = useMemo(() => {
    const ink = inkFor(id);
    return `<rect x="0" y="0" width="400" height="250" fill="${ink.ground}"/>${artFor(id)(ink, rng(hash(id)))}`;
  }, [id]);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={variant === "icon" ? "150 40 180 180" : "0 0 400 250"}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
