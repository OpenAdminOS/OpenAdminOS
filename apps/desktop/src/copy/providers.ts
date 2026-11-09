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

/**
 * What each provider is called wherever the admin chooses a model. For a
 * CLI tool the name is the tool; where prompts go is the provider, on its
 * own line ("Claude Code", "Prompts go to Anthropic API · US").
 */
export const PROVIDER_TOOL_NAMES: Readonly<Partial<Record<string, string>>> = {
  ollama: "Ollama",
  "lm-studio": "LM Studio",
  "apple-foundation": "Apple Intelligence",
  anthropic: "Claude Code",
  openai: "Codex",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
  "azure-openai": "Azure OpenAI",
};

/** The choice of what answers in Chat, shared by the scan and Chat (mockup 32, section B). */
export const MODEL_CHOICE_COPY = {
  groupLabel: "What answers in Chat",
  ready: "Ready",
  notRunning: "Not running",
  noModel: "No model yet",
  notInstalled: "Not installed",
  signedIn: "Signed in",
  notSignedIn: "Not signed in",
  installed: "Installed",
  configured: "Configured",
  couldNotCheck: "Could not check",
  couldNotCheckLine: (name: string) => `${name} did not answer. Retry to check it again.`,
  localReady: (model: string | undefined) => (model ? `On this device. Answers with ${model}.` : "On this device."),
  localStart: (id: string) =>
    id === "lm-studio" ? "On this device. OpenAdminOS starts its server." : "On this device. OpenAdminOS starts it for you.",
  localGetModel: "On this device. Get OpenAdmin 8B, a model trained for Intune and Entra work.",
  localLoadModel: "On this device. Load a model in LM Studio, then scan again.",
  hostedWhere: (location: string) => `Prompts go to ${location}`,
  chooseModel: "Choose a model",
  openChat: "Open Chat",
  use: (name: string) => `Use ${name}`,
  startAndOpen: (name: string) => `Start ${name} and open Chat`,
  getOpenAdmin: "Get OpenAdmin 8B",
  getOpenAdminNote: "Shows the one command that downloads it with Ollama.",
  scanAgain: "Scan again",
  keepsRunning: (name: string) => `${name} keeps running after you quit OpenAdminOS.`,
  usesSignIn: (name: string) => `Uses your ${name} sign-in. No API key is stored.`,
  usesAzure: "Uses the Azure OpenAI settings saved on this device.",
} as const;

/** The first-launch model scan (SPEC.md 4a, first launch). */
export const MODEL_SCAN_COPY = {
  title: "Looking for models on this device",
  subtitle:
    "Checks the model runtimes and AI tools on this device, and whether you are signed in to them. Nothing is sent to a model.",
  found: (found: number, total: number) => `${found} of ${total} found on this device`,
  chooseTitle: "Choose what answers in Chat",
  chooseBody: "Models on this device keep prompts here. Signed-in tools send prompts to their provider.",
  whatRan: "What ran",
  whatRanDetail:
    "It read local files and loopback ports and ran each tool's version command; for Claude Code and Codex also their sign-in status command, which may check the sign-in with the provider.",
  listHeading: "On this device",
  progress: (done: number, total: number) => (total === 0 ? "Starting" : `${done} of ${total} checked`),
  checking: "checking",
  couldNotCheck: "Could not check",
  retry: "Retry",
  retryLabel: (name: string) => `Check ${name} again`,
  announce: (name: string, summary: string) => `${name}: ${summary}.`,
  finishedAnnouncement: (outcome: string) => `Scan finished. ${outcome}`,
  ledger: (targets: readonly string[], notContacted: readonly string[] = []) =>
    `What ran: ${targets.join("; ")}.${notContacted.length > 0 ? ` Not contacted, set outside this device: ${notContacted.join("; ")}.` : ""} The Claude Code and Codex sign-in status commands may check with their provider. No prompt was sent to any model.`,
  localTitle: (model: string) => `${model} is ready on this device`,
  starting: (name: string) => `Starting ${name}`,
  startingShort: "Starting",
  started: (name: string) => `${name} started. It keeps running after you quit OpenAdminOS.`,
  localWithReferences: (toolQueries: string) => `Runs on this device. Your references get ${toolQueries}.`,
  startFailed: (name: string) => `${name} did not start. Start it yourself, then scan again.`,
  skip: "Skip scan",
  localBody: (model: string, runtime: string) => `Chat answers with ${model} in ${runtime}. You can change the model at any time.`,
  nothingLeaves: "Nothing leaves this device.",
  openChat: "Open Chat",
  hostedTitle: "A signed-in AI tool was found",
  hostedBody:
    "It is not selected for you, because prompts would leave this device. Choose it to answer with it, or keep everything local.",
  continueWithoutModel: "Continue without a model",
  nothingTitle: "No model on this device yet",
  nothingBody: "Install Ollama, then run this command to get OpenAdmin 8B, a model trained for Intune and Entra work:",
  nothingRunningBody: (runtime: string) => `${runtime} is installed but not running. Start it, or get OpenAdmin 8B with:`,
  installCommand: "ollama run openadminos/openadmin-8b",
  allProviders: "Show all providers",
  scanAgain: "Scan again",
  continueToChat: "Continue to Chat",
  scanFailed: "The scan did not start.",
  previewLink: "Preview with sample data",
  previewFailed: (reason: string) => `Sample data did not open. ${reason}`,
} as const;
