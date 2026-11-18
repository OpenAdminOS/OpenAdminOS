/**
 * Copy and constants shared by the Nova service in the main process, the
 * Nova panel and Settings, Nova.
 */

/** The messaging connectors Nova can prepare sends through. */
export const NOVA_SEND_CONNECTOR_IDS = ["outlook", "teams", "slack", "whatsapp-web", "discord", "signal"] as const;

/** Said when a hosted voice session ends because its instructions or notes changed. */
export const NOVA_SESSION_PROFILE_CHANGED =
  "Nova settings or notes changed after this voice session started, so the session ended. OpenAI received the earlier instructions and notes at the start; a new session gets the current ones. Start Nova again.";

/** Shown when a session starts without the organization's notes because they could not be read. */
export const NOVA_NOTES_UNREADABLE_NOTICE =
  "Nova could not read this organization's notes, so this conversation runs without them. Open Settings, Nova, to check them.";

/** The app-state change reason sent when the main process ends a hosted voice session. */
export const NOVA_SESSION_ENDED_REASON = "nova-session-ended";

/** Said when a voice session ends because its organization, its connection or the reasoning provider changed. */
export const NOVA_SESSION_CONTEXT_CHANGED =
  "The organization, its connection or the reasoning provider changed after this voice session started, so the session ended. Start Nova again.";

/** The app-state change reason sent when the main process ends a voice session because its context changed. */
export const NOVA_SESSION_CONTEXT_ENDED_REASON = "nova-session-context-ended";

/** Said when a voice session ended before the click on its pending card. */
export const NOVA_SESSION_ENDED_BEFORE_CARD =
  "This voice session ended before the click, so the card was not carried out.";

/** What happened to a pending card when its voice session ended before the click. */
export function novaEndedCardOutcome(kind: "send" | "run" | "profile" | "remember" | "follow-up"): string {
  return {
    remember: "The note on the card was not confirmed. It stays proposed in Settings, Nova, for review.",
    "follow-up": "No follow-up was set.",
    send: "Nothing was sent.",
    run: "No agent was started.",
    profile: "The settings change on the card was not saved.",
  }[kind];
}
