import type { ChatSuggestedPrompt } from "./chat-prompts.js";

/**
 * Pilot mode is a guided tour on the built-in fictional tenant. It answers a
 * fixed set of prepared prompts and runs three agents with prepared text.
 * Everything else stays a production feature, so future agents and features
 * never need pilot data.
 */
export const PILOT_AGENT_SLUGS = [
  "find-inactive-devices",
  "conditional-access-explainer",
  "stale-guest-cleanup",
] as const;

export type PilotAgentSlug = (typeof PILOT_AGENT_SLUGS)[number];

export function isPilotAgentSlug(slug: string): slug is PilotAgentSlug {
  return (PILOT_AGENT_SLUGS as readonly string[]).includes(slug);
}

export interface PilotStarter {
  area: string;
  prompt: ChatSuggestedPrompt;
  followUps: readonly [ChatSuggestedPrompt, ChatSuggestedPrompt];
}

export const PILOT_STARTERS: readonly PilotStarter[] = [
  {
    area: "Devices",
    prompt: "Which managed devices have not synced in the last 7 days?",
    followUps: [
      "Which devices are both stale and noncompliant?",
      "Which devices are stale in Intune but still active in Entra?",
    ],
  },
  {
    area: "Compliance",
    prompt: "Which Windows devices are not encrypted?",
    followUps: [
      "Which users are linked to noncompliant managed devices?",
      "Which compliance policies were modified most recently?",
    ],
  },
  {
    area: "Conditional Access",
    prompt: "Which Conditional Access policies are disabled or report-only?",
    followUps: [
      "Which Conditional Access policies exclude guest or external identities?",
      "Which recent sign-ins failed because of Conditional Access?",
    ],
  },
  {
    area: "Users",
    prompt: "Which guest users have not signed in recently?",
    followUps: [
      "Which user accounts are disabled?",
      "Which users hold privileged directory roles?",
    ],
  },
  {
    area: "Apps",
    prompt: "Which app registration secrets or certificates expire soon?",
    followUps: [
      "Which required apps are assigned but not installed on targeted devices?",
      "Which superseded apps are still detected on devices?",
    ],
  },
  {
    area: "Security",
    prompt: "Which high-severity Defender incidents are open?",
    followUps: [
      "Which Defender alerts were raised this week?",
      "Which Secure Score improvement actions rank highest?",
    ],
  },
];

/** The agent a prepared answer points to with a "Try the agent" chip. */
const PILOT_PROMPT_AGENTS: Partial<Record<ChatSuggestedPrompt, PilotAgentSlug>> = {
  "Which managed devices have not synced in the last 7 days?": "find-inactive-devices",
  "Which devices are both stale and noncompliant?": "find-inactive-devices",
  "Which devices are stale in Intune but still active in Entra?": "find-inactive-devices",
  "Which Conditional Access policies are disabled or report-only?": "conditional-access-explainer",
  "Which Conditional Access policies exclude guest or external identities?": "conditional-access-explainer",
  "Which recent sign-ins failed because of Conditional Access?": "conditional-access-explainer",
  "Which guest users have not signed in recently?": "stale-guest-cleanup",
};

export interface PilotPromptEntry {
  prompt: ChatSuggestedPrompt;
  starter: PilotStarter;
  /** Chips shown under this prompt's answer. */
  followUps: readonly ChatSuggestedPrompt[];
  agentSlug?: PilotAgentSlug;
}

export const PILOT_PROMPTS: readonly ChatSuggestedPrompt[] = PILOT_STARTERS.flatMap(
  (starter) => [starter.prompt, ...starter.followUps],
);

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function pilotPromptEntry(question: string): PilotPromptEntry | undefined {
  const normalized = normalize(question);
  for (const starter of PILOT_STARTERS) {
    const prompts = [starter.prompt, ...starter.followUps];
    const prompt = prompts.find((candidate) => normalize(candidate) === normalized);
    if (!prompt) continue;
    const agentSlug = PILOT_PROMPT_AGENTS[prompt];
    return {
      prompt,
      starter,
      followUps:
        prompt === starter.prompt
          ? starter.followUps
          : starter.followUps.filter((candidate) => candidate !== prompt),
      ...(agentSlug ? { agentSlug } : {}),
    };
  }
  return undefined;
}

export const PILOT_COPY = {
  modeName: "Pilot mode",
  productionName: "Production",
  badge: "Pilot mode",
  banner:
    "Pilot mode. Sample data from a fictional company. Chat uses prepared prompts and three agents are available.",
  connectAction: "Connect your tenant",
  composerExplanation:
    "In pilot mode you choose from prepared prompts. Connect your tenant to ask anything.",
  answerScope: "Pilot mode · prepared answer from sample data",
  answerFooter: "In production, answers come from your tenant and the model you choose.",
  promptRejected:
    "Pilot mode answers prepared prompts only. Connect your tenant to ask anything.",
  multiTenantRejected:
    "Multi-tenant Chat is available in production. Remove Contoso (pilot) from the tenant selection or connect your tenant.",
  tryAgent: (agentName: string) => `Try the agent: ${agentName}`,
  agentsAvailable: "Available in pilot mode",
  agentsProduction: "Available in production",
  agentConnectToRun: "Connect your tenant to run",
  agentRefused: (agentName: string) =>
    `${agentName} is available in production. Connect your tenant to run it.`,
  featureInProduction: (feature: string, plural = false) =>
    plural
      ? `${feature} are available in production. Connect your tenant to use them.`
      : `${feature} is available in production. Connect your tenant to use it.`,
  noSignIn: "Pilot mode has no Microsoft sign-in. Connect your tenant to use this.",
  providerName: "Pilot (prepared)",
  preparedModel: "pilot-prepared",
  preparedPrefix: "Prepared sample report.",
  reportNote: "This report uses prepared sample text. No model was used.",
  runTrust: "Pilot mode · prepared sample text · nothing leaves this device",
  boundaryLabel: "Pilot · No model used",
  boundaryTooltip:
    "Pilot mode answers prepared prompts and runs pilot agents with prepared text. No model is used and nothing leaves this device.",
  composerBoundary: "Pilot mode. No model is used and nothing leaves this device.",
  leaveTitle: "Leave pilot mode",
  leaveBody:
    "This deletes the fictional Contoso tenant from this device, with its pilot runs, chats, cached sample rows, and simulated changes. Your connected tenants are not affected.",
  leaveAction: "Leave pilot mode",
  openAction: "Open pilot mode",
  removedAfterConnect: "Pilot mode data was removed. You are now in production.",
  dataLabel: "Sample data from a fictional company",
} as const;
