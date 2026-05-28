import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { IconChevronDown, IconCloud, IconHardDrive, IconPlay } from "./icons";
import { isProviderImplemented } from "../shared/providers";
import type { ProviderId, ProviderSummary } from "../shared/openAdminOS";

interface RunWithChoice {
  providerId?: ProviderId;
  model?: string;
}

/**
 * Split button next to "Run agent". The primary click runs with the
 * globally-active provider and the resolved-default model (agent's
 * preferred → user's pinned → provider's first). The chevron opens a
 * menu so the user can pin this single run to a different provider or
 * a specific model within a provider.
 *
 * Hidden entirely when only one implemented provider with one (or
 * zero) installed model exists — there's nothing to pick.
 */
export function RunWithMenu({
  providers,
  activeProviderId,
  activeModelByProviderId,
  onRun,
  disabled = false,
}: {
  providers: ProviderSummary[];
  activeProviderId: ProviderId;
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  onRun: (choice?: RunWithChoice) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const implemented = providers.filter((p) => isProviderImplemented(p.id));
  const totalChoices = implemented.reduce(
    (acc, provider) => acc + Math.max(1, (provider.models ?? []).length),
    0,
  );

  // No menu when there's nothing meaningful to pick.
  if (totalChoices <= 1) {
    return (
      <Button
        variant="primary"
        size="md"
        leadingIcon={<IconPlay size={12} />}
        onClick={() => onRun()}
        disabled={disabled}
      >
        Run agent
      </Button>
    );
  }

  return (
    <div ref={ref} className="relative inline-flex">
      <Button
        variant="primary"
        size="md"
        leadingIcon={<IconPlay size={12} />}
        onClick={() => onRun()}
        disabled={disabled}
        className="!rounded-r-none !pr-3"
      >
        Run agent
      </Button>
      <Button
        variant="primary"
        size="md"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Run with a specific provider or model"
        className="!rounded-l-none !border-l !border-[var(--color-bg)]/30 !px-2"
      >
        <IconChevronDown size={11} />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[320px] overflow-hidden rounded-xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale"
        >
          <button
            onClick={() => {
              onRun();
              setOpen(false);
            }}
            className="flex w-full items-start gap-3 border-b border-[var(--color-border-soft)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <span className="mt-0.5">
              <IconPlay size={12} className="text-[var(--color-accent)]" />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12.5px] font-medium text-[var(--color-text)]">
                Run with current defaults
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
                Active provider · agent's preferred model when installed
              </span>
            </span>
          </button>

          <div className="max-h-[360px] overflow-y-auto py-1">
            {providers.map((provider) => {
              const enabled = isProviderImplemented(provider.id);
              const isActive = provider.id === activeProviderId;
              const models = provider.models ?? [];
              const pinnedModel = activeModelByProviderId?.[provider.id];

              return (
                <div
                  key={provider.id}
                  className="border-b border-[var(--color-border-soft)] last:border-b-0"
                >
                  <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    {provider.isLocal ? (
                      <IconHardDrive
                        size={11}
                        className="text-[var(--color-success)]"
                      />
                    ) : (
                      <IconCloud size={11} className="text-[var(--color-info)]" />
                    )}
                    <span>{provider.name}</span>
                    {isActive && enabled && (
                      <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-accent)]">
                        active
                      </span>
                    )}
                    {!enabled && (
                      <span className="rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-muted)]">
                        soon
                      </span>
                    )}
                  </div>

                  {!enabled ? (
                    <div className="px-3 pb-2 text-[11px] text-[var(--color-text-muted)]">
                      Coming soon
                    </div>
                  ) : models.length === 0 ? (
                    <div className="px-3 pb-2 text-[11px] text-[var(--color-text-muted)]">
                      No models installed
                    </div>
                  ) : (
                    <div className="pb-1">
                      {models.map((model) => {
                        const isPinned = model === pinnedModel;
                        return (
                          <button
                            key={model}
                            onClick={() => {
                              onRun({ providerId: provider.id, model });
                              setOpen(false);
                            }}
                            className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                          >
                            <span
                              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                                isPinned
                                  ? "bg-[var(--color-accent)]"
                                  : "bg-[var(--color-text-muted)]/40"
                              }`}
                            />
                            <span className="min-w-0 flex-1 font-mono text-[11.5px] text-[var(--color-text-soft)]">
                              {model}
                            </span>
                            {isPinned && (
                              <span className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--color-accent)]">
                                default
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
