import type { ReactNode } from "react";
import {
  Badge,
  StatusDot as UiStatusDot,
  type BadgeTone,
  type StatusDotTone,
} from "./ui";

type Tone = "default" | "accent" | "success" | "warning" | "danger" | "info" | "think";
type LegacyDotTone = "success" | "warning" | "danger" | "info" | "muted";

const toneMap: Record<Tone, BadgeTone> = {
  default: "neutral",
  accent: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  think: "think",
};

export function Pill({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return <Badge tone={toneMap[tone]} className={className}>{children}</Badge>;
}

export function StatusDot({
  tone = "success",
  className = "",
}: {
  tone?: LegacyDotTone;
  className?: string;
}) {
  const dotToneMap: Record<LegacyDotTone, StatusDotTone> = {
    success: "success",
    warning: "warning",
    danger: "danger",
    info: "info",
    muted: "neutral",
  };
  return <UiStatusDot tone={dotToneMap[tone]} className={className} />;
}
