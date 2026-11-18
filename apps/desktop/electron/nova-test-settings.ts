import type { NovaProfile } from "@openadminos/agent-sdk";

import type { NovaSettings } from "./nova-actions.js";
import { effectiveNovaProfile } from "./nova-profile.js";

/** Test support: Nova settings with no profile and no IT policy, every ability on. */
export function defaultNovaSettings(profile?: NovaProfile): NovaSettings {
  return { profile, effective: effectiveNovaProfile(profile, undefined), policy: undefined };
}

/** Test support: a `NovaActionHost.profile` that returns the defaults. */
export const novaSettingsHost = { profile: async (): Promise<NovaSettings> => defaultNovaSettings() };
