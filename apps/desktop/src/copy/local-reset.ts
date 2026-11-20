import type { LocalResetInfo } from "../shared/openAdminOS";
import { LOCAL_RESET_PHRASE } from "../shared/local-reset";

/** Copy for Reset OpenAdminOS: Settings, the dialog, the incomplete screen and the notice after a reset. */
export const LOCAL_RESET_COPY = {
  settingsTitle: "Reset OpenAdminOS",
  settingsDescription:
    "Remove every organization, sign-in, provider key and local record from this device, then start again at first run.",
  settingsAction: "Reset OpenAdminOS",
  dialogTitle: "Reset OpenAdminOS",
  dialogBadge: "Permanent local deletion",
  removedTitle: "Removed from this device",
  removed: (info: LocalResetInfo | undefined): string[] => [
    "Every organization and its Microsoft sign-in tokens",
    "Provider settings and API keys",
    "Connector settings and secrets, including the WhatsApp Web session",
    "Chats, workspaces, Graph cache, change history and run history",
    "Agent Team data, Nova notes and follow-ups",
    "Installed agents and downloaded agent updates",
    "The configuration audit log on this device",
    ...(info?.packaged && info.platform === "macos"
      ? [
          "The background scheduler and the menu bar login item",
          'The Keychain item "OpenAdminOS Safe Storage", cached app updates and app preferences',
        ]
      : info?.packaged && info.platform === "windows"
        ? ["The background scheduled task", "Cached app updates. The encryption key in the data folder goes with it."]
        : info?.packaged
          ? ["Cached app updates"]
          : []),
  ],
  developmentBuild:
    "Development build: the Keychain item, the background scheduler and the installed app's caches are not touched.",
  keepsTitle: "Stays",
  keepsConsent:
    "The OpenAdminOS enterprise application and the admin consent granted to it stay in each tenant. Revoke them in Microsoft Entra.",
  keepsPolicy: "The IT policy file (policy.json) set by whoever manages this device.",
  keepsExports: "Exports and other files you saved outside the data folder.",
  revokeLink: "How to revoke access in Entra",
  revokeUrl: "https://docs.openadminos.com/trust-model/authentication#disconnecting-and-revoking",
  restartNote: "OpenAdminOS closes and opens again at first run.",
  phraseLabel: `Type ${LOCAL_RESET_PHRASE} to confirm`,
  phrasePlaceholder: "Type the phrase to enable Reset",
  action: "Reset and restart",
  busyAction: "Resetting",
  progress: "Signing out of every organization and stopping background work. OpenAdminOS closes in a moment.",
  restarting: "Reset started. OpenAdminOS is closing and opens again at first run.",
  failedFallback:
    "The reset could not start. Nothing was removed. Try again, or quit OpenAdminOS and remove the data folder by hand, as described in Uninstall and reset in the docs.",
  docsLink: "Uninstall and reset",
  docsUrl: "https://docs.openadminos.com/basics/uninstall-and-reset",
  incompleteTitle: "Reset did not finish",
  incompleteBody:
    "The reset of this device has not finished. OpenAdminOS does not open until it does, so old data is never mixed with new.",
  incompleteFailedTitle: "Not finished",
  incompleteHint:
    "Close programs that may use these files, such as a backup or antivirus scan, then choose Try again. You can also remove them from the data folder yourself and then choose Try again.",
  incompleteRetry: "Try again",
  incompleteShowFolder: "Show data folder",
  incompleteQuit: "Quit",
  incompleteActionFailed: "That did not work. Quit OpenAdminOS and open it again to retry the reset.",
  noticeTitle: "OpenAdminOS was reset",
  noticeBody:
    "Local data, sign-ins and provider keys were removed from this device. Admin consent stays in each tenant until you revoke it in Entra.",
  noticeWarningsTitle: "Could not remove",
  noticeDismiss: "Dismiss",
} as const;
