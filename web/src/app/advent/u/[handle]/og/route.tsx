import { ImageResponse } from "next/og";

import { adventEnabled, storageConfig } from "~/lib/advent/config";
import { publicProfile } from "~/lib/advent/db";
import { earnsBadge } from "~/lib/advent/eligibility";
import { validHandle } from "~/lib/advent/identity";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ handle: string }> }) {
  if (!adventEnabled() || !storageConfig()) return new Response(null, { status: 404, headers });
  const { handle } = await params;
  if (!validHandle(handle)) return new Response(null, { status: 404, headers });
  try {
    const profile = await publicProfile(handle);
    if (!profile) return new Response(null, { status: 404, headers });
    return new ImageResponse(
      <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 80, background: "#faf9f6", color: "#1f1d1a", border: "24px solid #f2f0eb" }}>
        <div style={{ fontSize: 30, color: "#5c5852" }}>OpenAdminOS · Advent of Admin · December 2026</div>
        <div style={{ fontSize: 64, marginTop: 38, overflowWrap: "anywhere" }}>{profile.handle}</div>
        <div style={{ fontSize: 32, color: "#5c5852", marginTop: 30 }}>{profile.count} of 24 doors completed</div>
        {earnsBadge(profile.count) && <div style={{ fontSize: 27, color: "#3a7246", marginTop: 24 }}>Advent of Admin badge earned</div>}
      </div>,
      { width: 1200, height: 630, headers },
    );
  } catch {
    return new Response("Badge image is temporarily unavailable.", { status: 503, headers });
  }
}
