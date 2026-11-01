import { useState, type ReactNode } from "react";

import { Button } from "../components/Button";
import { IconArrowRight, IconCheck, IconLogo } from "../components/icons";
import { WELCOME_COPY } from "../copy";
import { useSetupFlow } from "./SetupFlowContext";

/**
 * First-launch welcome. Shown full window when no tenant exists, so the
 * first decision is pilot mode or production, not a sign-in prompt.
 */
export function WelcomeView({
  onStartPilot,
  onConnect,
  onOwnRegistration,
  onSkip,
}: {
  onStartPilot: () => Promise<void>;
  onConnect: () => void;
  onOwnRegistration: () => void;
  onSkip: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const platform = window.openAdminOS?.platform;
  const draggable = platform === "macos" || platform === "windows";

  const startPilot = () => {
    setStarting(true);
    setError(null);
    void onStartPilot()
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setStarting(false));
  };

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header
        className={`flex h-[52px] shrink-0 items-center gap-2 px-4 ${draggable ? "app-region-drag" : ""} ${platform === "macos" ? "pl-[92px]" : ""}`}
        style={platform === "windows" ? { paddingRight: 140 } : undefined}
      >
        <IconLogo size={21} className="text-[var(--color-text)]" />
        <span className="font-semibold tracking-[-0.01em]">OpenAdminOS</span>
      </header>
      <main
        id="main-content"
        aria-labelledby="welcome-heading"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center px-6 py-10">
          <h1
            id="welcome-heading"
            className="font-serif text-display font-medium tracking-[-0.015em] text-[var(--color-text)]"
          >
            {WELCOME_COPY.title}
          </h1>
          <p className="mt-2 text-md leading-6 text-[var(--color-text-muted)]">
            {WELCOME_COPY.subtitle}
          </p>

          <div className="mt-8 grid grid-cols-1 gap-4 min-[760px]:grid-cols-2">
            <section
              aria-labelledby="welcome-pilot-heading"
              className="flex flex-col rounded-2xl bg-[var(--color-surface)] p-6 ring-1 ring-[var(--color-accent)]/35 shadow-[var(--shadow-soft)]"
            >
              <h2 id="welcome-pilot-heading" className="text-lg font-medium text-[var(--color-text)]">
                {WELCOME_COPY.pilotTitle}
              </h2>
              <p className="mt-2 text-base leading-6 text-[var(--color-text-soft)]">
                {WELCOME_COPY.pilotBody}
              </p>
              <ul className="mt-4 space-y-2 text-sm text-[var(--color-text-soft)]">
                {WELCOME_COPY.pilotBullets.map((bullet) => (
                  <li key={bullet} className="flex items-center gap-2">
                    <IconCheck size={12} className="shrink-0 text-[var(--color-success)]" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-6">
                <Button
                  variant="primary"
                  data-autofocus
                  disabled={starting}
                  onClick={startPilot}
                  trailingIcon={<IconArrowRight size={12} />}
                >
                  {starting ? WELCOME_COPY.pilotStarting : WELCOME_COPY.pilotAction}
                </Button>
              </div>
            </section>

            <section
              aria-labelledby="welcome-connect-heading"
              className="flex flex-col rounded-2xl bg-[var(--color-surface)] p-6 ring-1 ring-[var(--color-border-soft)] shadow-[var(--shadow-soft)]"
            >
              <h2 id="welcome-connect-heading" className="text-lg font-medium text-[var(--color-text)]">
                {WELCOME_COPY.connectTitle}
              </h2>
              <p className="mt-2 text-base leading-6 text-[var(--color-text-soft)]">
                {WELCOME_COPY.connectBody}
              </p>
              <div className="mt-auto pt-6">
                <Button
                  variant="secondary"
                  disabled={starting}
                  onClick={onConnect}
                  trailingIcon={<IconArrowRight size={12} />}
                >
                  {WELCOME_COPY.connectAction}
                </Button>
              </div>
              <button
                type="button"
                onClick={onOwnRegistration}
                disabled={starting}
                className="mt-4 self-start rounded text-left text-sm text-[var(--color-text-muted)] underline underline-offset-2 hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                {WELCOME_COPY.ownRegistrationLink}
              </button>
            </section>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
            >
              {WELCOME_COPY.pilotFailed} {error}
            </div>
          ) : null}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-text-muted)]">
            <span>{WELCOME_COPY.footer}</span>
            <button
              type="button"
              onClick={onSkip}
              disabled={starting}
              className="rounded px-1 font-medium text-[var(--color-text-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {WELCOME_COPY.skip}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** Shows the welcome view while it is open, the app otherwise. */
export function FirstLaunchWelcome({ children }: { children: ReactNode }) {
  const { welcomeOpen, startPilot, openSetup, openOwnRegistration, dismissWelcome } =
    useSetupFlow();
  if (!welcomeOpen) return <>{children}</>;
  return (
    <WelcomeView
      onStartPilot={startPilot}
      onConnect={openSetup}
      onOwnRegistration={openOwnRegistration}
      onSkip={dismissWelcome}
    />
  );
}
