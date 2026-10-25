import type { CSSProperties } from "react";

/**
 * Files in public/app, from the landing capture: `npm run screenshots:landing`
 * at the repo root writes docs/screenshots/landing and converts it here.
 */
export type AppScreen =
  | "agent-team"
  | "chat-transcript"
  | "hub-grid"
  | "settings"
  | "write-confirmation";

/** The app laid out at 1280 x 800 and captured at 2x. */
export const SHOT_WIDTH = 2560;
export const SHOT_HEIGHT = 1600;

/**
 * A real screenshot of the desktop app in the active theme. Both files are
 * rendered; CSS shows the one that matches (see .theme-img-* in
 * globals.css). Both are lazy, so the hidden one is never fetched.
 *
 * `priority` is for the above-the-fold capture: an inline script reads the
 * theme the head script already resolved and preloads only that file at high
 * priority, so the other theme never competes for bandwidth.
 */
export function AppShot({
  screen,
  alt,
  className = "",
  style,
  priority = false,
}: {
  screen: AppScreen;
  alt: string;
  className?: string;
  style?: CSSProperties;
  priority?: boolean;
}) {
  return (
    <>
      {priority ? (
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=document.documentElement.dataset.theme==="dark"?"dark":"light";var l=document.createElement("link");l.rel="preload";l.as="image";l.href="/app/${screen}-"+t+".webp";l.setAttribute("fetchpriority","high");document.head.appendChild(l)})();`,
          }}
        />
      ) : null}
      {(["light", "dark"] as const).map((theme) => (
        <img
          key={theme}
          src={`/app/${screen}-${theme}.webp`}
          width={SHOT_WIDTH}
          height={SHOT_HEIGHT}
          alt={alt}
          loading="lazy"
          decoding="async"
          fetchPriority={priority ? "high" : undefined}
          className={`theme-img-${theme} ${className}`}
          style={style}
        />
      ))}
    </>
  );
}

/**
 * Shows one region of a screenshot, scaled up. `x`, `y`, and `width` are in
 * screenshot pixels; the frame's aspect ratio decides the visible height.
 */
export function AppCrop({
  screen,
  alt,
  x,
  y,
  width,
  aspect,
  className = "",
}: {
  screen: AppScreen;
  alt: string;
  x: number;
  y: number;
  width: number;
  aspect: string;
  className?: string;
}) {
  const zoom = SHOT_WIDTH / width;
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: aspect }}
    >
      <AppShot
        screen={screen}
        alt={alt}
        className="absolute left-0 top-0 h-auto max-w-none origin-top-left select-none"
        style={{
          width: `${zoom * 100}%`,
          transform: `translate(${(-x / SHOT_WIDTH) * 100}%, ${(-y / SHOT_HEIGHT) * 100}%)`,
        }}
      />
    </div>
  );
}
