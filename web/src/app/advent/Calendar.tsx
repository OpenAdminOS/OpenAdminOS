import Link from "next/link";

import { doors } from "~/content/advent/doors";
import { doorState, doorUnlock } from "~/lib/advent/time";
import type { Completion } from "~/lib/advent/db";
import { LocalTime } from "./LocalTime";

export function Calendar({
  now, done = [], counts = new Map(),
}: { now: number; done?: Completion[]; counts?: Map<number, number> }) {
  const completed = new Set(done.map(({ day }) => day));
  return (
    <ol aria-label="Advent of Admin calendar" className="grid grid-cols-3 overflow-clip rounded-[14px] border-l border-t border-brand-line bg-brand-surface sm:grid-cols-4 lg:grid-cols-6">
      {doors.map(({ day, title }) => {
        const state = completed.has(day) ? "done" : doorState(day, now);
        const status = { locked: "Locked", open: "Open", done: "Done", closed: "Closed" }[state];
        const count = counts.get(day) ?? 0;
        const surface = state === "done" ? "bg-brand-ok-surface"
          : state === "open" ? "bg-brand-card"
          : "bg-brand-surface";
        return (
          <li key={day} className={`min-w-0 border-b border-r border-brand-line ${surface}`}>
            <Link href={`/advent/day/${day}`} className="relative flex h-full min-h-28 flex-col gap-1.5 p-2.5 transition-colors hover:bg-brand-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-focus motion-reduce:transition-none sm:min-h-30 sm:p-3.5">
              <span className="flex flex-wrap items-baseline justify-between gap-x-1 gap-y-0.5">
                <span className="font-mono text-xl leading-none tabular-nums"><span className="sr-only">Door </span>{String(day).padStart(2, "0")}</span>
                <span className={`text-[11px] font-medium ${state === "done" ? "text-brand-ok" : "text-brand-muted"}`}>{status}</span>
              </span>
              {state === "locked" ? (
                <span className="mt-auto text-[11px] leading-4 text-brand-muted"><LocalTime timestamp={doorUnlock(day)} unlock /></span>
              ) : (
                <span className="mt-1 break-words text-xs font-medium leading-4 text-brand-ink sm:text-sm">{title}</span>
              )}
              {count >= 10 && <span className="mt-auto text-[11px] leading-4 text-brand-muted">{count} admins completed door {day}</span>}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
