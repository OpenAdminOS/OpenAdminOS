import { useId, useState } from "react";
import { PROVIDER_DETECTION_COPY } from "../../copy";
import type { ProviderId, ProviderSummary } from "../../shared/openAdminOS";
import { Button } from "../Button";
import { IconCloud } from "../icons";

/**
 * Hosted providers that are ready on this device while no local provider
 * is. Shown first so a signed-in CLI is one click away, but never selected
 * on the user's behalf: each row carries the provider's own data-residency
 * line and selecting it is always the user's action.
 */
export function DetectedHostedProviders({
  providers,
  onSelect,
  className = "",
}: {
  providers: readonly ProviderSummary[];
  onSelect: (id: ProviderId) => void | Promise<void>;
  className?: string;
}) {
  const [selecting, setSelecting] = useState<ProviderId | null>(null);
  const headingId = useId();
  if (providers.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={className}>
      <h3 id={headingId} className="text-sm font-medium text-[var(--color-text)]">
        {PROVIDER_DETECTION_COPY.detectedLabel}
      </h3>
      <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">
        {PROVIDER_DETECTION_COPY.detectedHostedNote}
      </p>
      <ul className="mt-3 space-y-2">
        {providers.map((provider) => (
          <li
            key={provider.id}
            className="flex flex-wrap items-start gap-3 rounded-xl bg-[var(--color-surface)] px-4 py-3 ring-1 ring-[var(--color-border-soft)]"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-soft)] text-[var(--color-info)]">
              <IconCloud size={15} />
            </span>
            <span className="min-w-[180px] flex-1">
              <span className="block text-base font-medium text-[var(--color-text)]">{provider.name}</span>
              <span className="mt-1 block text-sm leading-5 text-[var(--color-text-soft)]">{provider.description}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={selecting !== null}
              onClick={() => {
                setSelecting(provider.id);
                // The caller's selection path reports its own errors
                // (app state error or the setup dialog alert).
                void Promise.resolve(onSelect(provider.id))
                  .catch(() => undefined)
                  .finally(() => setSelecting(null));
              }}
            >
              {PROVIDER_DETECTION_COPY.useDetected(provider.name)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
