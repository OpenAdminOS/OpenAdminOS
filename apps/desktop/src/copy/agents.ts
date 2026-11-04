export const AGENT_COPY = {
  readAction: "Run",
  writeAction: "Review",
  readMode: "Read-only",
  writeMode: "Write",
  writeReview: "Always review changes",
  invalidBadge: "Unavailable",
  invalidTitle: "Manifest is invalid",
  invalidBody: (name: string) =>
    `${name} cannot run or be scheduled until its manifest passes validation.`,
  invalidRowHint: "Unavailable. The manifest is invalid.",
  invalidBundledHint: "This manifest ships with OpenAdminOS. Update the app to replace it.",
  invalidUpdateHint:
    "This manifest came from an agent update. Uninstall the agent, then install it again from Agent Hub.",
  invalidEditAction: "Edit manifest",
  invalidUninstallAction: "Uninstall",
} as const;
