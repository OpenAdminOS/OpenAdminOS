import { detectAll } from "tinyld";
import { withoutAdminTerms } from "./kokoro-english.js";

export function speechLanguage(answer: string, whisperHint?: string): string {
  const hint = whisperHint?.match(/^[a-z]{2,3}$/)?.[0];
  const text = withoutAdminTerms(answer);
  const [detected, runnerUp] = detectAll(text);
  if (detected && (detected.accuracy >= 0.35 ||
      (detected.accuracy >= 0.1 && detected.accuracy >= 3 * (runnerUp?.accuracy ?? 0)))) {
    return detected.lang;
  }
  return hint || "en";
}
