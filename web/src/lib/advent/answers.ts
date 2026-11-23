import { createHmac } from "node:crypto";

const QUOTES = new Map([['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"]]);

export function normalizeAnswer(answer: string) {
  let value = answer.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  let removePeriod = true;
  for (;;) {
    if (removePeriod && value.endsWith(".")) {
      value = value.slice(0, -1).trimEnd();
      removePeriod = false;
      continue;
    }
    if (value.length >= 2 && QUOTES.get(value[0]!) === value.at(-1)) {
      value = value.slice(1, -1).trim();
      continue;
    }
    return value;
  }
}

export function hashAnswer(day: number, answer: string, pepper: string) {
  return createHmac("sha256", pepper).update(`${day}:${normalizeAnswer(answer)}`).digest("hex");
}
