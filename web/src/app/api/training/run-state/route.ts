import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "~/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Storage lives in the shared UgurLabs Supabase project, in oaos_-prefixed
// tables (public.oaos_training_run_state holds the single current row,
// public.oaos_training_run_events keeps the append-only transition log).
// Reads and writes go through PostgREST with the secret key; anonymous
// read access exists at the database level because the run state is
// public by design, but the page always reads through this route.
const STATE_TABLE = "oaos_training_run_state";
const EVENTS_TABLE = "oaos_training_run_events";

const runStateInputSchema = z
  .object({
    run: z.string().trim().min(1).max(64),
    stage: z.enum([
      "generate",
      "validate",
      "train",
      "quantize",
      "evaluate",
      "review",
      "release",
    ]),
    detail: z.string().trim().max(240).optional(),
    outcome: z.enum(["shipped", "held", "failed"]).optional(),
  })
  .strict();

const storedRowSchema = z.object({
  run: z.string(),
  stage: runStateInputSchema.shape.stage,
  detail: z.string().nullable(),
  outcome: z.enum(["shipped", "held", "failed"]).nullable(),
  updated_at: z.string(),
});

function supabase() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return null;
  return { url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY };
}

async function supabaseFetch(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  const config = supabase();
  if (!config) throw new Error("unconfigured");
  return fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
  });
}

export async function GET() {
  if (!supabase()) return idleResponse();

  try {
    const response = await supabaseFetch(
      `${STATE_TABLE}?id=eq.1&select=run,stage,detail,outcome,updated_at`,
    );
    if (!response.ok) return idleResponse();

    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) return idleResponse();

    const parsed = storedRowSchema.safeParse(rows[0]);
    if (!parsed.success) return idleResponse();

    const { updated_at, detail, outcome, ...rest } = parsed.data;
    return NextResponse.json(
      {
        ...rest,
        ...(detail === null ? {} : { detail }),
        ...(outcome === null ? {} : { outcome }),
        updatedAt: new Date(updated_at).toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return idleResponse();
  }
}

export async function POST(request: Request) {
  if (!env.TRAINING_STATE_TOKEN) {
    return jsonError(503, "Training state is not configured.");
  }
  if (
    request.headers.get("authorization") !== `Bearer ${env.TRAINING_STATE_TOKEN}`
  ) {
    return jsonError(401, "Unauthorized.");
  }
  if (!supabase()) {
    return jsonError(503, "Training state storage is not configured.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  const parsed = runStateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid training state.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const updatedAt = new Date().toISOString();
  const row = {
    run: parsed.data.run,
    stage: parsed.data.stage,
    detail: parsed.data.detail ?? null,
    outcome: parsed.data.outcome ?? null,
  };
  try {
    const upsert = await supabaseFetch(`${STATE_TABLE}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: 1, ...row, updated_at: updatedAt }),
    });
    if (!upsert.ok) {
      return jsonError(503, "Training state storage is unavailable.");
    }
    // The event log is best-effort; the current state is what the page reads.
    await supabaseFetch(EVENTS_TABLE, {
      method: "POST",
      body: JSON.stringify(row),
    }).catch(() => undefined);

    return NextResponse.json(
      { ...parsed.data, updatedAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError(503, "Training state storage is unavailable.");
  }
}

function idleResponse() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}
