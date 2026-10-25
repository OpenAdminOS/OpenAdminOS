/** The "oa" ligature from docs/mockups/28-logo-explorations.html, concept A. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={7}
      strokeLinecap="round"
    >
      <circle cx="17" cy="32" r="11.5" />
      <circle cx="46" cy="32" r="11.5" />
      <path d="M57.5 20.5v23" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-serif text-[19px] font-medium leading-none tracking-[-0.005em] ${className}`}
    >
      <LogoMark className="h-[22px] w-[22px] shrink-0" />
      OpenAdminOS
    </span>
  );
}
