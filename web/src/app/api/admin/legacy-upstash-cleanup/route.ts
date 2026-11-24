import { NextResponse } from "next/server";

import { cronAuthError } from "~/lib/stats/responses";

// Temporary migration route. Remove it after the legacy keys are deleted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SCAN_BUDGET_MS = 20_000;
const SCAN_COUNT = 500;
const GROUP_PREFIXES = [
  "oa:pending:installs:",
  "oa:dedup:support-issue:",
  "oa:dedup:",
  "oa:installs7d:",
  "oa:installs:day:",
  "oa:rate:",
];

export async function POST(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return NextResponse.json(
      { ok: false, error: "Legacy stats storage is not configured." },
      { status: 503 },
    );
  }

  const params = new URL(request.url).searchParams;
  const apply = params.get("apply") === "1";
  let cursor = params.get("cursor") ?? "0";
  if (!isCursor(cursor)) {
    return NextResponse.json({ ok: false, error: "Invalid scan cursor." }, { status: 400 });
  }

  const budget = AbortSignal.timeout(SCAN_BUDGET_MS);
  const command = (args: string[]) => runCommand(url, token, budget, args);
  const scanned: Record<string, number> = Object.create(null);
  const deleted: Record<string, number> = Object.create(null);
  const seen = new Set<string>();
  let complete = false;
  let status = 200;
  try {
    while (!budget.aborted) {
      const page = await command(["SCAN", cursor, "MATCH", "*", "COUNT", String(SCAN_COUNT)]);
      const [next, keys] = parseScan(page);
      const targets = new Map<string, string[]>();

      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const group = groupKey(key);
        scanned[group] = (scanned[group] ?? 0) + 1;
        if (apply && key.startsWith("oa:")) {
          const grouped = targets.get(group) ?? [];
          grouped.push(key);
          targets.set(group, grouped);
        }
      }

      for (const [group, grouped] of targets) {
        // COUNT is a hint. Keep each deletion bounded even if SCAN returns more keys.
        for (let i = 0; i < grouped.length; i += SCAN_COUNT) {
          const batch = grouped.slice(i, i + SCAN_COUNT);
          const result = await command(["DEL", ...batch]);
          if (typeof result !== "number" || !Number.isInteger(result) || result < 0 || result > batch.length) {
            throw new Error("Invalid delete response.");
          }
          deleted[group] = (deleted[group] ?? 0) + result;
        }
      }

      cursor = next;
      if (cursor === "0") {
        complete = true;
        break;
      }
    }
  } catch {
    if (!budget.aborted) status = 502;
  }

  return NextResponse.json(
    {
      ok: status === 200,
      dryRun: !apply,
      complete,
      nextCursor: complete ? null : cursor,
      scanned,
      deleted,
      ...(status === 502 ? { error: "Legacy storage request failed. Retry with the returned cursor." } : {}),
    },
    { status },
  );
}

async function runCommand(url: string, token: string, signal: AbortSignal, args: string[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("Legacy storage request failed.");
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error || !("result" in payload)) throw new Error("Legacy storage command failed.");
  return payload.result;
}

function isCursor(value: string): boolean {
  return /^(0|[1-9]\d{0,19})$/.test(value);
}

function parseScan(value: unknown): [string, string[]] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid scan response.");
  const [next, keys] = value;
  const cursor = typeof next === "string" || Number.isSafeInteger(next) ? String(next) : "";
  if (!isCursor(cursor) || !Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("Invalid scan response.");
  }
  return [cursor, keys];
}

function groupKey(key: string): string {
  if (key === "oa:slugs") return key;
  const prefix = GROUP_PREFIXES.find((prefix) => key.startsWith(prefix));
  if (prefix) return `${prefix}*`;
  const separator = key.indexOf(":");
  return separator > 0 ? `other:${key.slice(0, separator)}` : "other:(unprefixed)";
}
