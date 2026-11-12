import appleIntelligence from "../assets/provider-logos/apple-intelligence-512.png";
import azureOpenAI from "../assets/provider-logos/azure-openai.svg";
import claudeSpark from "../assets/provider-logos/claude-spark-clay.svg";
import gemini from "../assets/provider-logos/gemini-color-96.png";
import copilotBlack from "../assets/provider-logos/github-copilot-icon-black.svg";
import copilotWhite from "../assets/provider-logos/github-copilot-icon-white.svg";
import lmStudioColor from "../assets/provider-logos/lm-studio-icon-color.svg";
import lmStudioOutlineWhite from "../assets/provider-logos/lm-studio-icon-outline-white.svg";
import lemonade from "../assets/provider-logos/lemonade-logo.svg";
import ollamaBlack from "../assets/provider-logos/ollama-black.svg";
import ollamaWhite from "../assets/provider-logos/ollama-white.svg";
import openAIBlack from "../assets/provider-logos/openai-blossom-black.svg";
import openAIWhite from "../assets/provider-logos/openai-blossom-white.svg";

/**
 * A provider's mark: the vendor's own logo, unmodified, in the variant it
 * provides for light and for dark surfaces, or its single official file
 * on both (sources in `assets/provider-logos/NOTICE.md`). `scale` renders
 * a file whose artwork carries its own clear space larger, so every mark
 * reads at the same optical size; the file itself is never cropped.
 */
interface Logo {
  light: string;
  dark: string;
  scale?: number;
}

const LOGOS: Readonly<Partial<Record<string, Logo>>> = {
  ollama: { light: ollamaBlack, dark: ollamaWhite },
  "lm-studio": { light: lmStudioColor, dark: lmStudioOutlineWhite },
  lemonade: { light: lemonade, dark: lemonade },
  "apple-foundation": { light: appleIntelligence, dark: appleIntelligence, scale: 1.12 },
  anthropic: { light: claudeSpark, dark: claudeSpark, scale: 0.92 },
  // The Blossom fills about half of its canvas.
  openai: { light: openAIBlack, dark: openAIWhite, scale: 1.8 },
  copilot: { light: copilotBlack, dark: copilotWhite },
  gemini: { light: gemini, dark: gemini },
  "azure-openai": { light: azureOpenAI, dark: azureOpenAI },
};

/** Every provider OpenAdminOS knows has its logo; only an unknown one shows a neutral mark. */
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
    const style = logo.scale ? { transform: `scale(${logo.scale})` } : undefined;
    return (
      <span {...a11y} data-provider-logo={provider} data-kind="logo" className="provider-logo inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        {logo.light === logo.dark ? (
          <img src={logo.light} alt="" draggable={false} className="h-full w-full object-contain" style={style} />
        ) : (
          <>
            <img src={logo.light} alt="" draggable={false} className="provider-logo-light h-full w-full object-contain" style={style} />
            <img src={logo.dark} alt="" draggable={false} className="provider-logo-dark h-full w-full object-contain" style={style} />
          </>
        )}
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
      {provider.slice(0, 2)}
    </span>
  );
}

const MARK_INNER: Readonly<Record<"sm" | "md" | "lg", number>> = { sm: 12, md: 15, lg: 20 };

/**
 * A provider's logo on the same quiet tile as a service or reference mark
 * (#174's reach map and connection rows), at the sm, md and lg tile sizes.
 */
export function ProviderMark({ provider, size = "md", label }: { provider: string; size?: "sm" | "md" | "lg"; label?: string }) {
  return (
    <span className="svc-mark" data-service="provider" data-size={size} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <ProviderLogo provider={provider} size={MARK_INNER[size]} />
    </span>
  );
}

