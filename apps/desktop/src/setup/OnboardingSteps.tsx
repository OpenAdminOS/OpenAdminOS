import { ONBOARDING_COPY } from "../copy";
import { IconCheck } from "../components/icons";

/**
 * "1 Model, 2 Microsoft 365" in the header of both onboarding steps on
 * first launch. Not shown when either step is opened again later.
 */
export function OnboardingSteps({ current }: { current: 0 | 1 }) {
  return (
    <ol aria-label={ONBOARDING_COPY.stepsLabel} className="onboarding-steps flex items-center gap-2 text-sm">
      {ONBOARDING_COPY.steps.map((label, index) => {
        const state = index < current ? "done" : index === current ? "current" : "next";
        return (
          <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true" className="onboarding-step-rule h-px w-6" /> : null}
            <span aria-hidden="true" className="onboarding-step-mark flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums">
              {state === "done" ? <IconCheck size={11} /> : index + 1}
            </span>
            <span className="onboarding-step-label">
              {label}
              {state === "done" ? <span className="sr-only">, {ONBOARDING_COPY.done}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
