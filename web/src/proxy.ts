import { NextResponse } from "next/server";

import { adventEnabled } from "./lib/advent/config";

export function proxy() {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (!adventEnabled()) return new NextResponse("Not found", { status: 404, headers });
  return NextResponse.next({ headers });
}

export const config = { matcher: ["/advent/:path*", "/api/advent/:path*"] };
