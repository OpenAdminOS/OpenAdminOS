import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[#1a120c] hover:bg-[var(--color-accent-hover)] shadow-sm",
  secondary:
    "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] ring-1 ring-[var(--color-border)]",
  ghost:
    "bg-transparent text-[var(--color-text-soft)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]",
  danger:
    "bg-[var(--color-danger-soft)] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/20 ring-1 ring-[var(--color-danger)]/30",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] rounded-md gap-1.5",
  md: "h-9 px-3.5 text-[13px] rounded-lg gap-2",
  lg: "h-11 px-5 text-[14px] rounded-lg gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  leadingIcon,
  trailingIcon,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium transition-colors duration-150 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
