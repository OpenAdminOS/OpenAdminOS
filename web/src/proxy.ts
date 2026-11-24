import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { PLAUSIBLE_EVENT_URL, PLAUSIBLE_SCRIPT_URL } from "./lib/site-analytics";

// Next's built-in HTTP error page renders this fixed stylesheet without a nonce.
// Re-verify the hash on every Next.js upgrade.
const NEXT_ERROR_STYLE_HASH = "'sha256-Z5XTK23DFuEMs0PwnyZDO9SWxemQ5HxcpVaBNuUJyWY='";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  const analytics =
    host !== "docs.openadminos.com" && !/^\/docs(?:-host)?(?:\/|$)/.test(pathname);
  const development = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'${analytics ? ` ${PLAUSIBLE_SCRIPT_URL}` : ""}${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}' ${NEXT_ERROR_STYLE_HASH}`,
    // The home and benchmark pages set chart dimensions and graphic styles on elements.
    "style-src-attr 'unsafe-inline'",
    ...(development ? ["style-src-elem 'self' 'unsafe-inline'"] : []),
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self'",
    `connect-src 'self'${analytics ? ` ${PLAUSIBLE_EVENT_URL}` : ""}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  // Next reads the request policy to nonce its own scripts.
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-site-analytics", analytics ? "on" : "off");
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Page and router requests need a nonce. API routes and file assets use
  // the static policy from next.config.js.
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|_vercel(?:/|$)|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|css|js|map|txt|xml|json|woff2?|ttf|md|webmanifest|pdf|mp4)$).*)",
  ],
};
