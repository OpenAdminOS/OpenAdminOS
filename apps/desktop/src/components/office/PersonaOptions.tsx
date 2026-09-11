import { Link } from "react-router";
import type { AppState, OfficePersonaInput } from "../../shared/openAdminOS";

export const TEAM_ROLES = [
  {
    name: "Policy Watcher",
    slugs: ["compliance-overview"],
    description:
      "Watch the noncompliant-device count and bring findings for review.",
    metric: "counts.noncompliant",
    avatar: "fox",
    color: "sage",
  },
  {
    name: "Chief of Staff",
    slugs: ["compliance-overview", "team-evidence-review"],
    description:
      "Assess device compliance and delegate changed findings for evidence review.",
    metric: "counts.noncompliant",
    avatar: "robot",
    color: "amber",
  },
  {
    name: "Research Bot",
    slugs: ["team-evidence-review"],
    description: "Investigate evidence handed over by another persona.",
    avatar: "owl",
    color: "blue",
  },
  {
    name: "Script Bot",
    slugs: ["team-script-draft"],
    description:
      "Draft PowerShell from supplied evidence for human review. Never execute it.",
    avatar: "cat",
    color: "lilac",
  },
] as const;
export function PersonaOptions({
  form,
  change,
  state,
}: {
  form: OfficePersonaInput;
  change: <K extends keyof OfficePersonaInput>(
    key: K,
    value: OfficePersonaInput[K],
  ) => void;
  state: AppState;
}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="team-options">
      <label>
        Planning
        <select
          value={form.planning ?? "ordered"}
          onChange={(e) =>
            change("planning", e.target.value as OfficePersonaInput["planning"])
          }
        >
          <option value="ordered">Run the approved work order</option>
          <option value="on-change">
            Skip later tasks when the scheduled assessment is unchanged
          </option>
          <option value="model">
            Chief of Staff selects relevant assigned tasks on handoff
          </option>
        </select>
      </label>
      <label>
        Standing instructions
        <textarea
          maxLength={2000}
          value={form.instructions ?? ""}
          onChange={(e) => change("instructions", e.target.value)}
          placeholder="Prioritize newly changed findings; explain missing evidence…"
        />
      </label>
      <small>
        These instructions accompany evidence-aware tasks and persona questions.
        They do not grant tools or bypass approvals.
      </small>
      <label>
        Watch another persona
        <select
          value={form.watch?.personaId ?? ""}
          onChange={(e) =>
            change(
              "watch",
              e.target.value
                ? {
                    personaId: e.target.value,
                    event: "changed",
                    cooldownMinutes: 60,
                  }
                : undefined,
            )
          }
        >
          <option value="">No event trigger</option>
          {(state.office?.personas ?? [])
            .filter((p) => p.id !== form.id && p.tenantId === form.tenantId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      {form.watch && (
        <>
          <div className="office-form-row">
            <label>
              When
              <select
                value={form.watch.event}
                onChange={(e) =>
                  change("watch", {
                    ...form.watch!,
                    event: e.target.value as "new" | "changed" | "threshold",
                    threshold: e.target.value === "threshold" ? 1 : undefined,
                  })
                }
              >
                <option value="changed">A finding changes</option>
                <option value="new">A first finding appears</option>
                <option value="threshold">Metric reaches a threshold</option>
              </select>
            </label>
            <label>
              Cooldown (minutes)
              <input
                type="number"
                min={5}
                max={10080}
                value={form.watch.cooldownMinutes}
                onChange={(e) =>
                  change("watch", {
                    ...form.watch!,
                    cooldownMinutes: Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          {form.watch.event === "threshold" && (
            <label>
              Trigger threshold
              <input
                type="number"
                value={form.watch.threshold ?? 1}
                onChange={(e) =>
                  change("watch", {
                    ...form.watch!,
                    threshold: Number(e.target.value),
                  })
                }
              />
            </label>
          )}
          <small>
            The source finding and its evidence will be supplied to this
            persona’s provider. Only fresh, open findings trigger work; repeated
            revisions are deduplicated.
          </small>
        </>
      )}
      <details>
        <summary>Assessment and schedule options</summary>
        <label>
          Metric field in workflow result
          <input
            value={form.assessment?.metricPath ?? ""}
            placeholder="counts.noncompliant"
            onChange={(e) =>
              change(
                "assessment",
                e.target.value
                  ? {
                      metricPath: e.target.value,
                      threshold: form.assessment?.threshold ?? 1,
                    }
                  : undefined,
              )
            }
          />
        </label>
        {form.assessment && (
          <label>
            Flag at or above
            <input
              type="number"
              value={form.assessment.threshold}
              onChange={(e) =>
                change("assessment", {
                  ...form.assessment!,
                  threshold: Number(e.target.value),
                })
              }
            />
          </label>
        )}
        <label className="office-check">
          <input
            type="checkbox"
            checked={Boolean(form.calendar)}
            onChange={(e) =>
              change(
                "calendar",
                e.target.checked
                  ? { time: "09:00", timeZone: zone, weekdays: [1, 2, 3, 4, 5] }
                  : undefined,
              )
            }
          />
          <span>Use a local-time calendar schedule</span>
        </label>
        {form.calendar && (
          <>
            <div className="office-form-row">
              <label>
                Local time
                <input
                  type="time"
                  value={form.calendar.time}
                  onChange={(e) =>
                    change("calendar", {
                      ...form.calendar!,
                      time: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Time zone
                <input
                  value={form.calendar.timeZone}
                  onChange={(e) =>
                    change("calendar", {
                      ...form.calendar!,
                      timeZone: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="team-weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, i) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={form.calendar!.weekdays.includes(i)}
                      onChange={(e) =>
                        change("calendar", {
                          ...form.calendar!,
                          weekdays: e.target.checked
                            ? [...form.calendar!.weekdays, i]
                            : form.calendar!.weekdays.filter((d) => d !== i),
                        })
                      }
                    />
                    {day}
                  </label>
                ),
              )}
            </div>
            <small>
              Calendar time overrides the interval. After sleep, one overdue
              check runs and the next future slot is scheduled. A skipped
              daylight-saving time moves to the next valid day.
            </small>
          </>
        )}
        <label className="office-check">
          <input
            type="checkbox"
            checked={Boolean(form.quietHours)}
            onChange={(e) =>
              change(
                "quietHours",
                e.target.checked
                  ? { start: 18, end: 8, timeZone: zone }
                  : undefined,
              )
            }
          />
          <span>Quiet hours for scheduled work</span>
        </label>
        {form.quietHours && (
          <div className="office-form-row">
            <label>
              Start hour
              <input
                type="number"
                min={0}
                max={23}
                value={form.quietHours.start}
                onChange={(e) =>
                  change("quietHours", {
                    ...form.quietHours!,
                    start: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              End hour
              <input
                type="number"
                min={0}
                max={23}
                value={form.quietHours.end}
                onChange={(e) =>
                  change("quietHours", {
                    ...form.quietHours!,
                    end: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Quiet-hours time zone
              <input
                value={form.quietHours.timeZone}
                onChange={(e) =>
                  change("quietHours", {
                    ...form.quietHours!,
                    timeZone: e.target.value,
                  })
                }
              />
            </label>
          </div>
        )}
        <label>
          Approval expiry (minutes)
          <input
            type="number"
            min={10}
            max={10080}
            value={form.approvalMinutes ?? 1440}
            onChange={(e) => change("approvalMinutes", Number(e.target.value))}
          />
        </label>
        <small>
          Queue and human review time do not consume the execution budget.
          Expired approvals require a fresh proposal.
        </small>
      </details>
      {TEAM_ROLES.find((r) => r.name === form.name)?.slugs.some(
        (slug) => !state.installedAgents.some((a) => a.slug === slug),
      ) && (
        <p className="office-error">
          This role has missing workflows:{" "}
          {TEAM_ROLES.find((r) => r.name === form.name)!
            .slugs.filter(
              (slug) => !state.installedAgents.some((a) => a.slug === slug),
            )
            .join(", ")}
          . <Link to="/agents/hub">Install from the Hub →</Link> You can also
          choose a different installed work order.
        </p>
      )}
    </div>
  );
}
