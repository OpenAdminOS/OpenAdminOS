import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

export function statsUnavailable(configured: boolean) {
  const error = configured
    ? "Stats storage is unavailable. Try again later."
    : "Stats storage is not configured in this environment.";
  return NextResponse.json({ ok: false, error }, { status: 503 });
}

export function cronAuthError(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(request.headers.get("authorization") ?? ""), hash(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}
