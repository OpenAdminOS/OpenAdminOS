import Link from "next/link";

import { sessionSecret, storageConfig } from "~/lib/advent/config";
import { VerifyLink } from "../ActionForm";
import { AdventTitle, Notice, NOT_CONFIGURED, textLink } from "../shared";

export const metadata = { title: "Continue signing in | Advent of Admin", robots: { index: false, follow: false } };

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <AdventTitle label="Advent of Admin" title="Continue signing in" description="Use this link once to open your account in this browser." />
      {!storageConfig() || !sessionSecret() ? <Notice>{NOT_CONFIGURED}</Notice> : <VerifyLink />}
      <Link href="/advent/sign-in" className={textLink}>Request a new sign-in link</Link>
    </div>
  );
}
