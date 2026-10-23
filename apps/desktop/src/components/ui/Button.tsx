import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconPosition?: "leading" | "trailing";
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)]",
  secondary:
    "bg-transparent text-[var(--color-text)] shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-[var(--color-hover)]",
  ghost:
    "bg-transparent text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]",
  danger:
    "bg-[var(--color-danger)] text-[var(--color-on-danger)] hover:bg-[var(--color-danger-hover)]",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-[34px] gap-1.5 rounded-[10px] px-3 text-sm",
  md: "h-[34px] gap-2 rounded-[10px] px-3.5 text-base",
  // Kept for compatibility with the original shared Button API.
  lg: "h-[34px] gap-2 rounded-[10px] px-5 text-md",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconPosition = "leading",
  leadingIcon,
  trailingIcon,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const leading = leadingIcon ?? (iconPosition === "leading" ? icon : undefined);
  const trailing = trailingIcon ?? (iconPosition === "trailing" ? icon : undefined);

  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {leading ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {leading}
        </span>
      ) : null}
      {children}
      {trailing ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
