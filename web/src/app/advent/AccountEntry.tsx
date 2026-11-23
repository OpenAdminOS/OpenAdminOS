import Link from "next/link";

import { MARKETING_CONSENT_LABEL, missingLoginConfig, rulesApproved } from "~/lib/advent/config";
import { CAMPAIGN_CLOSE, campaignNow } from "~/lib/advent/time";
import { ActionForm } from "./ActionForm";
import { AdventTitle, BackToCalendar, field, Notice, textLink } from "./shared";

export function AccountEntry({ signup = false, referral = "" }: { signup?: boolean; referral?: string }) {
  const rulesPending = signup && !rulesApproved();
  const closed = signup && campaignNow(process.env.ADVENT_NOW) >= CAMPAIGN_CLOSE;
  const configError = missingLoginConfig();
  const blocked = closed ? "Campaign registration is closed." : rulesPending ? "Rules are being finalised." : configError;

  return (
    <div className="mx-auto max-w-lg space-y-7">
      <BackToCalendar />
      <AdventTitle
        label="Advent of Admin"
        title={signup ? "Sign up" : "Sign in"}
        description={signup ? "Use your email to save completed doors and enter the draws." : "We’ll email you a link to open My Advent."}
      />
      {blocked && <Notice>{blocked}</Notice>}
      {configError && configError !== blocked && <Notice>{configError}</Notice>}
      <ActionForm action={signup ? "sign-up" : "sign-in"} label="Send sign-in link" disabled={Boolean(blocked)}>
        <fieldset disabled={Boolean(blocked)} className="space-y-4 disabled:opacity-70">
          <label className="block text-sm font-medium">
            Email
            <input className={`${field} mt-2 block`} type="email" name="email" autoComplete="email" maxLength={254} required />
          </label>
          {signup && (
            <>
              <label className="block text-sm font-medium">
                Handle
                <input className={`${field} mt-2 block`} name="handle" pattern={"[a-z0-9][a-z0-9\\-]{1,22}[a-z0-9]"} maxLength={24} autoComplete="username" autoCapitalize="none" aria-describedby="handle-help" required />
              </label>
              <p id="handle-help" className="text-sm text-brand-muted">Use 3 to 24 lowercase letters, digits or internal hyphens.</p>
              <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="age" required />I am 18 or older.</label>
              <div className="flex items-baseline gap-2 text-sm">
                <input type="checkbox" id="accept-rules" name="rules" required />
                <span><label htmlFor="accept-rules">I accept the campaign rules.</label>{" "}<Link href="/advent/rules" className={textLink}>Read the rules</Link></span>
              </div>
              <label className="flex items-baseline gap-2 text-sm"><input type="checkbox" name="marketing" />{MARKETING_CONSENT_LABEL}</label>
              <input type="hidden" name="ref" value={referral} />
            </>
          )}
        </fieldset>
      </ActionForm>
      <p className="text-sm text-brand-muted">
        {signup ? <>Already have an account? <Link href="/advent/sign-in" className={textLink}>Sign in</Link>.</>
          : <>New to Advent of Admin? <Link href="/advent/sign-up" className={textLink}>Sign up</Link>.</>}
      </p>
    </div>
  );
}
