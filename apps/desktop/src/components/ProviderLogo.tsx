import copilotBlack from "../assets/provider-logos/github-copilot-icon-black.svg";
import copilotWhite from "../assets/provider-logos/github-copilot-icon-white.svg";
import lmStudioColor from "../assets/provider-logos/lm-studio-icon-color.svg";
import lmStudioOutlineWhite from "../assets/provider-logos/lm-studio-icon-outline-white.svg";
import ollamaBlack from "../assets/provider-logos/ollama-black.svg";
import ollamaWhite from "../assets/provider-logos/ollama-white.svg";

/**
 * A provider's mark (see `assets/provider-logos/NOTICE.md`). The vendor's
 * own logo, in the variant it provides for light and for dark surfaces,
 * where its guidelines allow a third party to show it to identify an
 * integration; a neutral two-letter mark otherwise (Claude Code, Codex,
 * Gemini CLI, Azure OpenAI, Apple Intelligence). Logos are never recoloured,
 * cropped or given effects.
 */
const LOGOS: Readonly<Partial<Record<string, { light: string; dark: string }>>> = {
  ollama: { light: ollamaBlack, dark: ollamaWhite },
  "lm-studio": { light: lmStudioColor, dark: lmStudioOutlineWhite },
  copilot: { light: copilotBlack, dark: copilotWhite },
};

const MONOGRAMS: Readonly<Partial<Record<string, string>>> = {
  ollama: "Ol",
  "lm-studio": "LM",
  "apple-foundation": "Ai",
  anthropic: "Cc",
  openai: "Cx",
  copilot: "Gh",
  gemini: "Ge",
  "azure-openai": "Az",
};

/** Whether a provider shows its vendor's logo or a neutral mark. */
export function providerLogoKind(provider: string): "logo" | "neutral" {
  return LOGOS[provider] ? "logo" : "neutral";
}

export function ProviderLogo({
  provider,
  size = 20,
  label,
}: {
  provider: string;
  size?: number;
  /** Only when no visible name sits next to the mark: the provider name as its accessible label. */
  label?: string;
}) {
  const logo = LOGOS[provider];
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (logo) {
    return (
      <span {...a11y} data-provider-logo={provider} data-kind="logo" className="provider-logo inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <img src={logo.light} alt="" draggable={false} className="provider-logo-light h-full w-full object-contain" />
        <img src={logo.dark} alt="" draggable={false} className="provider-logo-dark h-full w-full object-contain" />
      </span>
    );
  }
  return (
    <span
      {...a11y}
      data-provider-logo={provider}
      data-kind="neutral"
      className="provider-logo-neutral inline-flex shrink-0 items-center justify-center font-semibold"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.45)), borderRadius: Math.round(size * 0.28) }}
    >
      {MONOGRAMS[provider] ?? provider.slice(0, 2)}
    </span>
  );
}
