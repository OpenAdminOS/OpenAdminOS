import { type Metadata } from "next";
import Link from "next/link";

import {
  benchmarkData,
  leadOverHosted,
  ownModel,
  passedIn,
  rankedModels,
} from "~/lib/benchmarks/data";

import { MarketingShell } from "../MarketingShell";
import {
  GITHUB_URL,
  JsonLd,
  breadcrumbSchema,
  pageMetadata,
  webPageSchema,
} from "../seo";
import { DivergenceChart } from "./DivergenceChart";
import { TradeoffChart } from "./TradeoffChart";

const TITLE = "Model benchmarks";
const DESCRIPTION =
  "OpenAdmin 8B measured against Claude Opus 5 and GPT-5.6-sol on 100 identical Microsoft 365 administration tasks, scored mechanically. Every number is reproducible from the public harness.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/benchmarks",
});

// One categorical colour per model, checked against the near-black page
// background for contrast and for deuteranopia separation.
const COLOURS: Record<string, string> = {
  "openadmin-8b": "#38bdf8",
  "claude-opus-5": "#fb923c",
  "gpt-5-6-sol": "#34d399",
};

const data = benchmarkData;
const ranked = rankedModels();
const lead = leadOverHosted();

function Bar({
  passed,
  tasks,
  colour,
}: {
  passed: number;
  tasks: number;
  colour: string;
}) {
  const percent = Math.round((100 * passed) / tasks);
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: colour }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-white/60">
        {passed}/{tasks}
      </span>
    </div>
  );
}

export default function BenchmarksPage() {
  const generated = new Date(data.generatedAt).toISOString().slice(0, 10);

  return (
    <MarketingShell>
      <JsonLd
        data={webPageSchema({
          name: TITLE,
          description: DESCRIPTION,
          path: "/benchmarks",
        })}
      />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: TITLE, path: "/benchmarks" },
        ])}
      />

      <section className="w-full max-w-7xl pt-10 sm:pt-16">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">
          Measured, not claimed
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          A {data.taskCount}-task benchmark for the work admins actually do.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-white/60">
          General model leaderboards measure competition mathematics and
          contest code. Neither tells you whether a model will invent an Intune
          setting or agree to wipe two hundred devices. So we built the
          benchmark that does, and ran three models through it unchanged.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {ranked.map((model) => (
            <div
              key={model.id}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              style={
                model.kind === "own"
                  ? { borderColor: "rgba(56,189,248,0.35)" }
                  : undefined
              }
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: COLOURS[model.id] }}
                />
                <p className="text-sm font-semibold">{model.name}</p>
              </div>
              <p className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
                {model.score}
                <span className="text-lg font-normal text-white/40">
                  /{data.taskCount}
                </span>
              </p>
              <p className="mt-2 text-xs text-white/45">
                {model.openWeights
                  ? `${model.sizeOnDisk} · runs on your machine`
                  : "proprietary · hosted API"}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            The index
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Five sub-evaluations, one score.
          </h2>
          <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
            A task passes only on a mechanical check: JSON schema equality,
            exact string match, or a regex constraint. No model judges another
            model, so nothing here depends on our taste.
          </p>
        </div>

        <div className="mt-10 space-y-8">
          {data.categories.map((category) => {
            const best = Math.max(
              ...data.models.map((model) => passedIn(model, category.key)),
            );
            return (
              <div
                key={category.key}
                className="grid gap-4 border-t border-white/10 pt-6 lg:grid-cols-[minmax(0,22rem)_1fr]"
              >
                <div>
                  <h3 className="text-base font-semibold">{category.name}</h3>
                  <p className="mt-1.5 text-sm leading-5 text-white/50">
                    {category.blurb}
                  </p>
                  <p className="mt-2 text-xs text-white/35">
                    {category.tasks} tasks
                  </p>
                </div>
                <div className="space-y-2.5">
                  {data.models.map((model) => {
                    const passed = passedIn(model, category.key);
                    return (
                      <div
                        key={model.id}
                        className="grid grid-cols-[minmax(0,8.5rem)_1fr] items-center gap-4"
                      >
                        <span
                          className={
                            passed === best
                              ? "text-sm font-medium text-white"
                              : "text-sm text-white/55"
                          }
                        >
                          {model.name}
                        </span>
                        <Bar
                          passed={passed}
                          tasks={category.tasks}
                          colour={COLOURS[model.id]!}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            The trade-off
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            What the score costs you.
          </h2>
          <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
            We have no verified price list for the two proprietary models, so
            there is no dollar figure on this page. What we can measure is time
            and output volume, which is what hosted providers bill for.
            Timings run end-to-end through each model&rsquo;s own CLI on a{" "}
            {data.timedTaskCount}-task subset, so they include that
            tool&rsquo;s overhead: what an admin actually waits for.
          </p>
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <TradeoffChart
              data={data}
              colours={COLOURS}
              valueOf={(model) => model.medianSeconds}
              format={(value) => `${value.toFixed(1)}s`}
              axisLabel="median seconds per task · lower is better"
              cornerLabel="↖ better and faster"
              title="Benchmark score against median seconds per task"
            />
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
            <TradeoffChart
              data={data}
              colours={COLOURS}
              valueOf={(model) => model.medianOutputChars}
              format={(value) => String(Math.round(value))}
              axisLabel="median output characters · lower is cheaper"
              cornerLabel="↖ better and leaner"
              title="Benchmark score against median output size"
            />
          </div>
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Where they diverge
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Every task, in the order it was asked.
          </h2>
          <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
            Cumulative correct answers. A flat step is a miss, so you can see
            exactly where a lead was won rather than taking a total on trust.
          </p>
        </div>
        <div className="mt-8 rounded-xl border border-white/10 bg-white/[0.02] p-5">
          <DivergenceChart data={data} colours={COLOURS} />
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Specifications
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            What each model is.
          </h2>
          <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
            Where a figure was not disclosed by the vendor or not measured
            here, the cell says so rather than carrying an estimate.
          </p>
        </div>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-white/10 py-3 pr-4 text-left font-medium text-white/45">
                  <span className="sr-only">Property</span>
                </th>
                {data.models.map((model) => (
                  <th
                    key={model.id}
                    className="border-b border-white/10 py-3 pr-4 text-left font-semibold"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: COLOURS[model.id] }}
                      />
                      {model.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Benchmark score", (m) => `${m.score} / ${data.taskCount}`],
                  ["Median time per task", (m) => `${m.medianSeconds.toFixed(1)} s`],
                  ["Median output size", (m) => `${m.medianOutputChars} chars`],
                  ["Open weights", (m) => (m.openWeights ? "Yes" : "No")],
                  ["Parameters", (m) => m.parameters ?? "not disclosed"],
                  ["Size on disk", (m) => m.sizeOnDisk ?? "n/a"],
                  [
                    "Generation speed",
                    (m) => m.generationSpeed ?? "not separable from the API",
                  ],
                  ["Runs on", (m) => m.runsOn],
                  ["Marginal cost", (m) => m.marginalCost],
                  ["Tenant data", (m) => m.tenantData],
                ] as [string, (model: (typeof data.models)[number]) => string][]
              ).map(([label, render]) => (
                <tr key={label}>
                  <td className="border-b border-white/5 py-3 pr-4 text-white/45">
                    {label}
                  </td>
                  {data.models.map((model) => (
                    <td
                      key={model.id}
                      className="border-b border-white/5 py-3 pr-4 text-white/75"
                    >
                      {render(model)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
              Reading this honestly
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              The frontier models are not bad at this.
            </h2>
            <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
              They land {lead} tasks behind a model of{" "}
              {ownModel.sizeOnDisk}, and beat it in places. The claim this page
              supports is narrow: for daily Microsoft 365 administration a
              local model is not a compromise, and on the behaviours that
              matter when something is about to change a production tenant it
              is ahead.
            </p>
            <Link
              href="/download"
              className="mt-6 inline-flex rounded-md bg-white px-4 py-2 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
            >
              Download OpenAdminOS
            </Link>
          </div>

          <ul className="space-y-4 text-sm leading-6 text-white/55">
            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <span className="font-semibold text-white">
                The task set is ours.
              </span>{" "}
              {data.taskCount} tasks generated from a seed disjoint from our
              training data, never used to choose a checkpoint. It rewards the
              behaviour we trained for, and another admin would weight these
              categories differently.
            </li>
            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <span className="font-semibold text-white">
                The hosted models were reached through their CLIs.
              </span>{" "}
              Those are assistant products, not raw endpoints, and may carry
              their own system prompts. This measures what an admin would
              experience rather than base weights.
            </li>
            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <span className="font-semibold text-white">
                Scorers are mechanical, and imperfect.
              </span>{" "}
              A correct answer phrased unusually can fail a regex. We repaired
              several scorers that only matched our own model&rsquo;s
              vocabulary; that work raised the hosted models&rsquo; scores, not
              ours.
            </li>
            <li className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <span className="font-semibold text-white">
                Timing used {data.timedTaskCount} tasks, not {data.taskCount}.
              </span>{" "}
              A frontier CLI takes minutes per task. The score is the full set;
              the clock is the subset.
            </li>
          </ul>
        </div>
      </section>

      <section className="w-full max-w-7xl border-t border-white/10 py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Reproduce it
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Run the same tasks yourself.
          </h2>
          <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
            The harness, the task set and the raw per-task results are in the
            repository. Measured {generated}.
          </p>
        </div>
        <pre className="mt-6 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-5 text-xs leading-6 text-white/70">
          <code>{`ollama run openadminos/openadmin-8b

node eval/run-external.mjs --label mine --cmd claude --model opus --limit ${data.taskCount}
node site-benchmarks/export-benchmark-data.mjs`}</code>
        </pre>
        <Link
          href={`${GITHUB_URL}/tree/main/model`}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex text-sm font-medium text-sky-300 underline-offset-4 transition hover:text-white hover:underline"
        >
          Browse the evaluation pipeline on GitHub
        </Link>
      </section>
    </MarketingShell>
  );
}
