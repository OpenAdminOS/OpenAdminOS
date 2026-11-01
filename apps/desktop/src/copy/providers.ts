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
