import Link from "next/link";

import { LEGAL_ENTITY_NAME, LEGAL_ENTITY_ADDRESS_LINES, SUPPORT_EMAIL, pageMetadata } from "~/app/seo";
import { rulesApproved, RULES_VERSION } from "~/lib/advent/config";
import { AdventTitle, BackToCalendar, heading, Notice, textLink } from "../shared";

// TODO(ugur): The rules are a draft pending legal review. Approve the terms before opening registration.
const RULES_DRAFT = {
  status: "The rules are a draft pending legal review.",
  publicFallback: "Rules are being finalised.",
};

export function generateMetadata() {
  const metadata = pageMetadata({
    title: "Campaign rules | Advent of Admin",
    description: "Participation rules for the OpenAdminOS Advent of Admin campaign.",
    path: "/advent/rules",
  });
  return rulesApproved() ? metadata : { ...metadata, robots: { index: false, follow: true } };
}

export default function AdventRulesPage() {
  return (
    <article className="mx-auto max-w-2xl space-y-7">
      <BackToCalendar />
      <AdventTitle label="Advent of Admin" title="Campaign rules" />
      {!rulesApproved() ? <Notice>{RULES_DRAFT.publicFallback}</Notice> : (
        <div className="space-y-8 text-[15px] leading-7 text-brand-muted">
          <p>Version {RULES_VERSION} · Teilnahmebedingungen</p>
          <section className="space-y-2">
            <h2 className={heading}>Organiser</h2>
            <p>The campaign is organised by {LEGAL_ENTITY_NAME}.</p>
            <address className="not-italic">{LEGAL_ENTITY_ADDRESS_LINES.map((line) => <div key={line}>{line}</div>)}</address>
            <p>Contact <a href={`mailto:${SUPPORT_EMAIL}`} className={textLink}>{SUPPORT_EMAIL}</a>. See the <Link href="/legal-notice" className={textLink}>legal notice</Link> for full details.</p>
          </section>
          <section className="space-y-2">
            <h2 className={heading}>Who can enter</h2>
            <p>Entry is free and requires no purchase. Participants must be at least 18, use one account per person, and live outside countries under comprehensive EU or US sanctions. Employees of the organiser cannot enter.</p>
          </section>
          <section className="space-y-2">
            <h2 className={heading}>Dates and daily draws</h2>
            <p>One door opens at 06:00 CET each day from 1 to 24 December 2026. Complete a door before 06:00 CET the following day to enter its daily draw. One eligible participant is chosen at random per door and receives a €25 voucher. You can complete doors for the badge and grand draw until 23:59:59 CET on 31 December 2026.</p>
          </section>
          <section className="space-y-2">
            <h2 className={heading}>Grand draw and badge</h2>
            <p>Complete 18 or more doors to enter the grand draw after the campaign closes. Each eligible participant receives one entry plus one entry for each participant who signs up using their referral link and completes door 1, up to five extra entries. A referral must sign up after the referring participant and cannot be that participant.</p>
            <p>Prizes are drawn by entry weight, with a different winner for each available prize. In draw order the prizes are a mini PC that runs local models and two Microsoft certification exam vouchers. Completing at least 12 doors earns a badge.</p>
          </section>
          <section className="space-y-2">
            <h2 className={heading}>Receiving a prize</h2>
            <p>The organiser contacts winners by email. Winners must reply within 14 days. Physical prizes are shipped where possible. An equivalent voucher is offered where shipping is unavailable. There is no cash alternative.</p>
          </section>
          <section className="space-y-2">
            <h2 className={heading}>Privacy</h2>
            <p>The organiser uses campaign data to run the doors, confirm eligibility, and deliver prizes. See the <Link href="/privacy#advent" className={textLink}>privacy policy</Link> for the data collected and how to delete your account.</p>
          </section>
        </div>
      )}
    </article>
  );
}
