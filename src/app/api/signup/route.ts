import { NextResponse } from "next/server";
import { z } from "zod";
import { supabase } from "~/lib/supabase";

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 },
    );
  }

  const { email } = parsed.data;
  const userAgent = req.headers.get("user-agent");
  const referrer = req.headers.get("referer");

  const { error } = await supabase
    .from("waitlist")
    .insert({ email, user_agent: userAgent, referrer });

  if (error && error.code !== "23505") {
    console.error("waitlist insert failed", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
