import type { ReactNode } from "react";
import { IconCloud, IconShield } from "./icons";

type TrustBannerVariant = "local" | "hosted";

interface TrustBannerProps {
  variant: TrustBannerVariant;
  title: string;
  children: ReactNode;
}

export function TrustBanner({ variant, title, children }: TrustBannerProps) {
  const isLocal = variant === "local";
  const wrapperClass = isLocal
    ? "border border-[var(--color-success)]/25 bg-[var(--color-success-soft)]"
    : "border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)]";
  const titleClass = isLocal
    ? "text-[var(--color-success)]"
    : "text-[var(--color-warning)]";
  const iconClass = isLocal
    ? "text-[var(--color-success)]"
    : "text-[var(--color-warning)]";

  return (
    <div
      className={`flex items-start gap-3 rounded-xl px-4 py-3 ${wrapperClass}`}
    >
      <div className={`mt-0.5 ${iconClass}`}>
        {isLocal ? <IconShield size={16} /> : <IconCloud size={16} />}
      </div>
      <div className="text-[12.5px] leading-relaxed text-[var(--color-text)]">
        <strong className={`font-medium ${titleClass}`}>{title}</strong>{" "}
        {children}
      </div>
    </div>
  );
}
