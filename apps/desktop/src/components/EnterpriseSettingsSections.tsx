import { EnterpriseUiBody, ModuleUiBoundary } from "./EnterpriseUi";
import { useEnterpriseStatus } from "./useEnterpriseStatus";

/**
 * The Settings sections an active team features module registered, each
 * with the title and description it gave. Nothing renders without a valid
 * licence, which is every build from the public repository. A section
 * shows while the search is empty or matches its title or description.
 */
export function EnterpriseSettingsSections({ query }: { query: string }) {
  const status = useEnterpriseStatus();
  if (!status.active) return null;
  const needle = query.trim().toLowerCase();
  const sections = status.settingsSections.filter(
    (section) => needle === "" || section.title.toLowerCase().includes(needle) || section.description.toLowerCase().includes(needle),
  );
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((section) => (
        <section
          key={section.id}
          id={`settings-section-team-${section.id}`}
          data-enterprise-settings-section={section.id}
          aria-labelledby={`settings-heading-team-${section.id}`}
          className="settings-section scroll-mt-5"
        >
          <div className="mb-2 flex min-h-8 items-center">
            <h2 id={`settings-heading-team-${section.id}`} className="text-sm font-medium text-[var(--color-text-muted)]">
              {section.title}
            </h2>
          </div>
          <div className="rounded-[10px] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)]">
            <p>{section.description}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Provided by the team features module.</p>
            {section.body ? (
              <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
                <ModuleUiBoundary key={section.id} resetKey={section.revision ?? 0}>
                  <EnterpriseUiBody sectionId={section.id} body={section.body} revision={section.revision ?? 0} />
                </ModuleUiBoundary>
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </>
  );
}
