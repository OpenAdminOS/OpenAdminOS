import type { CSSProperties, ReactNode } from "react";

import {
  featuredChartSeries,
  releasedRun,
  trainingBoardRows,
  trainingPublicData,
  type FeaturedChartSeries,
} from "~/lib/training/data";
import type { TrainingRun } from "~/lib/training/schema";

import { LiveLine } from "./LiveLine";

const SERIES_COLORS = ["#3f82bf", "#bf8420", "#ab5890"] as const;
// Colorblind-validated for this background. Keep this series order stable.

const formatter = new Intl.NumberFormat("en-US");

export default function TrainingPage() {
  const data = trainingPublicData;
  const largestSuite = data.evalSuites.reduce((largest, suite) =>
    suite.count > largest.count ? suite : largest,
  );
  const stats = [
    {
      value: data.model.releasedVersion,
      label: `released · checkpoint ${releasedRun.id}`,
    },
    {
      value: `${data.model.fileSizeGB} GB`,
      label: `${data.model.quantized} quantized`,
    },
    {
      value: `${data.hardware.generationTokensPerSecond} tok/s`,
      label: data.hardware.measuredOn,
    },
    {
      value: formatter.format(data.trainingData.total),
      label: `training examples · ${formatter.format(Object.keys(data.trainingData.tracks).length)} tracks`,
    },
    {
      value: formatter.format(largestSuite.count),
      label: `frozen eval tasks · ${largestSuite.name}`,
    },
    data.retrieval
      ? {
          value: formatter.format(data.retrieval.chunks),
          label: `retrieval chunks · ${formatter.format(data.retrieval.corpora.length)} corpora`,
        }
      : {
          value: data.model.baseModel,
          label: "base model",
        },
  ];

  return (
    <>
      <a className="training-skip-link" href="#training-main">
        Skip to content
      </a>
      <header className="training-topnav">
        <a className="training-wordmark" href="#line">
          <b>training</b>.openadminos.com
        </a>
        <span className="training-nav-tag">TRAINED IN PUBLIC</span>
        <nav aria-label="Training page sections">
          <a href="#line">The line</a>
          <a href="#downloads">Downloads</a>
          <a href="#benchmarks">Benchmarks</a>
          <a href="#runs">Run log</a>
          <a href="#built">How it is built</a>
        </nav>
      </header>

      <main id="training-main">
        <div className="training-hall" id="line">
          <div className="training-hall-head">
            <p className="training-section-label">Open model · public record</p>
            <h1>{data.model.name} is trained in public</h1>
            <p>
              An open model for Microsoft 365 administrators, fine-tuned from{" "}
              <span className="training-mono">{data.model.baseModel}</span>. The
              scores, held checkpoints, and failed runs are recorded here from
              the same build-time export.
            </p>
            <div className="training-release-line">
              released: <b>{data.model.releasedVersion} ({releasedRun.id})</b>
              <span>·</span>
              data: public-data.json
              <span>·</span>
              generated <time dateTime={data.generatedAt}>{data.generatedAt}</time>
            </div>
          </div>
          <LiveLine
            boardRows={trainingBoardRows}
            releasedRunId={releasedRun.id}
            releasedVersion={data.model.releasedVersion}
          />
        </div>

        <section aria-label="Current model facts" className="training-stat-section">
          <div className="training-stats">
            {stats.map((stat) => (
              <div className="training-stat" key={`${stat.value}-${stat.label}`}>
                <b>{stat.value}</b>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="downloads">
          <SectionHeading
            label="Downloads"
            title="Run it locally"
            description={`${data.model.name} is published through the model endpoints in this export. Hardware guidance below is the measured configuration, not an estimate.`}
          />
          <div className="training-download-grid">
            <article className="training-card">
              <h3>Install</h3>
              <div className="training-codebox">
                <span>$ </span>ollama run {data.model.published.ollama}
              </div>
              <div className="training-pill-row">
                <span className="training-pill">
                  {data.hardware.minimumRamGB} GB RAM minimum
                </span>
                <span className="training-pill">
                  {data.hardware.recommendedRamGB} GB recommended
                </span>
                <span className="training-pill">{data.model.license}</span>
              </div>
              <p className="training-fineprint">
                {data.hardware.generationTokensPerSecond} tokens per second,
                measured on {data.hardware.measuredOn}.
              </p>
            </article>
            <article className="training-card">
              <h3>Published endpoints</h3>
              <ul className="training-download-list">
                <DownloadLink
                  href={`https://huggingface.co/${data.model.published.huggingface}`}
                  label="Model weights"
                  value={data.model.published.huggingface}
                />
                <DownloadLink
                  href={`https://huggingface.co/${data.model.published.gguf}`}
                  label="GGUF build"
                  value={data.model.published.gguf}
                />
                <DownloadLink
                  href={`https://ollama.com/library/${data.model.published.ollama}`}
                  label="Ollama model"
                  value={data.model.published.ollama}
                />
              </ul>
              <p className="training-fineprint">
                {data.model.releasedVersion} is the published version in this
                export. Other checkpoints remain run-log records and are not
                presented as downloads.
              </p>
            </article>
          </div>
        </section>

        <section id="benchmarks">
          <SectionHeading
            label="Benchmarks"
            title="Scores, with their suite attached"
            description="Scores from different suites are not comparable. Every displayed result below carries its suite, hash, and retrieval condition."
          />
          <div className="training-suite-banner">
            {featuredChartSeries.map((series, index) => (
              <article key={series.key}>
                <span
                  className="training-series-mark"
                  style={{ backgroundColor: getSeriesColor(index) }}
                />
                <div>
                  <b>{series.name}</b>
                  {series.note ? <small>{withoutEmDash(series.note)}</small> : null}
                  <p>
                    {series.score.label} · {series.score.passed}/{series.score.total}
                    {" · "}{series.score.suite.name} · sha256 {series.score.suite.sha256}
                    {" · "}retrieval on
                  </p>
                  <p>
                    {series.noRetrievalScore.label} · {series.noRetrievalScore.passed}/
                    {series.noRetrievalScore.total} · {series.noRetrievalScore.suite.name}
                    {" · "}sha256 {series.noRetrievalScore.suite.sha256}
                    {" · "}retrieval off
                  </p>
                </div>
              </article>
            ))}
          </div>

          <div className="training-legend" aria-label="Benchmark series">
            {featuredChartSeries.map((series, index) => (
              <span key={series.key}>
                <i style={{ backgroundColor: getSeriesColor(index) }} />
                {series.name}
              </span>
            ))}
          </div>

          <div className="training-benchmark-grid">
            <div>
              <h3 className="training-chart-title">Per category · retrieval on</h3>
              <div className="training-chart-axis" aria-hidden="true">
                <span />
                <div><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
              </div>
              <div className="training-category-chart">
                {data.taskCategories.map((category) => {
                  const categoryTotal = requireCategory(
                    featuredChartSeries[0],
                    category.name,
                  ).total;
                  return (
                    <div className="training-chart-row" key={category.name}>
                      <div className="training-chart-label">
                        <b>{category.name}</b>
                        <span>n={categoryTotal}</span>
                      </div>
                      <div className="training-bars">
                        {featuredChartSeries.map((series, index) => {
                          const score = requireCategory(series, category.name);
                          return (
                            <BenchmarkBar
                              key={series.key}
                              color={getSeriesColor(index)}
                              label={`${category.name}, ${series.name}: ${score.passed}/${score.total}, ${series.score.suite.name}, sha256 ${series.score.suite.sha256}, retrieval on`}
                              passed={score.passed}
                              total={score.total}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="training-chart-title">Totals · retrieval on and off</h3>
              <div className="training-chart-axis training-chart-axis--totals" aria-hidden="true">
                <span />
                <div><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
              </div>
              <div className="training-total-chart">
                {featuredChartSeries.map((series, index) => (
                  <div className="training-chart-row" key={series.key}>
                    <div className="training-chart-label">
                      <b>{series.name}</b>
                      <span>{series.score.suite.name}</span>
                    </div>
                    <div className="training-bars">
                      <BenchmarkBar
                        color={getSeriesColor(index)}
                        label={`${series.name}: ${series.score.passed}/${series.score.total}, ${series.score.suite.name}, sha256 ${series.score.suite.sha256}, retrieval on`}
                        passed={series.score.passed}
                        total={series.score.total}
                      />
                      <BenchmarkBar
                        color={getSeriesColor(index)}
                        label={`${series.name}: ${series.noRetrievalScore.passed}/${series.noRetrievalScore.total}, ${series.noRetrievalScore.suite.name}, sha256 ${series.noRetrievalScore.suite.sha256}, retrieval off`}
                        passed={series.noRetrievalScore.passed}
                        striped
                        total={series.noRetrievalScore.total}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="training-chart-foot">
                Solid bars use retrieval. Striped bars are the same series with
                retrieval switched off.
              </p>
            </div>
          </div>

          <details className="training-table-view">
            <summary>View all passed and total values</summary>
            <div className="training-table-scroll">
              <table>
                <caption className="training-sr-only">
                  Featured benchmark results by task category and retrieval condition
                </caption>
                <thead>
                  <tr>
                    <th scope="col">category</th>
                    {featuredChartSeries.map((series) => (
                      <th scope="col" key={series.key}>{series.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.taskCategories.map((category) => (
                    <tr key={category.name}>
                      <th scope="row">{category.name}</th>
                      {featuredChartSeries.map((series) => {
                        const score = requireCategory(series, category.name);
                        return <td key={series.key}>{score.passed}/{score.total}</td>;
                      })}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Total · retrieval on</th>
                    {featuredChartSeries.map((series) => (
                      <td key={series.key}>{series.score.passed}/{series.score.total}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">Total · retrieval off</th>
                    {featuredChartSeries.map((series) => (
                      <td key={series.key}>
                        {series.noRetrievalScore.passed}/{series.noRetrievalScore.total}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </section>

        <section id="runs">
          <SectionHeading
            label="Run log"
            title="Every recorded run, including the failures"
            description="What each training run contained, what happened, and what it taught us. Held and unpublishable checkpoints stay visible."
          />
          <p className="training-caveat">
            Scores quoted inside run records are the run&apos;s contemporaneous suite;
            suites before the frozen ones carry no hash and are not comparable across rows.
          </p>
          <div className="training-runlog">
            {data.trainingRuns.map((run) => (
              <RunCard run={run} key={run.id} />
            ))}
          </div>
        </section>

        <section id="built">
          <SectionHeading
            label="How it is built"
            title="The record behind the release"
            description="The export keeps model, retrieval, training data, evaluation suites, and run outcomes separate so each claim can be traced to one field."
          />
          <div className="training-built-grid">
            <InfoCard label="MODEL" title="Released checkpoint">
              <p>
                {data.model.name} {data.model.releasedVersion} is checkpoint{" "}
                {releasedRun.id}, based on {data.model.baseModel}. The published
                artifact is {data.model.quantized} at {data.model.fileSizeGB} GB.
              </p>
              <p className="training-mono">{withoutEmDash(releasedRun.recipe)}</p>
            </InfoCard>

            <InfoCard label="RETRIEVAL" title="Facts at query time">
              {data.retrieval ? (
                <>
                  <p>
                    {formatter.format(data.retrieval.chunks)} chunks across{" "}
                    {formatter.format(data.retrieval.corpora.length)} corpora.
                  </p>
                  <p>{withoutEmDash(data.retrieval.sources)}</p>
                  <p className="training-mono">
                    built <time dateTime={data.retrieval.builtAt}>{data.retrieval.builtAt}</time>
                  </p>
                </>
              ) : (
                <p>Retrieval metadata is not present in this export.</p>
              )}
            </InfoCard>

            <InfoCard label="TRAINING DATA" title="Synthetic and validated">
              <p>{withoutEmDash(data.trainingData.policy)}</p>
              <p>
                {formatter.format(data.trainingData.total)} examples across{" "}
                {formatter.format(Object.keys(data.trainingData.tracks).length)}
                {" "}recorded tracks.
              </p>
            </InfoCard>

            <InfoCard label="RELEASE RECIPE" title="What the released run used">
              <p>
                {formatter.format(releasedRun.examples)} examples · track{" "}
                {releasedRun.track}
              </p>
              <ul>
                {releasedRun.trainedOn.map((item) => (
                  <li key={item}>{withoutEmDash(item)}</li>
                ))}
              </ul>
            </InfoCard>

            <InfoCard label="EVALUATION" title="Frozen suites">
              <div className="training-hash-list">
                {data.evalSuites.map((suite) => (
                  <p key={suite.name}>
                    <b>{suite.name}</b> · {suite.count} tasks · sha256 {suite.sha256}
                  </p>
                ))}
              </div>
            </InfoCard>

            <InfoCard label="TASKS" title="What is measured">
              <ul className="training-category-list">
                {data.taskCategories.map((category) => (
                  <li key={category.name}>
                    <b>{category.name}</b>: {withoutEmDash(category.what)}
                  </li>
                ))}
              </ul>
            </InfoCard>
          </div>
        </section>
      </main>

      <footer className="training-footer">
        <div>
          <p>
            {data.model.name} is built by{" "}
            <a href="https://www.openadminos.com">OpenAdminOS</a>. Model and
            pipeline license: {data.model.license}.
          </p>
          <p>
            Microsoft, Intune, Entra, and Defender are trademarks of Microsoft
            Corporation. This project is not affiliated with or endorsed by
            Microsoft or OpenAI.
          </p>
        </div>
        <p className="training-footer-data">
          rendered from public-data.json · generated{" "}
          <time dateTime={data.generatedAt}>{data.generatedAt}</time> · schema v
          {data.schemaVersion}
        </p>
      </footer>
    </>
  );
}

function SectionHeading({
  label,
  title,
  description,
}: {
  label: string;
  title: string;
  description: string;
}) {
  return (
    <header className="training-section-heading">
      <p className="training-section-label">{label}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function DownloadLink({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: string;
}) {
  return (
    <li>
      <span>{label}</span>
      <a href={href} rel="noreferrer" target="_blank">{value}</a>
    </li>
  );
}

interface BarStyle extends CSSProperties {
  "--bar-width": string;
  "--series-color": string;
}

function BenchmarkBar({
  color,
  label,
  passed,
  striped = false,
  total,
}: {
  color: string;
  label: string;
  passed: number;
  striped?: boolean;
  total: number;
}) {
  const percentage = (passed / total) * 100;
  const style = {
    "--bar-width": `${percentage}%`,
    "--series-color": color,
  } as BarStyle;
  return (
    <span
      aria-label={label}
      className="training-bar-track"
      role="img"
      tabIndex={0}
    >
      <span
        className={`training-bar${striped ? " training-bar--striped" : ""}`}
        style={style}
      />
      <span className="training-bar-tooltip" role="tooltip">{label}</span>
    </span>
  );
}

function requireCategory(series: FeaturedChartSeries | undefined, name: string) {
  const category = series?.score.categories[name];
  if (!series || !category) {
    throw new Error(
      `Training data invariant failed: featured score is missing category ${name}`,
    );
  }
  return category;
}

function getSeriesColor(index: number): string {
  const color = SERIES_COLORS[index];
  if (!color) {
    throw new Error(
      `Training data invariant failed: featured series index ${index} has no approved chart color`,
    );
  }
  return color;
}

function RunCard({ run }: { run: TrainingRun }) {
  const tag = getRunTag(run);
  return (
    <article className="training-run">
      <div className="training-run-id">
        <b>{run.id}</b>
        <span>{run.track}</span>
        <time dateTime={run.date}>{run.date}</time>
        <span>{formatter.format(run.examples)} examples</span>
        {tag ? (
          <span className={`training-run-tag training-run-tag--${tag.tone}`}>
            {tag.label}
          </span>
        ) : null}
      </div>
      <div className="training-run-body">
        <p className="training-recipe">{withoutEmDash(run.recipe)}</p>
        <div className="training-trained-on">
          <b>Trained on</b>
          <ul>
            {run.trainedOn.map((item) => (
              <li key={item}>{withoutEmDash(item)}</li>
            ))}
          </ul>
        </div>
        <p className="training-outcome">{withoutEmDash(run.outcome)}</p>
        <div className="training-lesson">
          <b>LESSON</b>
          <p>{withoutEmDash(run.lesson)}</p>
        </div>
      </div>
    </article>
  );
}

function getRunTag(run: TrainingRun): { label: string; tone: string } | null {
  if (/^v\d+(?:\.\d+){0,2}$/.test(run.released ?? "")) {
    return { label: `released as ${run.released}`, tone: "released" };
  }
  if (/\bHELD\b/i.test(run.released ?? "") || /\bheld\b/i.test(run.outcome)) {
    return { label: "held", tone: "held" };
  }
  if (/\bunpublishable\b/i.test(run.outcome)) {
    return { label: "unpublishable", tone: "failed" };
  }
  if (/\bfail(?:s|ed)?\b/i.test(run.outcome)) {
    return { label: "failed", tone: "failed" };
  }
  return null;
}

function InfoCard({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="training-card training-info-card">
      <h3><span>{label}</span>{title}</h3>
      {children}
    </article>
  );
}

function withoutEmDash(value: string): string {
  return value.replaceAll("\u2014", ",");
}
