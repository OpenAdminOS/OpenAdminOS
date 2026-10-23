import type { CSSProperties } from "react";

/** Files in public/app, copied from docs/screenshots/app/brand-*.png. */
export type AppScreen =
  | "agent-drawer"
  | "agent-team"
  | "chat-transcript"
  | "settings";

/** Captured at 1920 x 1012 from the desktop screenshot harness. */
export const SHOT_WIDTH = 1920;
export const SHOT_HEIGHT = 1012;

/**
 * A real screenshot of the desktop app that follows the visitor's light or
 * dark preference. Only the matching file is downloaded.
 */
export function AppShot({
  screen,
  alt,
  className,
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
    <picture>
      <source
        media="(prefers-color-scheme: dark)"
        srcSet={`/app/${screen}-dark.webp`}
      />
      <img
        src={`/app/${screen}-light.webp`}
        width={SHOT_WIDTH}
        height={SHOT_HEIGHT}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        className={className}
        style={style}
      />
    </picture>
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
