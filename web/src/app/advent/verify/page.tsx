import Link from "next/link";

import { sessionSecret, storageConfig } from "~/lib/advent/config";
import { VerifyLink } from "./VerifyLink";
import { AdventTitle, Notice, NOT_CONFIGURED, textLink } from "../shared";

export const metadata = { title: "Continue signing in | Advent of Admin", robots: { index: false, follow: false } };

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <AdventTitle label="Advent of Admin" title="Review your link" description="Check the details below before continuing." />
      {!storageConfig() || !sessionSecret() ? <Notice>{NOT_CONFIGURED}</Notice> : <VerifyLink />}
      <Link href="/advent/sign-in" className={textLink}>Request a new sign-in link</Link>
    </div>
  );
}
