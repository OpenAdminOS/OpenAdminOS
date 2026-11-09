import { MANAGED_POLICY_SET_BY, type ManagedPolicyScope, type ManagedPolicySettingKey } from "../shared/openAdminOS";

/** Copy for the IT policy file (managed configuration). */
export const POLICY_COPY = {
  setBy: MANAGED_POLICY_SET_BY,
  panelTitle: "IT policy",
  panelBody:
    "Your IT department manages some settings on this device with a policy file. Settings it sets are marked and cannot be changed here. Changes to the file apply at the next launch.",
  filesHeading: "Policy files",
  scope: (scope: ManagedPolicyScope) => (scope === "machine" ? "Machine" : "User"),
  fileFound: "Read",
  fileMissing: "Not present",
  settingsHeading: "Settings in force",
  locked: "Locked",
  unlocked: "Default, can be changed",
  noSettings: "The policy files set no valid setting.",
  problemsHeading: (count: number) => (count === 1 ? "1 problem" : `${count} problems`),
  problemsBody:
    "OpenAdminOS does not apply an invalid setting and applies the rest of the file. Fix the file, then restart the app.",
  problemPlace: (path: string, line?: number) => (line ? `${path}, line ${line}` : path),
  noticeTitle: (count: number) =>
    count === 1 ? "The IT policy file has a problem" : `The IT policy file has ${count} problems`,
  noticeBody: "Settings with a problem are not applied. The rest of the policy is in force.",
  noticeView: "View in Settings",
  noticeDismiss: "Dismiss",
  keyLabel: (key: ManagedPolicySettingKey): string =>
    ({
      allowedProviders: "Allowed providers",
      defaultProvider: "Provider",
      defaultModel: "Model",
      allowedPublicReferences: "Allowed public references",
      appRegistration: "App registration",
      skipFirstRunScan: "Skip first-run model scan",
    })[key],
  none: "None",
  yes: "Yes",
  no: "No",
  registrationLocked:
    "Your IT department set the app registration for sign-in on this device.",
} as const;
