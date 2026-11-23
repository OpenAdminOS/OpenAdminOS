import { parseReferral } from "~/lib/advent/identity";
import { AccountEntry } from "../AccountEntry";

export const metadata = { title: "Sign up | Advent of Admin", robots: { index: false, follow: false } };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ ref?: string | string[] }> }) {
  const { ref } = await searchParams;
  return <AccountEntry signup referral={typeof ref === "string" ? parseReferral(ref) : ""} />;
}
