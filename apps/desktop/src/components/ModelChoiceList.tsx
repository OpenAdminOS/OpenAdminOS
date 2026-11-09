import { useId, type ReactNode } from "react";

import { MODEL_CHOICE_COPY, MODEL_SCAN_COPY } from "../copy";
import { ProviderLogo } from "./ProviderLogo";
import type { ProviderId } from "../shared/openAdminOS";
import type { ChoiceOption } from "../setup/model-choice";

/**
 * One radio group of what can answer in Chat (mockup 32, section B), used
 * by the first-launch scan and by Chat's model choice. Native radios keep
 * arrow-key movement and announcements; a hosted row always says where
 * prompts go, in amber.
 */
export function ModelChoiceList({
  options,
  selected,
  onSelect,
  disabled = false,
  errors = {},
  retrying = null,
  onRetry,
  label = MODEL_CHOICE_COPY.groupLabel,
}: {
  options: readonly ChoiceOption[];
  selected: ProviderId | null;
  onSelect: (id: ProviderId) => void;
  disabled?: boolean;
  /** A failed start or switch, written under its own row. */
  errors?: Readonly<Partial<Record<ProviderId, ReactNode>>>;
  retrying?: ProviderId | null;
  onRetry?: (id: ProviderId) => void;
  label?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="rounded-lg bg-[var(--color-surface)] p-1 ring-1 ring-inset ring-[var(--color-border-soft)]">
      {options.map((option) => {
        const id = `${name}-${option.providerId}`;
        const error = errors[option.providerId];
        return (
          <div key={option.providerId} data-provider={option.providerId}>
            <label
              htmlFor={id}
              className={`grid grid-cols-[16px_20px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-3 py-2.5 transition-colors duration-150 ${
                option.unavailable ? "cursor-default" : "cursor-pointer hover:bg-[var(--color-hover)] has-[:checked]:bg-[var(--color-active)]"
              }`}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.providerId}
                checked={selected === option.providerId}
                disabled={disabled || option.unavailable}
                onChange={() => onSelect(option.providerId)}
                className="model-choice-radio mt-[3px]"
              />
              {/* Decorative: the name is next to it. */}
              <span className="mt-px">
                <ProviderLogo provider={option.providerId} size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-medium leading-5 text-[var(--color-text)]">{option.name}</span>
                <span className={`mt-0.5 block text-sm leading-5 ${option.where === "hosted" && !option.unavailable ? "text-[var(--color-warning)]" : "text-[var(--color-text-soft)]"}`}>
                  {option.whereLine}
                </span>
              </span>
              {option.unavailable && onRetry ? (
                <button
                  type="button"
                  disabled={disabled || retrying !== null}
                  onClick={(event) => {
                    event.preventDefault();
                    onRetry(option.providerId);
                  }}
                  aria-label={MODEL_SCAN_COPY.retryLabel(option.name)}
                  className="rounded-sm px-1.5 text-xs font-medium text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60"
                >
                  {retrying === option.providerId ? MODEL_SCAN_COPY.checking : MODEL_SCAN_COPY.retry}
                </button>
              ) : (
                <span className="pt-px text-xs leading-5 text-[var(--color-text-muted)]">{option.state}</span>
              )}
            </label>
            {error ? (
              <p role="alert" className="px-3 pb-2 pl-[72px] text-xs leading-5 text-[var(--color-danger)]">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
