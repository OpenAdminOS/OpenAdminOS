export function TruncatedText({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      className={`min-w-0 truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${className}`}
      tabIndex={0}
      aria-label={value}
      title={value}
    >
      {value}
    </span>
  );
}
