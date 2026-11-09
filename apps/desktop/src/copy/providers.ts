export const PROVIDER_DETECTION_COPY = {
  /** Label above hosted providers found ready on this device. */
  detectedLabel: "Detected on this device",
  /**
   * Explains why a detected hosted provider is not selected on its own.
   * The per-provider description carries the data-residency line.
   */
  detectedHostedNote:
    "Hosted providers are never selected automatically. Select one to send tenant context to it.",
  useDetected: (providerName: string) => `Use ${providerName}`,
  /** One-time Chat notice after a local provider was selected automatically. */
  autoSelectedNotice: (providerName: string) =>
    `Using ${providerName} on this device. Change it in Settings.`,
  autoSelectedNoticeDismiss: "Dismiss",
  autoSelectedNoticeSettings: "Open provider settings",
} as const;

/** The first-launch model scan (SPEC.md 4a, first launch). */
export const MODEL_SCAN_COPY = {
  title: "Looking for models on this device",
  titleDone: "What this device can answer with",
  subtitle:
    "OpenAdminOS looks for local model runtimes and AI tools you are already signed in to. It reads local files and ports, and runs each tool's own version and sign-in status command, which may check the sign-in with its provider. No prompt is sent to any model.",
  listHeading: "On this device",
  progress: (done: number, total: number) => (total === 0 ? "Starting" : `${done} of ${total} checked`),
  checking: "checking",
  couldNotCheck: "Could not check",
  retry: "Retry",
  retryLabel: (name: string) => `Check ${name} again`,
  announce: (name: string, summary: string) => `${name}: ${summary}.`,
  finishedAnnouncement: (outcome: string) => `Scan finished. ${outcome}`,
  ledger: (targets: readonly string[]) =>
    `Checked here: ${targets.join(", ")}. A tool's own sign-in status command may check with its provider. No prompt was sent to any model.`,
  localTitle: (model: string) => `${model} is ready on this device`,
  hostedReady: (name: string) => `${name} is signed in on this device`,
  availableTitle: (model: string) => `${model} is ready on this device, not selected`,
  availableLine: (runtime: string, selected: string) =>
    `It runs in ${runtime}. Chat keeps answering with ${selected}, your choice, until you switch.`,
  keepSelected: (name: string) => `Keep ${name}`,
  installedTitle: (name: string) => `${name} is installed on this device`,
  heroLead: (kind: "local" | "switch" | "hosted" | "start" | "nothing") =>
    kind === "switch"
      ? "Found on this device"
      : kind === "local"
      ? "Ready on this device"
      : kind === "hosted"
        ? "Signed in on this device"
        : kind === "start"
          ? "Installed, not running"
          : "Nothing to answer with yet",
  localLine: (runtime: string) => `Runs in ${runtime}. Chat answers with it from now on.`,
  hostedLine: "It is not selected until you choose it, because prompts leave this device when it answers.",
  hostedWhereNamed: (name: string, location: string) => `${name}: prompts go to ${location}`,
  keepLocal: (name: string) => `To keep everything on this device, start ${name}.`,
  installedLine: "Start it to answer on this device. OpenAdminOS runs the start command for you and checks it again.",
  nothingShort: "No model yet",
  start: (name: string) => `Start ${name}`,
  starting: (name: string) => `Starting ${name}`,
  startingShort: "Starting",
  started: (name: string) => `${name} started.`,
  startFailed: (name: string) => `${name} did not start. Start it yourself, then scan again.`,
  skip: "Skip",
  localBody: (model: string, runtime: string) => `Chat answers with ${model} in ${runtime}. You can change the model at any time.`,
  nothingLeaves: "Nothing leaves this device.",
  openChat: "Open Chat",
  hostedTitle: "A signed-in AI tool was found",
  hostedBody:
    "It is not selected for you, because prompts would leave this device. Choose it to answer with it, or keep everything local.",
  hostedWhere: (location: string) => `Prompts go to ${location}`,
  useHosted: (name: string) => `Use ${name}`,
  keepLocalPrefix: "To keep everything on this device,",
  setUpOpenAdmin: "set up OpenAdmin 8B",
  continueWithoutModel: "Continue to Chat without a model",
  nothingTitle: "No model found on this device",
  nothingBody: "Install Ollama, then run this command to get OpenAdmin 8B, a model trained for Intune and Entra work:",
  nothingRunningBody: (runtime: string) => `${runtime} is installed but not running. Start it, or get OpenAdmin 8B with:`,
  installCommand: "ollama run openadminos/openadmin-8b",
  setUpOpenAdminAction: "Set up OpenAdmin 8B",
  allProviders: "Show all providers",
  scanAgain: "Scan again",
  continueToChat: "Continue to Chat",
  scanFailed: "The scan did not start.",
  previewPrefix: "Not ready to set up a model?",
  previewLink: "Preview with sample data",
  previewSuffix: "from a fictional company.",
  previewFailed: (reason: string) => `Sample data did not open. ${reason}`,
} as const;
