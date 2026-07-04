import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro } from "../MarketingShell";
import {
  GITHUB_URL,
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";
import { CopyPromptButton } from "./CopyPromptButton";

const TITLE = "Build your own Agent examples";
const DESCRIPTION =
  "Copyable prompt examples for drafting read, write, and connector-backed OpenAdminOS agents for Microsoft 365 administration.";
const AGENT_SDK_DOCS_URL = `${GITHUB_URL}/blob/main/docs/agent-sdk.md`;

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/examples",
});

type ExampleMode = "read" | "write" | "notify";

interface ExampleCard {
  title: string;
  source: string;
  prompt: string;
  result: string;
  scopes: readonly string[];
  mode: ExampleMode;
  safety: string;
  connector?: string;
}

interface ExampleGroup {
  name: string;
  eyebrow: string;
  description: string;
  examples: readonly ExampleCard[];
}

const EXAMPLE_GROUPS: readonly ExampleGroup[] = [
  {
    name: "Read/investigate",
    eyebrow: "No tenant changes",
    description:
      "These prompts draft read-only Agent Templates that pull bounded Microsoft Graph evidence, shape it locally, and ask the selected model to explain the finding.",
    examples: [
      {
        title: "Inactive device review",
        source: "Grounded in find-inactive-devices",
        prompt:
          "Find Intune devices that have not synced in 60 days. Group them by operating system, compliance state, and ownership, and tell me what to check before cleanup.",
        result:
          "The agent reads Intune managed devices, builds sync-age buckets, and returns a review-first cleanup report. It flags stale inventory as evidence to investigate, not proof that a device should be retired.",
        scopes: ["DeviceManagementManagedDevices.Read.All"],
        mode: "read",
        safety: "Read-only run. No Graph write step is generated.",
      },
      {
        title: "Failed sign-in clusters",
        source: "Grounded in sign-in-failure-explainer",
        prompt:
          "Explain failed Entra sign-ins from the last 24 hours. Cluster likely root causes by error code, app, Conditional Access status, client app, and affected users.",
        result:
          "The agent reads recent failed sign-ins and groups them into likely root-cause clusters. The report separates known-noise patterns from failures that should move to CA review, device compliance checks, or incident response.",
        scopes: ["AuditLog.Read.All"],
        mode: "read",
        safety: "Requires Entra ID P1 data. It does not reset credentials or change policies.",
      },
      {
        title: "Conditional Access posture",
        source: "Grounded in conditional-access-explainer",
        prompt:
          "Review our Conditional Access policies for report-only controls, broad exclusions, stale policies, and gaps around admin MFA, legacy auth, guests, and risky sign-ins.",
        result:
          "The agent reads Conditional Access policies and asks the model to produce a coverage map with named policies. It calls out disabled or report-only controls and states when coverage is not proven from the policy set.",
        scopes: ["Policy.Read.All"],
        mode: "read",
        safety: "Read-only policy review. Enforcement changes need a separate write agent.",
      },
      {
        title: "Dormant app registrations",
        source: "Grounded in dormant-app-registrations",
        prompt:
          "Find app registrations that look dormant or risky. Use age, sign-in audience, credentials, redirect URIs, app roles, required resource access, and missing publisher context. Do not recommend deletion without owner confirmation.",
        result:
          "The agent reads app registrations and groups likely cleanup or review candidates. It is intentionally conservative because app registration data alone cannot prove an app is unused.",
        scopes: ["Application.Read.All"],
        mode: "read",
        safety: "Read-only report. Deletion is not proposed from this prompt.",
      },
    ],
  },
  {
    name: "Write with confirmation",
    eyebrow: "Diff before change",
    description:
      "Write prompts draft a read-and-plan pipeline first. The generated write step produces a bounded change set, then OpenAdminOS pauses for confirmation before any Graph mutation runs.",
    examples: [
      {
        title: "Disable stale guests",
        source: "Grounded in stale-guest-cleanup",
        prompt:
          "Disable enabled guest accounts that have not signed in for 180 days, with my approval. Cap the plan at 50 users and explain each proposed disable.",
        result:
          "The agent reads guest users, filters by stale sign-in activity, and asks the model for a per-guest rationale. The write plan patches accountEnabled to false only for the reviewed candidate list.",
        scopes: ["User.Read.All", "AuditLog.Read.All", "User.ReadWrite.All"],
        mode: "write",
        safety:
          "Typed confirmation pause: DISABLE N GUESTS before PATCH /users actions run.",
      },
      {
        title: "Retire stale Intune devices",
        source: "Grounded in offboarding-agent",
        prompt:
          "Retire corporate Intune devices that are stale in both Intune and Entra for 180 days, but only after I approve the diff. Exclude personal devices and explain the evidence.",
        result:
          "The agent correlates Intune managedDevices with Entra devices, excludes personal and in-flight devices, and builds one retire action per candidate. The rationale includes sync age, Entra sign-in caveats, ownership, OS, and compliance signals.",
        scopes: [
          "DeviceManagementManagedDevices.Read.All",
          "Device.Read.All",
          "DeviceManagementManagedDevices.PrivilegedOperations.All",
        ],
        mode: "write",
        safety:
          "Typed confirmation pause: OFFBOARD N DEVICES before Intune retire actions run.",
      },
      {
        title: "Move report-only CA policies",
        source: "Plausible new Agent Template",
        prompt:
          "Find Conditional Access policies that are report-only and start with Pilot -. Prepare a plan to enable them, but wait for my approval and show the before and after state for each policy.",
        result:
          "The agent reads Conditional Access policies, filters to the named pilot set, and summarizes what enforcement would change. The write step uses a generic Graph PATCH plan against only the reviewed policy IDs.",
        scopes: ["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"],
        mode: "write",
        safety:
          "Typed confirmation pause: ENABLE N CA POLICIES before policy state changes run.",
      },
      {
        title: "Set missing usage location",
        source: "Extends user-license-overview",
        prompt:
          "Set usageLocation to US for member users that are missing it, but only for accounts I review and approve. Skip guests and disabled accounts.",
        result:
          "The agent reads users, selects member accounts with missing usageLocation, and explains why the field matters before license assignment. The write plan patches only the reviewed users and leaves guests or disabled accounts out.",
        scopes: ["User.Read.All", "User.ReadWrite.All"],
        mode: "write",
        safety:
          "Typed confirmation pause: SET USAGE LOCATION FOR N USERS before PATCH /users actions run.",
      },
    ],
  },
  {
    name: "Connector-backed delivery",
    eyebrow: "Read locally, send deliberately",
    description:
      "These prompts keep Graph collection read-only, then use a declared connector or per-agent delivery rule to send the finished report. Connector egress is shown separately from Graph scope access.",
    examples: [
      {
        title: "Weekly Teams compliance summary",
        source: "Grounded in tenant-health-report",
        prompt:
          "Send a weekly compliance summary to my Teams channel. Include noncompliant and unknown counts, stale inventory, and the first action to take.",
        result:
          "The agent reads Intune managed-device health, asks the model for a compact summary, and schedules the run. Delivery uses the Teams connector or delivery rule so the report lands in the selected channel.",
        scopes: [
          "DeviceManagementManagedDevices.Read.All",
          "Team.ReadBasic.All",
          "Channel.ReadBasic.All",
          "ChannelMessage.Send",
        ],
        mode: "notify",
        connector: "Microsoft Teams · post-channel-message@1",
        safety:
          "Preview & send confirmation for the Teams post. The Graph work remains read-only.",
      },
      {
        title: "Outlook tenant change digest",
        source: "Grounded in tenant-change-audit",
        prompt:
          "Email me a weekday digest of recent tenant changes: privileged role changes, app consents, failed admin actions, and anything off-hours. Keep it short.",
        result:
          "The agent reads recent directory audit events, separates routine activity from changes worth checking, and renders a short digest. The Outlook connector sends the message through Microsoft Graph without reading mail.",
        scopes: ["AuditLog.Read.All", "Directory.Read.All", "Mail.Send"],
        mode: "notify",
        connector: "Outlook · Mail.Send",
        safety:
          "Preview & send confirmation for the email. No Mail.Read scope is needed.",
      },
      {
        title: "Risky user triage to Slack",
        source: "Extends risky-sign-in-triage",
        prompt:
          "Post high-priority risky user triage to the security Slack channel after I preview the message. Include only users classified as likely-compromise or unclear-needs-review.",
        result:
          "The agent reads Entra risky users, classifies the freshest records, and filters the outbound summary to review-worthy users. Slack delivery is an external connector, so the page and app should say that the message leaves Microsoft 365.",
        scopes: ["IdentityRiskyUser.Read.All"],
        mode: "notify",
        connector: "Slack · chat:write",
        safety:
          "Preview & send confirmation for Slack. External connector egress is disclosed.",
      },
      {
        title: "WhatsApp update posture note",
        source: "Grounded in os-update-posture",
        prompt:
          "Send my on-call WhatsApp group a morning OS update posture note if stale Windows inventory increased. Mention stale sync caveats and avoid claiming a build is unsupported unless the data proves it.",
        result:
          "The agent reads managed-device OS version and inventory freshness signals, then compares the scheduled result with the prior run. WhatsApp Web delivery sends only the final note through the locally linked session.",
        scopes: ["DeviceManagementManagedDevices.Read.All"],
        mode: "notify",
        connector: "WhatsApp Web · send-message@1",
        safety:
          "Preview & send confirmation for WhatsApp. The connector does not read incoming messages.",
      },
    ],
  },
];

const FLOW_STEPS = [
  {
    label: "Draft",
    text: "The builder turns the prompt into a YAML Agent Template with Graph, transform, LLM, write, and connector steps.",
  },
  {
    label: "Validate",
    text: "Schema, Graph endpoint, scope, LLM-step, connector, and write-confirmation checks run before save is enabled.",
  },
  {
    label: "Preflight",
    text: "The app checks active tenant, provider, scopes, connector setup, and confirmation shape without applying writes.",
  },
  {
    label: "Install",
    text: "The reviewed manifest is saved locally. Public sharing creates a reviewed GitHub issue, not an automatic Hub publish.",
  },
] as const;

function ModeBadge({ mode }: { mode: ExampleMode }) {
  if (mode === "write") {
    return (
      <span className="inline-flex rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-xs font-medium text-amber-200">
        Write
      </span>
    );
  }

  if (mode === "notify") {
    return (
      <span className="inline-flex rounded-md border border-sky-300/25 bg-sky-300/10 px-2 py-1 text-xs font-medium text-sky-200">
        Read + notify
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-md border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-xs font-medium text-emerald-200">
      Read
    </span>
  );
}

function ScopeList({ scopes }: { scopes: readonly string[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {scopes.map((scope) => (
        <li key={scope} className="min-w-0">
          <code className="block rounded border border-white/10 bg-black/35 px-2 py-1 font-mono text-[11px] leading-5 text-white/55 break-all">
            {scope}
          </code>
        </li>
      ))}
    </ul>
  );
}

function ExampleCard({ example }: { example: ExampleCard }) {
  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-white/10 bg-white/[0.035] p-4 transition hover:border-white/18 hover:bg-white/[0.05]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-wider text-white/35">
            {example.source}
          </p>
          <h3 className="mt-2 text-lg font-semibold tracking-tight text-white">
            {example.title}
          </h3>
        </div>
        <ModeBadge mode={example.mode} />
      </div>

      <div className="mt-4 rounded-md border border-white/10 bg-black/30 p-3">
        <p className="font-mono text-xs leading-6 text-white/72">
          {example.prompt}
        </p>
        <div className="mt-3">
          <CopyPromptButton prompt={example.prompt} />
        </div>
      </div>

      <p className="mt-4 text-sm leading-6 text-white/60">{example.result}</p>

      <div className="mt-5">
        <p className="font-mono text-[10px] uppercase tracking-wider text-white/35">
          Graph scopes
        </p>
        <ScopeList scopes={example.scopes} />
      </div>

      {example.connector ? (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-white/35">
            Connector egress
          </p>
          <p className="mt-2 rounded border border-sky-300/15 bg-sky-300/[0.06] px-3 py-2 text-xs leading-5 text-sky-100/75">
            {example.connector}
          </p>
        </div>
      ) : null}

      <p className="mt-auto pt-5 text-xs leading-5 text-white/45">
        {example.safety}
      </p>
    </article>
  );
}

export default function ExamplesPage() {
  const allExamples = EXAMPLE_GROUPS.flatMap((group) => group.examples);
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/examples",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-07-04",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Examples", path: "/examples" },
      ]),
      {
        "@type": "ItemList",
        "@id": "https://www.openadminos.com/examples#prompt-examples",
        name: "OpenAdminOS Build your own Agent prompt examples",
        itemListElement: allExamples.map((example, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: example.title,
          description: example.prompt,
        })),
      },
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Examples gallery"
        title="Prompts that draft useful Microsoft 365 agents."
        description={DESCRIPTION}
      />

      <section className="mt-10 grid gap-4 border-y border-white/10 py-8 md:grid-cols-4">
        {FLOW_STEPS.map((step, index) => (
          <div key={step.label} className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-wider text-sky-300/70">
              {String(index + 1).padStart(2, "0")} · {step.label}
            </p>
            <p className="mt-3 text-sm leading-6 text-white/58">{step.text}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Builder flow
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            Describe the job. Review the manifest before it can run.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            Build your own Agent starts with a natural-language description and
            drafts a YAML Agent Template. The app validates the draft, runs a
            local preflight against the active tenant and provider, then lets
            the admin install the reviewed agent.
          </p>
          <p>
            These examples are phrased as prompts an admin could paste into that
            builder. The scopes shown are the permissions the resulting agent or
            connector would need before it can run.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href={AGENT_SDK_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-white/72 transition hover:border-white/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              Read the agent SDK guide
            </Link>
            <Link
              href="/download"
              className="inline-flex min-h-10 items-center justify-center rounded-md bg-white px-4 text-sm font-semibold text-[#070709] transition hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
            >
              Download OpenAdminOS
            </Link>
          </div>
        </div>
      </section>

      {EXAMPLE_GROUPS.map((group) => (
        <section key={group.name} className="mt-14 border-t border-white/10 pt-12">
          <div className="grid gap-5 md:grid-cols-[0.82fr_1.18fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                {group.eyebrow}
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                {group.name}
              </h2>
            </div>
            <p className="text-sm leading-6 text-white/60">
              {group.description}
            </p>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {group.examples.map((example) => (
              <ExampleCard key={example.title} example={example} />
            ))}
          </div>
        </section>
      ))}
    </MarketingShell>
  );
}
