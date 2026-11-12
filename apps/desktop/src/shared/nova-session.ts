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
