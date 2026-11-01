import type { RunGraphApi } from "@openadminos/agent-sdk";

import type { ChatSuggestedPrompt } from "../../src/shared/chat-prompts.js";
import {
  PILOT_COPY,
  pilotPromptEntry,
  type PilotPromptEntry,
} from "../../src/shared/pilot-mode.js";
import {
  computeSampleTenantAnswer,
  renderComputedSampleAnswer,
  type ComputedSampleAnswer,
  type SampleAnswerFact,
} from "./answers.js";

export interface PilotPreparedAnswer {
  entry: PilotPromptEntry;
  computed: ComputedSampleAnswer;
  narrative: string;
  markdown: string;
}

const PILOT_TABLE_ROWS = 6;

type Facts = Readonly<Record<string, SampleAnswerFact>>;
type Narrative = (facts: Facts) => string;

/**
 * Builds the prepared answer for a pilot prompt: a short narrative written
 * from the computed facts, the evidence table, and the production footer.
 * Returns undefined for anything that is not a prepared pilot prompt.
 */
export async function buildPilotPreparedAnswer(
  graph: RunGraphApi,
  question: string,
  now: Date,
): Promise<PilotPreparedAnswer | undefined> {
  const entry = pilotPromptEntry(question);
  if (!entry) return undefined;
  const computed = await computeSampleTenantAnswer(graph, entry.prompt, now);
  if (!computed) return undefined;
  const narrative = PILOT_NARRATIVES[entry.prompt]?.(computed.facts);
  if (!narrative) {
    throw new Error(`Pilot mode has no prepared narrative for: ${entry.prompt}`);
  }
  return {
    entry,
    computed,
    narrative,
    markdown: renderComputedSampleAnswer(computed, {
      lead: narrative,
      omitSentence: true,
      // A guided tour: enough rows to show the evidence, the rest summarized.
      maxRows: PILOT_TABLE_ROWS,
      footer: PILOT_COPY.answerFooter,
    }),
  };
}

const PILOT_NARRATIVES: Partial<Record<ChatSuggestedPrompt, Narrative>> = {
  "Which managed devices have not synced in the last 7 days?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every managed device has synced in the last 7 days. Nothing needs follow-up today.";
    return [
      `${count} of ${num(facts.total)} managed devices have not checked in with Intune for more than 7 days (${list(facts.platforms)}).`,
      `The oldest, ${str(facts.oldestName)}, last synced ${days(facts.oldestDays)} ago, and ${plural(num(facts.over30), "device has", "devices have")} been silent for a month or more.`,
      `${plural(num(facts.noncompliant), "of them is", "of them are")} also noncompliant, so their compliance state may be out of date.`,
      "Before retiring anything, check whether these devices were replaced, reassigned, or are simply offline.",
    ].join(" ");
  },
  "Which devices are both stale and noncompliant?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No stale device is also noncompliant.";
    return [
      `${plural(count, "device is", "devices are")} both stale and noncompliant: ${list(facts.names)}.`,
      `Reported reasons: ${arr(facts.reasons).join("; ")}.`,
      "These are the strongest cleanup candidates, but confirm with the primary user or the asset register before you retire them.",
    ].join(" ");
  },
  "Which devices are stale in Intune but still active in Entra?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every stale Intune device is also quiet in Entra.";
    return [
      `${plural(count, "device has", "devices have")} stopped syncing with Intune but still signed in to Entra within the last week, ${num(facts.activeToday) === count ? (count === 1 ? "and it did so" : "all of them") : `${num(facts.activeToday)} of them`} in the last day.`,
      "People are using these devices, so the Intune management channel is the likely problem, not the device.",
      "Check the Intune Management Extension and enrollment state on a few of them before treating them as inactive.",
    ].join(" ");
  },
  "Which Windows devices are not encrypted?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every managed Windows device reports encryption.";
    return [
      `${plural(count, "of", "of")} ${num(facts.windowsTotal)} managed Windows devices report no BitLocker encryption: ${list(facts.names)}.`,
      `${plural(num(facts.noncompliant), "of them is", "of them are")} already flagged noncompliant.`,
      "Check the BitLocker profile assignment and the device TPM state, then confirm the recovery key escrows to Entra once encryption starts.",
    ].join(" ");
  },
  "Which users are linked to noncompliant managed devices?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No user is linked to a noncompliant managed device.";
    return [
      `${plural(count, "user is", "users are")} the primary user of at least one noncompliant device, ${plural(num(facts.devices), "device", "devices")} in total.`,
      num(facts.multiple) > 0
        ? `${plural(num(facts.multiple), "user has", "users have")} more than one.`
        : "No user has more than one.",
      "If Conditional Access requires compliant devices, these people are the ones who will be blocked first.",
    ].join(" ");
  },
  "Which compliance policies were modified most recently?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No compliance policy changed in the last 30 days.";
    return [
      `${plural(count, "compliance policy was", "compliance policies were")} changed in the last 30 days.`,
      `The most recent is ${str(facts.newestName)}, ${days(facts.newestDays)} ago.`,
      "A recent compliance change is a common cause of a sudden jump in noncompliant devices, so compare the change date with the encryption and sync findings.",
    ].join(" ");
  },
  "Which Conditional Access policies are disabled or report-only?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every Conditional Access policy is enforced.";
    const disabled = arr(facts.disabled);
    const reportOnly = arr(facts.reportOnly);
    return [
      `${count} of ${num(facts.total)} Conditional Access policies do not enforce anything today.`,
      disabled.length > 0 ? `Disabled: ${list(disabled)}.` : "",
      reportOnly.length > 0 ? `Report-only: ${list(reportOnly)}.` : "",
      "Review the report-only sign-in impact and the intended scope before deciding to enforce or delete either one.",
    ].filter(Boolean).join(" ");
  },
  "Which Conditional Access policies exclude guest or external identities?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No Conditional Access policy excludes guest or external identities.";
    return [
      `${plural(count, "policy excludes", "policies exclude")} guest or external identities: ${list(facts.names)}.`,
      `Excluded types: ${list(facts.types)}.`,
      "Make sure another policy covers these identities, otherwise partner accounts sign in with fewer controls than employees.",
    ].join(" ");
  },
  "Which recent sign-ins failed because of Conditional Access?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No recent sign-in failed because of Conditional Access.";
    return [
      `${plural(count, "recent sign-in", "recent sign-ins")} failed with Conditional Access error 53003, across ${plural(num(facts.users), "user", "users")}.`,
      `Most failures came from ${str(facts.topApp)}, and ${str(facts.topUser)} had the most.`,
      "Repeated blocks for the same person usually mean a device that is not compliant, not an attack. Check that user's devices first.",
    ].join(" ");
  },
  "Which guest users have not signed in recently?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every guest signed in within the last 90 days.";
    return [
      `${count} of ${num(facts.guests)} guest accounts have not signed in for more than 90 days; the oldest was last seen ${days(facts.oldestDays)} ago.`,
      `${plural(num(facts.pending), "of them never accepted", "of them never accepted")} the invitation, and ${plural(num(facts.enabled), "is", "are")} still enabled.`,
      "Confirm with each sponsoring team that access is no longer needed, then disable before deleting.",
    ].join(" ");
  },
  "Which user accounts are disabled?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No user account is disabled.";
    return [
      `${plural(count, "account is", "accounts are")} disabled, ${plural(num(facts.guests), "of them a guest", "of them guests")}.`,
      `${plural(num(facts.licensed), "still holds", "still hold")} a license.`,
      "Disabled accounts that keep licenses cost money and often belong to finished offboarding. Check the offboarding record, then reclaim the license.",
    ].join(" ");
  },
  "Which users hold privileged directory roles?": (facts) => {
    const users = num(facts.users);
    if (users === 0) return "No user holds a privileged directory role.";
    return [
      `${plural(users, "user holds", "users hold")} ${plural(num(facts.assignments), "privileged role assignment", "privileged role assignments")}, including ${plural(num(facts.globalAdmins), "Global Administrator", "Global Administrators")}.`,
      num(facts.disabledHolders) > 0
        ? `${plural(num(facts.disabledHolders), "holder is", "holders are")} disabled but still assigned.`
        : "Every holder is enabled.",
      "Standing access is the risk here. Check whether these assignments can move to eligible assignments in Privileged Identity Management.",
    ].join(" ");
  },
  "Which app registration secrets or certificates expire soon?": (facts) => {
    const count = num(facts.count);
    const expired = num(facts.expired);
    const lead = count === 0
      ? "No app registration credential expires in the next 30 days."
      : `${plural(count, "app registration credential expires", "app registration credentials expire")} in the next 30 days. The first is on ${str(facts.soonestApp)}, in ${days(facts.soonestDays)}.`;
    return [
      lead,
      expired > 0
        ? `${plural(expired, "credential has", "credentials have")} already expired (${list(facts.expiredApps)}), so any integration still using it is failing now.`
        : "No credential has expired yet.",
      "Find the owner of each app, rotate the secret, and update the system that uses it before the old one stops working.",
    ].join(" ");
  },
  "Which required apps are assigned but not installed on targeted devices?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "Every required app reports installed on its targeted devices.";
    const codes = arr(facts.errorCodes);
    return [
      `${plural(count, "targeted install", "targeted installs")} of ${list(facts.apps)} ${count === 1 ? "is" : "are"} not complete: ${num(facts.failed)} failed and ${num(facts.pending)} pending.`,
      codes.length > 0 ? `The failures report ${list(codes)}.` : "",
      "Look up the error code in the device install status, then check whether the failed devices share a model or an OS build.",
    ].filter(Boolean).join(" ");
  },
  "Which superseded apps are still detected on devices?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No superseded app is still detected on devices.";
    return [
      `${list(facts.apps)} ${count === 1 ? "was" : "were"} replaced by ${list(facts.replacements)} but ${count === 1 ? "is" : "are"} still detected on ${plural(num(facts.deviceCount), "device", "devices")}.`,
      "Two versions side by side usually means the supersedence is set to update rather than uninstall, or the old app was installed outside Intune.",
      "Check the supersedence settings before adding an uninstall assignment.",
    ].join(" ");
  },
  "Which high-severity Defender incidents are open?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No high-severity Defender incident is open.";
    return [
      `${plural(count, "high-severity incident is", "high-severity incidents are")} open: ${list(facts.names)}.`,
      `${plural(num(facts.active), "is", "are")} still active, and the newest opened ${hours(facts.newestHours)} ago.`,
      "Check that each incident has an owner working it and that the affected devices are isolated if the investigation calls for it.",
    ].join(" ");
  },
  "Which Defender alerts were raised this week?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No Defender alert was raised this week.";
    return [
      `${plural(count, "Defender alert was", "Defender alerts were")} raised in the last 7 days, ${num(facts.high)} of them high severity.`,
      `${plural(num(facts.unresolved), "is", "are")} not resolved yet.`,
      arr(facts.highTitles).length > 0
        ? `Start with the high-severity ones: ${list(facts.highTitles)}.`
        : "None are high severity.",
    ].join(" ");
  },
  "Which Secure Score improvement actions rank highest?": (facts) => {
    const count = num(facts.count);
    if (count === 0) return "No Secure Score improvement action is available.";
    return [
      `${plural(count, "improvement action is", "improvement actions are")} open. The top ranked are ${list(facts.top)}.`,
      `${plural(num(facts.lowCost), "action has", "actions have")} a low implementation cost.`,
      "Compare the top actions with the Conditional Access findings; several overlap and can be closed with one policy change.",
    ].join(" ");
  },
};

function num(value: SampleAnswerFact | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

function str(value: SampleAnswerFact | undefined): string {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function arr(value: SampleAnswerFact | undefined): readonly string[] {
  return Array.isArray(value) ? value : value === undefined || value === "" ? [] : [String(value)];
}

function list(value: SampleAnswerFact | undefined): string {
  const values = arr(value);
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function days(value: SampleAnswerFact | undefined): string {
  return plural(num(value), "day", "days");
}

function hours(value: SampleAnswerFact | undefined): string {
  return plural(num(value), "hour", "hours");
}
