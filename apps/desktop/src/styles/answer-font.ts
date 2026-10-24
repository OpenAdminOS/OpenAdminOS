import { useSyncExternalStore } from "react";

export type AnswerFont = "serif" | "sans";

export const DEFAULT_ANSWER_FONT: AnswerFont = "serif";
export const ANSWER_FONT_STORAGE_KEY = "openadminos:answer-font:v1";

const changed = "openadminos:answer-font-changed";
let current: AnswerFont = DEFAULT_ANSWER_FONT;
let initialized = false;

function normalizeAnswerFont(value: unknown): AnswerFont {
  return value === "sans" ? "sans" : DEFAULT_ANSWER_FONT;
}

export function readAnswerFont(): AnswerFont {
  try {
    return normalizeAnswerFont(localStorage.getItem(ANSWER_FONT_STORAGE_KEY));
  } catch {
    return DEFAULT_ANSWER_FONT;
  }
}

function applyAnswerFont(value: AnswerFont) {
  current = value;
  document.documentElement.dataset.answerFont = value;
}

export function initializeAnswerFont() {
  applyAnswerFont(readAnswerFont());
  if (initialized) return;
  initialized = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== ANSWER_FONT_STORAGE_KEY && event.key !== null) return;
    applyAnswerFont(readAnswerFont());
    window.dispatchEvent(new Event(changed));
  });
}

export function setAnswerFont(value: AnswerFont) {
  try {
    localStorage.setItem(ANSWER_FONT_STORAGE_KEY, value);
  } catch {
    // The preference still applies to this renderer when storage is unavailable.
  }
  applyAnswerFont(value);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}

export function useAnswerFont() {
  const answerFont = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_ANSWER_FONT,
  );
  return { answerFont, setAnswerFont };
}
