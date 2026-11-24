export function clientIp(request: Request, vercel = process.env.VERCEL) {
  if (vercel !== "1") return "unknown";
  return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
