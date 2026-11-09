import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/Button";
import { ServiceMark, serviceLetters } from "../components/ServiceMark";
import { useToast } from "../components/Toast";
import { adminApprovalMessage } from "../components/chat/ChatFirstRun";
import { IconCheck, IconLogo } from "../components/icons";
import { MICROSOFT_STEP_COPY, NOT_CONNECTED_COPY } from "../copy";
import { copyTextToClipboard } from "../shared/clipboard";
import {
  AVAILABLE_SERVICES,
  BASELINE_SCOPES,
  formatServiceList,
  partIdsFor,
  servicePartById,
  type ServiceDefinition,
  type ServiceId,
  type TenantRecord,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { OnboardingSteps } from "./OnboardingSteps";
import { useSetupFlow } from "./SetupFlowContext";
import { connectedServices, type ConnectedService } from "./connected-starters";

/**
 * The second onboarding step, Connect Microsoft 365 (SPEC.md 4a, first
 * launch; mockup 32, section B). The same stage as the model scan: this
 * device in the centre, the Microsoft 365 services on the orbit, dashed
 * until they are connected. Nothing is preselected; the admin picks the
 * services they manage, sees the read-only permissions those need, and
 * signs in through the existing connect flow, or leaves it for later.
 */
export function MicrosoftStepScreen({ firstRun, onClose }: { firstRun: boolean; onClose: (to: string | null) => void }) {
  const api = window.openAdminOS;
  const { state } = useAppState();
  const { openSetupForParts, openOwnRegistration } = useSetupFlow();
  const toast = useToast();
  const reduced = useMemo(prefersReducedMotion, []);
  const activeTenant = state.activeTenantId ? state.tenants.find((tenant) => tenant.id === state.activeTenantId) : undefined;
  // Opened again with a tenant already connected: its services show as connected and stay so.
  const existing = useMemo(() => connectedServices(activeTenant), [activeTenant]);
  const [picked, setPicked] = useState<ReadonlySet<ServiceId>>(() => new Set());
  const [connected, setConnected] = useState<TenantRecord | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // The connected tenant as the app state now has it, so a later refresh is shown too.
  const connectedTenant = connected ? state.tenants.find((tenant) => tenant.id === connected.id) ?? connected : undefined;
  const result = useMemo(() => connectedServices(connectedTenant), [connectedTenant]);
  const shownConnected = connectedTenant ? result : existing;
  const connectedIds = new Set(shownConnected.map((entry) => entry.service.id));
  const pickedIds = AVAILABLE_SERVICES.filter((service) => picked.has(service.id) && !connectedIds.has(service.id)).map((service) => service.id);
  const partIds = partIdsFor(pickedIds);
  // Sign-in scopes are requested only when no tenant is connected yet.
  const needsSignIn = !activeTenant || activeTenant.kind === "sample";

  useEffect(() => {
    headingRef.current?.focus();
  }, [connected]);

  const toggle = (id: ServiceId) => {
    if (connected || connectedIds.has(id)) return;
    setCopyFailed(null);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onConnected = (tenant: TenantRecord) => {
    setConnected(tenant);
    const services = connectedServices(tenant).map((entry) => entry.service.title);
    setAnnouncement(MICROSOFT_STEP_COPY.announceConnected(tenant.displayName, formatServiceList(services) || tenant.displayName));
  };

  const askAdmin = async () => {
    const message = adminApprovalMessage({ reason: "no-tenant", partIds }, undefined);
    setCopyFailed(null);
    try {
      await copyTextToClipboard(message);
      toast.success(NOT_CONNECTED_COPY.askAdminCopied);
    } catch {
      setCopyFailed(message);
    }
  };

  const platform = api?.platform;
  const draggable = platform === "macos" || platform === "windows";

  return (
    <div
      className="scan-screen microsoft-step flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]"
      data-motion={reduced ? "reduced" : "full"}
      data-phase={connected ? "connected" : "choosing"}
    >
      <header
        className={`relative flex h-[52px] shrink-0 items-center gap-2 px-4 ${draggable ? "app-region-drag" : ""} ${platform === "macos" ? "pl-[92px]" : ""}`}
        style={platform === "windows" ? { paddingRight: 140 } : undefined}
      >
        <IconLogo size={21} className="text-[var(--color-text)]" />
        <span className="font-serif text-md font-medium">OpenAdminOS</span>
        <span className="flex-1" />
        {firstRun ? (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-[640px]:hidden">
            <OnboardingSteps current={1} />
          </div>
        ) : null}
      </header>
      <main id="main-content" aria-labelledby="microsoft-step-heading" className="min-h-0 flex-1 overflow-y-auto">
        <div className="scan-grid mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-1 items-center gap-x-8 gap-y-6 px-6 py-6 min-[860px]:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] min-[860px]:px-12 min-[1000px]:gap-x-12">
          <MicrosoftStage picked={new Set(pickedIds)} connected={connectedIds} justConnected={Boolean(connected)} onToggle={toggle} />
          <section className="w-full min-w-0 max-w-[440px] justify-self-center min-[860px]:justify-self-start" aria-labelledby="microsoft-step-heading">
            {connectedTenant ? (
              <ConnectedResult tenant={connectedTenant} services={result} headingRef={headingRef} onOpenChat={() => onClose("/chat")} />
            ) : (
              <div className="scan-rise">
                <h1 id="microsoft-step-heading" ref={headingRef} tabIndex={-1} className="font-serif text-display font-medium focus:outline-none">
                  {MICROSOFT_STEP_COPY.title}
                </h1>
                <p className="mt-3 text-base text-[var(--color-text-soft)]">{MICROSOFT_STEP_COPY.body}</p>
                <fieldset className="mt-5">
                  <legend className="sr-only">{MICROSOFT_STEP_COPY.servicesLabel}</legend>
                  <div className="rounded-lg bg-[var(--color-surface)] p-1 ring-1 ring-inset ring-[var(--color-border-soft)]">
                    {AVAILABLE_SERVICES.map((service) => (
                      <ServiceRow
                        key={service.id}
                        service={service}
                        checked={picked.has(service.id) || connectedIds.has(service.id)}
                        connected={connectedIds.has(service.id)}
                        onToggle={() => toggle(service.id)}
                      />
                    ))}
                  </div>
                </fieldset>
                <Permissions serviceIds={pickedIds} withSignIn={needsSignIn} />
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button variant="primary" size="lg" disabled={partIds.length === 0} onClick={() => openSetupForParts(partIds, { onConnected })}>
                    {MICROSOFT_STEP_COPY.signIn}
                  </Button>
                  <Button variant="secondary" size="lg" disabled={partIds.length === 0} onClick={() => openOwnRegistration(partIds, { onConnected })}>
                    {MICROSOFT_STEP_COPY.ownRegistration}
                  </Button>
                </div>
                <div className="mt-2">
                  <Button variant="ghost" size="sm" disabled={partIds.length === 0} onClick={() => void askAdmin()}>
                    {MICROSOFT_STEP_COPY.askAdmin}
                  </Button>
                </div>
                {copyFailed ? (
                  <div role="alert" className="mt-3 text-sm text-[var(--color-warning)]">
                    <p>{NOT_CONNECTED_COPY.askAdminFailed}</p>
                    <textarea
                      readOnly
                      aria-label="Message for an admin"
                      value={copyFailed}
                      rows={6}
                      className="mt-2 w-full rounded-md bg-[var(--color-bg-raised)] p-2 font-mono text-xs text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]"
                    />
                  </div>
                ) : null}
                <div className="mt-5 border-t border-[var(--color-border-soft)] pt-4">
                  <button type="button" onClick={() => onClose(firstRun ? "/chat" : null)} className={linkClass}>
                    {MICROSOFT_STEP_COPY.notNow}
                  </button>
                  <p className="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">{MICROSOFT_STEP_COPY.notNowNote}</p>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

/** One service as a checkbox row: its mark, name and what it covers. */
function ServiceRow({ service, checked, connected, onToggle }: { service: ServiceDefinition; checked: boolean; connected: boolean; onToggle: () => void }) {
  const id = `microsoft-step-${service.id}`;
  return (
    <label
      htmlFor={id}
      data-service={service.id}
      className={`grid grid-cols-[16px_30px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-3 py-2.5 transition-colors duration-150 ${
        connected ? "cursor-default" : "cursor-pointer hover:bg-[var(--color-hover)] has-[:checked]:bg-[var(--color-active)]"
      }`}
    >
      <span className="relative mt-[7px] h-4 w-4">
        <input id={id} type="checkbox" checked={checked} disabled={connected} onChange={onToggle} className="service-check peer absolute inset-0" />
        <IconCheck size={12} className="pointer-events-none absolute left-[2px] top-[2px] hidden text-[var(--color-bg)] peer-checked:block" />
      </span>
      <ServiceMark service={service.id} title={service.title} size={30} off={!connected} />
      <span className="min-w-0">
        <span className="block text-base font-medium leading-5 text-[var(--color-text)]">{service.title}</span>
        <span className="mt-0.5 block text-sm leading-5 text-[var(--color-text-soft)]">{service.summary}</span>
      </span>
      <span className="pt-px text-xs leading-5 text-[var(--color-text-muted)]">{connected ? MICROSOFT_STEP_COPY.connected : null}</span>
    </label>
  );
}

/** The read-only permissions the picked services need, grouped by service, sign-in last. */
function Permissions({ serviceIds, withSignIn }: { serviceIds: readonly ServiceId[]; withSignIn: boolean }) {
  if (serviceIds.length === 0) {
    return <p className="mt-3 text-sm text-[var(--color-text-muted)]">{MICROSOFT_STEP_COPY.noneYet}</p>;
  }
  const groups = AVAILABLE_SERVICES.filter((service) => serviceIds.includes(service.id)).map((service) => ({
    label: service.title,
    scopes: [...new Set(partIdsFor([service.id]).flatMap((id) => servicePartById(id)?.scopes.map((scope) => scope.name) ?? []))],
  }));
  if (withSignIn) groups.push({ label: NOT_CONNECTED_COPY.signInPart, scopes: [...BASELINE_SCOPES] });
  const count = new Set(groups.flatMap((group) => group.scopes)).size;
  return (
    <section aria-label={NOT_CONNECTED_COPY.permissionsSummary(count)} className="mt-3 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-[var(--color-border-soft)]">
      <p className="text-sm font-medium text-[var(--color-text-soft)]">{NOT_CONNECTED_COPY.permissionsSummary(count)}</p>
      <ul className="mt-2 space-y-1.5">
        {groups.map((group) => (
          <li key={group.label} className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2">
            <span className="text-xs leading-5 text-[var(--color-text-soft)]">{group.label}</span>
            <span className="font-mono text-xs leading-5 text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{group.scopes.join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** After a successful connect: the organization, each connected service with its parts, then Chat. */
function ConnectedResult({
  tenant,
  services,
  headingRef,
  onOpenChat,
}: {
  tenant: TenantRecord;
  services: readonly ConnectedService[];
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onOpenChat: () => void;
}) {
  return (
    <div className="scan-rise">
      <h1 id="microsoft-step-heading" ref={headingRef} tabIndex={-1} className="font-serif text-display font-medium focus:outline-none">
        {MICROSOFT_STEP_COPY.connectedTitle(tenant.displayName)}
      </h1>
      <p className="mt-3 text-base text-[var(--color-text-soft)]">{MICROSOFT_STEP_COPY.connectedBody}</p>
      {services.length > 0 ? (
        <ul aria-label={MICROSOFT_STEP_COPY.connected} className="mt-5 divide-y divide-[var(--color-border-soft)] rounded-lg bg-[var(--color-surface)] px-3 ring-1 ring-inset ring-[var(--color-border-soft)]">
          {services.map(({ service, status, parts }) => (
            <li key={service.id} data-service={service.id} className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 py-3">
              <ServiceMark service={service.id} title={service.title} size={30} />
              <span className="min-w-0">
                <span className="block text-base font-medium leading-5 text-[var(--color-text)]">
                  {status === "partial" ? MICROSOFT_STEP_COPY.partial(service.title) : service.title}
                </span>
                <span className="mt-0.5 block text-sm leading-5 text-[var(--color-text-soft)]">{parts.map((part) => part.title).join(", ")}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {tenant.username ? <p className="mt-3 text-xs text-[var(--color-text-muted)]">{tenant.username}</p> : null}
      <div className="mt-5">
        <Button variant="primary" size="lg" onClick={onOpenChat}>
          {MICROSOFT_STEP_COPY.openChat}
        </Button>
      </div>
    </div>
  );
}

/**
 * The scan's stage with the services on the orbit. A service not connected
 * is a dashed tile; a selected one gets a dashed link to this device; a
 * connected one turns solid and its link draws in. Decorative: the
 * checkboxes are the accessible source.
 */
function MicrosoftStage({
  picked,
  connected,
  justConnected,
  onToggle,
}: {
  picked: ReadonlySet<ServiceId>;
  connected: ReadonlySet<ServiceId>;
  justConnected: boolean;
  onToggle: (id: ServiceId) => void;
}) {
  const count = AVAILABLE_SERVICES.length;
  return (
    <div className="scan-stage relative mx-auto aspect-square w-full select-none" style={{ maxWidth: "min(520px, calc(100vh - 150px))" }} aria-hidden="true">
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100">
        <circle className="scan-orbit" cx="50" cy="50" r="38" />
        <circle className="scan-orbit scan-orbit-inner" cx="50" cy="50" r="22" />
        {AVAILABLE_SERVICES.map((service, index) => {
          const angle = angleOf(index, count);
          const state = connected.has(service.id) ? "connected" : picked.has(service.id) ? "picked" : "off";
          if (state === "off") return null;
          return (
            <line
              key={`${service.id}-${state}`}
              className="ms-link"
              data-state={state}
              data-animate={justConnected ? "true" : "false"}
              x1={50 + 11 * Math.cos(angle)}
              y1={50 + 11 * Math.sin(angle)}
              x2={50 + 31.6 * Math.cos(angle)}
              y2={50 + 31.6 * Math.sin(angle)}
              {...(state === "connected" ? { pathLength: 1 } : {})}
            />
          );
        })}
      </svg>
      <div className="scan-device absolute left-1/2 top-1/2 flex aspect-square w-[20%] items-center justify-center rounded-[27%] bg-[var(--color-accent)]">
        <IconLogo size={44} className="text-[var(--color-on-accent)]" />
      </div>
      {AVAILABLE_SERVICES.map((service, index) => {
        const angle = angleOf(index, count);
        const state = connected.has(service.id) ? "connected" : picked.has(service.id) ? "picked" : "off";
        return (
          <div
            key={service.id}
            className="ms-node absolute flex w-[25%] flex-col items-center text-center"
            style={{ left: `${50 + 38 * Math.cos(angle)}%`, top: `${50 + 38 * Math.sin(angle)}%` }}
            data-service={service.id}
            data-state={state}
            onClick={state === "connected" ? undefined : () => onToggle(service.id)}
          >
            <span className="ms-node-tile flex items-center justify-center font-medium">{serviceLetters(service.id, service.title)}</span>
            <span className="scan-node-plate mt-1.5 flex flex-col items-center rounded-[6px] px-1.5">
              <span className="ms-node-name text-sm font-medium leading-[18px]">{service.title}</span>
              <span className="ms-node-status text-xs leading-4">
                {state === "connected" ? MICROSOFT_STEP_COPY.nodeConnected : state === "picked" ? MICROSOFT_STEP_COPY.nodePicked : MICROSOFT_STEP_COPY.nodeOff}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Services sit at the top and the two lower corners of the orbit. */
function angleOf(index: number, count: number): number {
  return (-90 + (index * 360) / count) * (Math.PI / 180);
}

function prefersReducedMotion(): boolean {
  try {
    return (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
      document.documentElement.hasAttribute("data-reduced-motion")
    );
  } catch {
    return false;
  }
}

const linkClass =
  "rounded-sm text-sm text-[var(--color-text-soft)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:text-[var(--color-text)] hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-60";
