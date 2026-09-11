import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { OfficePersona } from "../../shared/openAdminOS";

export function PersonaAvatar({
  avatar,
  color,
}: Pick<OfficePersona, "avatar" | "color">) {
  return (
    <svg
      className={`persona-avatar persona-${color}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <ellipse
        cx="50"
        cy="91"
        rx="26"
        ry="5"
        fill="currentColor"
        opacity=".12"
      />
      <path
        className="persona-feet"
        d="M30 73v13h12V75m16 0v11h12V73"
        fill="currentColor"
      />
      <rect x="26" y="49" width="48" height="31" rx="12" fill="currentColor" />
      <path
        className="persona-hands"
        d="M27 57l-9 11m55-11 9 11"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
      {avatar === "robot" ? (
        <>
          <path d="M50 25V13" stroke="currentColor" strokeWidth="4" />
          <circle cx="50" cy="11" r="5" fill="currentColor" />
          <rect
            x="20"
            y="25"
            width="60"
            height="39"
            rx="13"
            fill="currentColor"
          />
          <rect x="27" y="32" width="46" height="24" rx="8" fill="#24211f" />
        </>
      ) : (
        <>
          <path
            d={
              avatar === "owl"
                ? "M21 39 18 17 39 28Q50 22 61 28L82 17 79 39"
                : "M22 39 24 12 43 28H57L76 12 78 39"
            }
            fill="currentColor"
          />
          <ellipse cx="50" cy="44" rx="31" ry="25" fill="currentColor" />
          {avatar === "owl" && (
            <>
              <circle cx="37" cy="43" r="13" fill="#f5f1eb" opacity=".8" />
              <circle cx="63" cy="43" r="13" fill="#f5f1eb" opacity=".8" />
            </>
          )}
          {avatar === "fox" && (
            <path
              d="M22 43 50 67 78 43 59 49 50 42 41 49Z"
              fill="#f5f1eb"
              opacity=".8"
            />
          )}
        </>
      )}
      <rect
        x="34"
        y="39"
        width="6"
        height="10"
        rx="3"
        fill={avatar === "robot" ? "currentColor" : "#24211f"}
      />
      <rect
        x="60"
        y="39"
        width="6"
        height="10"
        rx="3"
        fill={avatar === "robot" ? "currentColor" : "#24211f"}
      />
      {avatar !== "robot" && <path d="m46 53 4 4 4-4" fill="#24211f" />}
      <rect
        x="41"
        y="68"
        width="18"
        height="4"
        rx="2"
        fill="#24211f"
        opacity=".4"
      />
    </svg>
  );
}

type SceneProps = {
  personas: OfficePersona[];
  statuses: Record<string, string>;
  events?: Record<
    string,
    { text: string; at: string; runId?: string; handoff?: boolean; handoffAt?:string }
  >;
  selectedId?: string;
  onSelect: (id: string) => void;
};

function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cy="6" rx="25" ry="7" fill="#171e1d" opacity=".35" />
      <path d="M-17-24h34L12 4h-24Z" fill="#bb795b" />
      <path d="M-19-25h38v7h-38Z" fill="#d29670" />
      <path d="M0-24v-65" stroke="#82a684" strokeWidth="3" />
      <path
        d="M0-37C-33-35-34-64-22-65-6-64 0-49 0-37M0-53C33-51 34-82 21-82 7-80 0-67 0-53M0-72C-25-70-28-96-18-99-3-95 0-81 0-72"
        fill="#7caa82"
      />
    </g>
  );
}

function Desk({ x, y, active }: { x: number; y: number; active: boolean }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className={active ? "scene-desk-active" : ""}
    >
      <ellipse cx="5" cy="37" rx="67" ry="12" fill="#182421" opacity=".3" />
      <rect
        x="-27"
        y="-35"
        width="48"
        height="54"
        rx="14"
        fill="#526d65"
        stroke="#799289"
        strokeWidth="3"
      />
      <path d="M-52 0v34m102-34v34" stroke="#3d3931" strokeWidth="7" />
      <path d="M-63-12h122l10 19H-72Z" fill="#c8a27a" />
      <path d="M-72 7H69v8H-72Z" fill="#98714f" />
      <path d="M-6-18v12m-13 0h26" stroke="#35443f" strokeWidth="5" />
      <rect
        x="-34"
        y="-62"
        width="58"
        height="42"
        rx="4"
        fill="#243631"
        stroke="#72857b"
        strokeWidth="4"
      />
      <g
        className="scene-code"
        stroke={active ? "#a9daba" : "#53776c"}
        strokeWidth="3"
        strokeLinecap="round"
      >
        <path d="M-24-51h19m-19 8h34m-34 8h25" />
      </g>
      <path d="M-26 0H8l5 6h-44Z" fill="#4b5850" />
      <rect x="40" y="-21" width="12" height="17" rx="3" fill="#e0c798" />
      <path d="M52-18h4v9h-4" fill="none" stroke="#e0c798" strokeWidth="3" />
      <path
        className="scene-steam"
        d="M44-26q-5-6 0-12"
        fill="none"
        stroke="#eedeca"
        strokeWidth="2"
        opacity=".5"
      />
    </g>
  );
}

function OfficeInterior({ working }: { working: boolean[] }) {
  return (
    <svg className="office-interior" viewBox="0 0 1000 560" aria-hidden="true">
      <defs>
        <linearGradient id="team-wall" x2="0" y2="1">
          <stop stopColor="#405951" />
          <stop offset="1" stopColor="#293f38" />
        </linearGradient>
        <linearGradient id="team-sky" x2="0" y2="1">
          <stop stopColor="#79a8aa" />
          <stop offset="1" stopColor="#e6cc9c" />
        </linearGradient>
        <pattern
          id="team-floor"
          width="120"
          height="38"
          patternUnits="userSpaceOnUse"
        >
          <path d="M0 0h120v38H0Z" fill="#927558" stroke="#80644c" />
          <path d="M60 0v38" stroke="#a58b6a" opacity=".4" />
        </pattern>
        <pattern
          id="team-rug"
          width="14"
          height="14"
          patternUnits="userSpaceOnUse"
        >
          <path d="M0 7h14M7 0v14" stroke="#b0937a" opacity=".16" />
        </pattern>
      </defs>
      <path d="M0 0h1000v560H0Z" fill="url(#team-wall)" />
      <path d="M0 230h1000v330H0Z" fill="url(#team-floor)" />
      <path d="M0 229h1000" stroke="#20362f" strokeWidth="15" />
      <path
        d="M0 15h1000M18 0v230m964-230v230"
        stroke="#526c60"
        strokeWidth="12"
      />
      {/* Recessed windows, skyline, and afternoon light on the floor. */}
      {[60, 254].map((x) => (
        <g key={x} transform={`translate(${x} 54)`}>
          <rect x="-8" y="-8" width="164" height="133" rx="3" fill="#20352f" />
          <rect width="148" height="110" fill="url(#team-sky)" />
          <circle cx="115" cy="28" r="14" fill="#f8dfa9" opacity=".8" />
          <path
            d="M0 110V69h24V49h23v61h15V79h22V63h24v47h15V83h25v27"
            fill="#5b817c"
            opacity=".5"
          />
          <path d="M74 0v110M0 54h148" stroke="#d7c5a3" strokeWidth="5" />
          <path d="M-12 117h172" stroke="#aa9475" strokeWidth="9" />
        </g>
      ))}
      <path d="m55 239 157 0 185 251H159Z" fill="#f8dba0" opacity=".09" />
      <path d="m251 239 157 0 185 251H355Z" fill="#f8dba0" opacity=".06" />
      {/* Wall clock and pinboard. */}
      <g transform="translate(475 87)">
        <circle r="24" fill="#dfd5b9" stroke="#243830" strokeWidth="6" />
        <path d="M0-16V0l10 6" fill="none" stroke="#405a4d" strokeWidth="3" />
        <circle r="3" fill="#405a4d" />
      </g>
      <g transform="translate(563 50)">
        <rect
          width="138"
          height="87"
          rx="3"
          fill="#ae8b62"
          stroke="#253d34"
          strokeWidth="7"
        />
        <path d="m15 15 33-3 3 31-34 3Zm56-1 43 6-4 36-43-6Z" fill="#e8d9ab" />
        <path
          d="m24 25 16-2m-16 9 20-2m38-5 20 3m-21 6 24 3"
          stroke="#947e57"
          strokeWidth="2"
        />
        <circle cx="31" cy="16" r="3" fill="#a65f4b" />
        <circle cx="91" cy="22" r="3" fill="#667e69" />
      </g>
      <g transform="translate(749 58)" fill="#e8ddc4">
        <text fontFamily="monospace" fontSize="10" letterSpacing="3">
          OPENADMINOS
        </text>
        <text y="29" fontSize="22" fontWeight="600">
          A place for your team.
        </text>
        <text y="49" fontSize="11" fill="#b9c9b9">
          On duty. On standby. Together.
        </text>
      </g>
      <path d="M538 162v66" stroke="#1f362e" strokeWidth="7" />
      <path d="M520 165h41l-8-29h-25Z" fill="#d9ba82" />
      <ellipse cx="540" cy="227" rx="21" ry="5" fill="#24372e" />
      {/* Work zone with individual desks and a shared rug. */}
      <rect
        x="45"
        y="280"
        width="493"
        height="230"
        rx="25"
        fill="#49675b"
        stroke="#b49a72"
        strokeWidth="4"
      />
      <rect
        x="55"
        y="290"
        width="473"
        height="210"
        rx="19"
        fill="url(#team-rug)"
        stroke="#7d9580"
      />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Desk
          key={i}
          x={123 + (i % 3) * 166}
          y={305 + Math.floor(i / 3) * 133}
          active={working[i] ?? false}
        />
      ))}
      {/* Upholstered lounge and coffee table. */}
      <ellipse
        cx="783"
        cy="279"
        rx="170"
        ry="20"
        fill="#2a362c"
        opacity=".25"
      />
      <rect
        x="627"
        y="183"
        width="302"
        height="75"
        rx="20"
        fill="#b16f51"
        stroke="#784e3c"
        strokeWidth="5"
      />
      <rect x="640" y="203" width="86" height="49" rx="10" fill="#cf936b" />
      <rect x="731" y="203" width="86" height="49" rx="10" fill="#c58a62" />
      <rect x="822" y="203" width="91" height="49" rx="10" fill="#cf936b" />
      <path
        d="M629 226v34h298v-34"
        fill="none"
        stroke="#ab7251"
        strokeWidth="16"
        strokeLinejoin="round"
      />
      <path d="M646 269v10m262-10v10" stroke="#3a3e31" strokeWidth="6" />
      <path
        d="m663 193 25 7-8 30-26-7Zm210 10 25-9 10 26-25 9Z"
        fill="#dcc591"
      />
      <ellipse cx="780" cy="313" rx="83" ry="24" fill="#4b4635" opacity=".3" />
      <path d="M716 295v20m130-20v20" stroke="#49483a" strokeWidth="6" />
      <ellipse cx="780" cy="292" rx="77" ry="23" fill="#d4b387" />
      <path d="m774 281 26 4-10 11-26-4Z" fill="#56796d" />
      <ellipse cx="747" cy="285" rx="9" ry="5" fill="#f1dab5" />
      <rect x="738" y="274" width="18" height="11" rx="4" fill="#f1dab5" />
      {/* Shared standing table for evidence handoffs in the central aisle. */}
      <g transform="translate(580 367)">
        <ellipse cy="18" rx="32" ry="8" fill="#22382e" opacity=".3" />
        <path d="M0-12v29m-16 0h32" stroke="#454b38" strokeWidth="5" />
        <ellipse cy="-12" rx="30" ry="10" fill="#cbb387" />
        <path d="m-9-18 18 3-3 9-18-3Z" fill="#829b81" />
      </g>
      {/* Spare ottomans provide distinct lounge seats for the second desk row. */}
      {[645, 755, 865].map((x) => (
        <g key={x} transform={`translate(${x} 322)`}>
          <ellipse cy="15" rx="36" ry="10" fill="#24352d" opacity=".3" />
          <rect x="-31" y="-8" width="62" height="26" rx="10" fill="#a97658" />
          <ellipse cy="-6" rx="31" ry="11" fill="#c29169" />
        </g>
      ))}
      {/* Game corner: a real decorative Pong loop, never task progress. */}
      <rect
        x="608"
        y="364"
        width="350"
        height="162"
        rx="22"
        fill="#635d77"
        stroke="#9a8b97"
        strokeWidth="3"
      />
      <rect
        x="619"
        y="375"
        width="328"
        height="140"
        rx="15"
        fill="url(#team-rug)"
      />
      <path d="M795 453v44m134-44v44" stroke="#423d34" strokeWidth="7" />
      <rect x="779" y="434" width="166" height="24" rx="4" fill="#b1926f" />
      <rect x="797" y="446" width="129" height="5" rx="2" fill="#544d42" />
      <path d="M864 422v12m-22 0h44" stroke="#293c36" strokeWidth="6" />
      <rect
        x="784"
        y="342"
        width="158"
        height="83"
        rx="7"
        fill="#26342f"
        stroke="#b6b399"
        strokeWidth="5"
      />
      <path d="M863 352v64" stroke="#496259" strokeDasharray="4 4" />
      <g fill="#bddeb6">
        <rect
          className="scene-paddle"
          x="798"
          y="369"
          width="5"
          height="23"
          rx="2"
        />
        <rect
          className="scene-paddle scene-paddle-two"
          x="923"
          y="381"
          width="5"
          height="23"
          rx="2"
        />
        <circle className="scene-ball" cx="817" cy="375" r="4" />
      </g>
      <path
        d="M647 478q-29-12-21-39 5-27 32-25 30-1 37 28 6 32-48 36Z"
        fill="#c6a165"
      />
      <path
        d="M637 462q16 8 43-4"
        fill="none"
        stroke="#ac894f"
        strokeWidth="3"
      />
      <path d="m712 466-9 8-2 12 8 3 9-8h11l9 8 8-3-2-12-9-8Z" fill="#d9c8ac" />
      <path d="M710 477h9m-4-4v8" stroke="#4d584b" strokeWidth="2" />
      <circle cx="735" cy="476" r="2" fill="#8b665f" />
      <Plant x={35} y={273} scale={0.8} />
      <Plant x={963} y={289} scale={1.05} />
      <Plant x={568} y={482} scale={0.8} />
      <g fontFamily="monospace" fontSize="10" letterSpacing="2" fill="#f0e1c7">
        <text x="68" y="539">
          01 / WORKSTATIONS
        </text>
        <text x="666" y="335">
          02 / THE LOUNGE
        </text>
        <text x="646" y="546">
          03 / GAME CORNER
        </text>
      </g>
    </svg>
  );
}

type Point = { x: number; y: number };
/** The central aisle and the aisle between desk rows keep travel off tabletops. */
function route(from: Point, to: Point): Point[] {
  const aisle = (p: Point) => (p.x < 53 ? (p.y < 55 ? 51 : 78) : 52);
  if (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) < 1) return [to];
  return [
    from,
    { x: from.x, y: aisle(from) },
    { x: 54, y: aisle(from) },
    { x: 54, y: aisle(to) },
    { x: to.x, y: aisle(to) },
    to,
  ].filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
}
function ScenePersona({
  persona,
  label,
  index,
  motion,
  selected,
  onSelect,
  event,
}: {
  persona: OfficePersona;
  label: string;
  index: number;
  motion: boolean;
  selected: boolean;
  onSelect: () => void;
  event?: { text: string; at: string; runId?: string; handoff?: boolean; handoffAt?:string };
}) {
  const seed = index * 3; // Stable seat timing makes rehearsal captures repeatable.
  const [idle, setIdle] = useState(seed % 2);
  const [walking, setWalking] = useState(false);
  const [meeting, setMeeting] = useState(false);
  useEffect(() => {
    const remaining = Date.parse(event?.handoffAt ?? "") + 5000 - Date.now();
    setMeeting(remaining > 0);
    if (remaining > 0) {
      const timer = setTimeout(() => setMeeting(false), remaining);
      return () => clearTimeout(timer);
    }
  }, [event?.handoffAt]);
  const [facing, setFacing] = useState("right");
  const element = useRef<HTMLDivElement>(null);
  const last = useRef<Point | undefined>(undefined);
  const atDesk = label === "Working";
  const attention = label === "Needs approval" || label === "Needs attention";
  const gaming = !meeting && !atDesk && !attention && idle % 2 === 1;
  const x = meeting
    ? 52 + (index % 3) * 10
    : atDesk || attention
      ? 7.8 + (index % 3) * 16.6
      : 60 + (index % 3) * 11;
  const y = meeting
    ? 49 + Math.floor(index / 3) * 13
    : atDesk || attention
      ? 39.5 + Math.floor(index / 3) * 23.8
      : gaming
        ? 66 + Math.floor(index / 3) * 13
        : 29 + Math.floor(index / 3) * 13;
  useEffect(() => {
    if (!motion || atDesk || attention) return;
    const timer = setInterval(
      () => setIdle((i) => i + 1),
      12000 + (seed % 8) * 1700,
    );
    return () => clearInterval(timer);
  }, [motion, atDesk, attention, seed]);
  useLayoutEffect(() => {
    const el = element.current;
    if (!el) return;
    const to = { x, y };
    if (!motion || !last.current) {
      last.current = to;
      setWalking(false);
      return;
    }
    // Sample the current position so a new task can interrupt an ongoing walk.
    const from = last.current;
    const points = route(from, to);
    last.current = to;
    if (points.length < 2) {
      setWalking(false);
      return;
    }
    const distances = points.map((p, i) =>
      i === 0
        ? 0
        : Math.hypot(p.x - points[i - 1].x, (p.y - points[i - 1].y) * 0.56),
    );
    const total = distances.reduce((a, b) => a + b, 0);
    const duration = Math.min(6500, Math.max(700, total * 55));
    let distance = 0;
    const offsets = distances.map((d) => (distance += d) / total);
    const animation = el.animate(
      points.map((p, i) => ({
        transform: `translate(${p.x}%, ${p.y}%)`,
        offset: offsets[i],
      })),
      { duration, easing: "linear" },
    );
    setWalking(true);
    const timers = points
      .slice(1)
      .map((p, i) =>
        setTimeout(
          () =>
            setFacing(
              p.x < points[i].x
                ? "left"
                : p.x > points[i].x
                  ? "right"
                  : p.y < points[i].y
                    ? "back"
                    : "front",
            ),
          offsets[i] * duration,
        ),
      );
    animation.onfinish = () => setWalking(false);
    return () => {
      if (
        animation.playState === "running" &&
        el.clientWidth &&
        el.clientHeight
      ) {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        last.current = {
          x: (m.m41 / el.clientWidth) * 100,
          y: (m.m42 / el.clientHeight) * 100,
        };
      }
      animation.cancel();
      timers.forEach(clearTimeout);
    };
  }, [x, y, motion]);
  // Task messages are backed by a real record and remain inspectable on selection.
  const showEvent =
    event && (selected || Date.now() - Date.parse(event.at) < 12000);
  return (
    <div
      ref={element}
      className={`scene-persona-position ${walking ? "is-walking" : "is-sitting"} ${atDesk ? "is-working" : ""} ${gaming ? "is-gaming" : ""}`}
      data-facing={facing}
      data-seat={`${meeting ? "meeting" : atDesk || attention ? "desk" : gaming ? "game" : "lounge"}-${index}`}
      style={
        {
          transform: `translate(${x}%, ${y}%)`,
          zIndex: Math.round(y * 10),
        } as CSSProperties
      }
    >
      <button
        className="scene-persona"
        aria-label={`${persona.name}, ${label}`}
        aria-pressed={selected}
        onClick={onSelect}
        title={`${persona.name} · ${label}`}
      >
        <span className={`scene-persona-label ${attention ? "attention" : ""}`}>
          <strong>{persona.name}</strong>
          <small>{label}</small>
        </span>
        <span className="scene-facing">
          <PersonaAvatar avatar={persona.avatar} color={persona.color} />
        </span>
        {gaming && !walking && (
          <svg
            className="scene-controller"
            viewBox="0 0 36 20"
            aria-hidden="true"
          >
            <path
              d="M8 2h20l7 13-6 4-8-6h-6l-8 6-6-4Z"
              fill="#e9d7b7"
              stroke="#514b40"
              strokeWidth="2"
            />
            <path d="M7 8h8m-4-4v8" stroke="#514b40" strokeWidth="2" />
            <circle cx="26" cy="7" r="2" fill="#b87d63" />
          </svg>
        )}
      </button>
      {showEvent && (
        <a
          className="scene-event"
          href={
            event.runId
              ? `#/runs/${event.runId}`
              : `#/office?persona=${encodeURIComponent(persona.id)}`
          }
          title={new Date(event.at).toLocaleString()}
        >
          {event.handoff ? "↗ " : ""}
          {event.text}
          <small>
            {new Date(event.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            · Open evidence
          </small>
        </a>
      )}
    </div>
  );
}
function FurnitureFront() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          className="scene-furniture-front"
          style={{ zIndex: Math.floor(i / 3) === 0 ? 555 : 795 }}
          viewBox="0 0 1000 560"
          aria-hidden="true"
        >
          <g
            transform={`translate(${123 + (i % 3) * 166} ${305 + Math.floor(i / 3) * 133})`}
          >
            <path d="M-63-12h122l10 19H-72Z" fill="#c8a27a" />
            <path d="M-72 7H69v8H-72Z" fill="#98714f" />
            <path d="M-26 0H8l5 6h-44Z" fill="#4b5850" />
            <path d="M-52 15v19m102-19v19" stroke="#3d3931" strokeWidth="7" />
          </g>
        </svg>
      ))}
      <svg
        className="scene-furniture-front"
        style={{ zIndex: 400 }}
        viewBox="0 0 1000 560"
        aria-hidden="true"
      >
        <path
          d="M629 239v21h298v-21"
          fill="none"
          stroke="#ab7251"
          strokeWidth="16"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

export function OfficeScene({
  personas,
  statuses,
  events,
  selectedId,
  onSelect,
}: SceneProps) {
  const [paused, setPaused] = useState(
    () => localStorage.getItem("team-motion") === "paused",
  );
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [floor, setFloor] = useState(0);
  const selectedIndex = personas.findIndex((p) => p.id === selectedId);
  useEffect(() => {
    if (selectedIndex >= 0) setFloor(Math.floor(selectedIndex / 6));
  }, [selectedIndex]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    update();
    visibility();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const motion = !paused && !reduced && !hidden;
  const currentFloor = Math.min(
    floor,
    Math.max(0, Math.ceil(personas.length / 6) - 1),
  );
  const visible = personas.slice(currentFloor * 6, currentFloor * 6 + 6);
  return (
    <div className="team-office" data-motion={motion ? "on" : "off"}>
      <div className="scene-toolbar">
        <span>
          <i /> TEAM OFFICE <small>Live assignments, a little downtime</small>
        </span>
        <button
          aria-pressed={paused}
          disabled={reduced}
          onClick={() =>
            setPaused((p) => {
              localStorage.setItem("team-motion", p ? "running" : "paused");
              return !p;
            })
          }
        >
          {reduced
            ? "Reduced motion"
            : paused
              ? "Resume motion"
              : "Pause motion"}
        </button>
      </div>
      <div className="scene-controls">
        <label>
          Find a teammate
          <input
            aria-label="Find a teammate"
            placeholder="Search names…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div>
          <button
            aria-label="Zoom out office"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom in office"
            disabled={zoom >= 1.75}
            onClick={() => setZoom((z) => Math.min(1.75, z + 0.25))}
          >
            +
          </button>
          <button onClick={() => setZoom(1)}>Fit</button>
        </div>
      </div>
      {query && (
        <div className="scene-search-results">
          {personas
            .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
            .map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  onSelect(p.id);
                  setQuery("");
                }}
              >
                <PersonaAvatar avatar={p.avatar} color={p.color} />
                {p.name} · {statuses[p.id]}
              </button>
            ))}
        </div>
      )}
      <div className="scene-viewport">
        <div className="office-stage" style={{ width: `${zoom * 100}%` }}>
          <OfficeInterior
            working={visible.map((p) => statuses[p.id] === "Working")}
          />
          {visible.map((p, i) => (
            <ScenePersona
              key={p.id}
              persona={p}
              label={statuses[p.id] ?? "Ready"}
              index={i}
              event={events?.[p.id]}
              motion={motion}
              selected={p.id === selectedId}
              onSelect={() => onSelect(p.id)}
            />
          ))}
          <FurnitureFront />
        </div>
      </div>
      {personas.length > 6 && (
        <div className="scene-floors" aria-label="Office floors">
          {Array.from({ length: Math.ceil(personas.length / 6) }, (_, i) => (
            <button
              key={i}
              aria-pressed={currentFloor === i}
              onClick={() => setFloor(i)}
            >
              Floor {i + 1}
              {personas
                .slice(i * 6, i * 6 + 6)
                .some((p) => statuses[p.id]?.startsWith("Needs"))
                ? " · Needs attention"
                : ""}
            </button>
          ))}
        </div>
      )}
      {personas.length > 0 && (
        <div className="scene-roster" aria-label="Office team">
          {visible.map((p) => (
            <button
              key={p.id}
              className="office-station scene-roster-persona"
              aria-pressed={selectedId === p.id}
              aria-label={`Select ${p.name}`}
              onClick={() => onSelect(p.id)}
            >
              <PersonaAvatar avatar={p.avatar} color={p.color} />
              <span>
                <strong>{p.name}</strong>
                <small>{statuses[p.id]}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
