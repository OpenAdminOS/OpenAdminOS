import { type NextRequest, NextResponse } from "next/server";

import { adventEnabled } from "./lib/advent/config";

export function proxy(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  // The POST-only cron route authenticates before counting a disabled campaign's dry run.
  const reminderCron = request.method === "POST" && request.nextUrl.pathname === "/api/advent/reminders";
  if (!adventEnabled() && !reminderCron) return new NextResponse("Not found", { status: 404, headers });
  return NextResponse.next({ headers });
}

export const config = { matcher: ["/advent/:path*", "/api/advent/:path*"] };
