export const CHAT_PROMPT_GROUPS = [
  {
    label: "Devices",
    prompts: [
      "Which managed devices have not synced in the last 7 days?",
      "Which devices are stale in Intune but still active in Entra?",
      "Which devices are both stale and noncompliant?",
      "Which Windows devices are not encrypted?",
    ],
  },
  {
    label: "Users",
    prompts: [
      "Which user accounts are disabled?",
      "Which guest users have not signed in recently?",
      "Which users are linked to noncompliant managed devices?",
      "Which users appear in recent directory audit events?",
    ],
  },
  {
    label: "Apps",
    prompts: [
      "Which required apps are assigned but not installed on targeted devices?",
      "Which app deployments appear tied to the primary user?",
      "Which superseded apps are still detected on devices?",
      "Which app assignments target empty or stale groups?",
    ],
  },
  {
    label: "Policies",
    prompts: [
      "Which compliance policies were modified most recently?",
      "Which Conditional Access policies are disabled or report-only?",
      "Which configuration policies have the highest setting counts?",
      "Which policies changed recently?",
    ],
  },
  {
    label: "Sign-ins",
    prompts: [
      "Which recent sign-ins failed because of Conditional Access?",
      "Which users have repeated failed sign-ins?",
      "Which risky sign-ins need review?",
      "Which applications have the most sign-in failures?",
    ],
  },
  {
    label: "Identity",
    prompts: [
      "Which Entra devices are not managed in Intune?",
      "Which app registration secrets or certificates expire soon?",
      "Which users hold privileged directory roles?",
      "Which Conditional Access policies exclude guest or external identities?",
    ],
  },
  {
    label: "Security",
    prompts: [
      "Which high-severity Defender incidents are open?",
      "Which Defender alerts were raised this week?",
      "How has Secure Score changed over the last 90 days?",
      "Which Secure Score improvement actions rank highest?",
    ],
  },
] as const;

export const CHAT_SUGGESTED_PROMPTS = CHAT_PROMPT_GROUPS.flatMap(
  (group) => group.prompts,
);

export type ChatSuggestedPrompt = (typeof CHAT_SUGGESTED_PROMPTS)[number];

