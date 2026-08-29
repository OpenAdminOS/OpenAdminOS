import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "~/env";
import { getRedis, keys } from "~/lib/stats/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const storedRunStateSchema = runStateInputSchema.extend({
  updatedAt: z.string().datetime(),
});

export async function GET() {
  if (
    !env.TRAINING_STATE_TOKEN ||
    !env.UPSTASH_REDIS_REST_URL ||
    !env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return idleResponse();
  }

  try {
    const stored = await getRedis().get<unknown>(keys.trainingRunState());
    if (stored === null || stored === undefined) return idleResponse();

    const parsed = storedRunStateSchema.safeParse(stored);
    if (!parsed.success) return idleResponse();
    return NextResponse.json(parsed.data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return idleResponse();
  }
}

export async function POST(request: Request) {
  if (!env.TRAINING_STATE_TOKEN) {
    return jsonError(503, "Training state is not configured.");
  }
  if (request.headers.get("authorization") !== `Bearer ${env.TRAINING_STATE_TOKEN}`) {
    return jsonError(401, "Unauthorized.");
  }
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
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

  const state = {
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  };
  try {
    await getRedis().set(keys.trainingRunState(), state);
    return NextResponse.json(state, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
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
