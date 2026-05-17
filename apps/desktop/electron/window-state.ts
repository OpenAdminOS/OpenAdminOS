import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { app, BrowserWindow, screen, type Rectangle } from "electron";

/**
 * Minimal window-state persistence: remembers the last position + size
 * across launches and clamps the result back inside a visible display
 * on restore (so external monitors that aren't currently attached
 * don't leave the window unreachable).
 *
 * Lives in `userData/window-state.json` so it's per-profile, separate
 * from the runtime's `state.json`. Failures (missing file, malformed
 * JSON, off-screen rectangle) silently fall through to defaults — a
 * lost window position is not worth a startup error.
 */

interface PersistedWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  fullscreen: boolean;
  maximized: boolean;
}

const DEFAULT_STATE: PersistedWindowState = {
  width: 1280,
  height: 820,
  fullscreen: false,
  maximized: false,
};

const SAVE_DEBOUNCE_MS = 400;

function statePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

export async function loadWindowState(): Promise<PersistedWindowState> {
  const file = statePath();
  if (!existsSync(file)) return DEFAULT_STATE;
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;
    const merged: PersistedWindowState = {
      width: positiveOr(parsed.width, DEFAULT_STATE.width),
      height: positiveOr(parsed.height, DEFAULT_STATE.height),
      fullscreen: parsed.fullscreen === true,
      maximized: parsed.maximized === true,
    };
    if (typeof parsed.x === "number" && Number.isFinite(parsed.x)) {
      merged.x = parsed.x;
    }
    if (typeof parsed.y === "number" && Number.isFinite(parsed.y)) {
      merged.y = parsed.y;
    }
    return clampToVisibleDisplay(merged);
  } catch {
    return DEFAULT_STATE;
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function clampToVisibleDisplay(
  state: PersistedWindowState,
): PersistedWindowState {
  if (typeof state.x !== "number" || typeof state.y !== "number") return state;
  const bounds: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  // If no display contains any meaningful overlap with the saved bounds,
  // drop the position and let Electron center the window on the primary.
  const displays = screen.getAllDisplays();
  const stillVisible = displays.some((display) =>
    rectsOverlap(display.workArea, bounds, 64),
  );
  if (stillVisible) return state;
  const next: PersistedWindowState = {
    width: state.width,
    height: state.height,
    fullscreen: state.fullscreen,
    maximized: state.maximized,
  };
  return next;
}

function rectsOverlap(a: Rectangle, b: Rectangle, slack: number): boolean {
  return (
    a.x < b.x + b.width - slack &&
    b.x < a.x + a.width - slack &&
    a.y < b.y + b.height - slack &&
    b.y < a.y + a.height - slack
  );
}

export function attachWindowStatePersistence(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = async () => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const next: PersistedWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      fullscreen: window.isFullScreen(),
      maximized: window.isMaximized(),
    };
    const file = statePath();
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2), "utf8");
    } catch (error) {
      console.error("[window-state] failed to persist", error);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void save();
    }, SAVE_DEBOUNCE_MS);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    void save();
  });
}
