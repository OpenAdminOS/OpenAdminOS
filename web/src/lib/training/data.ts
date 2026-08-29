import rawTrainingData from "~/data/training/public-data.json";

import {
  parseTrainingPublicData,
  type TrainingPublicData,
  type TrainingRun,
  type TrainingScore,
} from "./schema";

export const trainingPublicData = parseTrainingPublicData(rawTrainingData);

export interface FeaturedChartSeries {
  key: string;
  name: string;
  note: string | null;
  score: TrainingScore & { suite: NonNullable<TrainingScore["suite"]> };
  noRetrievalScore: TrainingScore & {
    suite: NonNullable<TrainingScore["suite"]>;
  };
}

export interface TrainingBoardRow {
  run: string;
  status: string;
  location: string;
  detail: string;
  tone: "released" | "held" | "experiment";
}

export function getReleasedRun(
  data: TrainingPublicData = trainingPublicData,
): TrainingRun {
  const run = data.trainingRuns.find(
    (candidate) => candidate.released === data.model.releasedVersion,
  );
  if (!run) {
    throw new Error(
      `Training data invariant failed: no run released as ${data.model.releasedVersion}`,
    );
  }
  return run;
}

export function getFeaturedChartSeries(
  data: TrainingPublicData = trainingPublicData,
): FeaturedChartSeries[] {
  const scores = new Map(data.scores.map((score) => [score.label, score]));

  return data.featured.map((entry) => {
    const score = scores.get(entry.scoreLabel);
    const noRetrievalScore = scores.get(entry.noRetrievalLabel);
    if (!score?.suite || !noRetrievalScore?.suite) {
      throw new Error(
        `Training data invariant failed: featured series ${entry.key} has unresolved suite-scored labels`,
      );
    }
    return {
      key: entry.key,
      name: entry.name,
      note: entry.note,
      score: { ...score, suite: score.suite },
      noRetrievalScore: {
        ...noRetrievalScore,
        suite: noRetrievalScore.suite,
      },
    };
  });
}

export function getTrainingBoardRows(
  data: TrainingPublicData = trainingPublicData,
): TrainingBoardRow[] {
  const releasedRun = getReleasedRun(data);
  const rows: TrainingBoardRow[] = [
    {
      run: releasedRun.id,
      status: "in service",
      location: "terminus",
      detail: data.model.releasedVersion,
      tone: "released",
    },
  ];

  for (const run of data.trainingRuns) {
    if (run.released && /\bHELD\b/i.test(run.released)) {
      rows.push({
        run: run.id,
        status: "held",
        location: "review",
        detail: run.released,
        tone: "held",
      });
    }
  }

  const releasedIds = new Set(
    data.trainingRuns
      .filter((run) => /^v\d+(?:\.\d+){0,2}$/.test(run.released ?? ""))
      .map((run) => run.id),
  );
  const heldIds = new Set(
    data.trainingRuns
      .filter((run) => /\bHELD\b/i.test(run.released ?? ""))
      .map((run) => run.id),
  );

  const newestExperiment = [...data.trainingRuns]
    .reverse()
    .find(
      (run) =>
        !releasedIds.has(run.id) &&
        !heldIds.has(run.id) &&
        data.scores.some((score) => scoreMatchesRun(score.label, run.id)),
    );

  if (newestExperiment) {
    const score = [...data.scores]
      .filter((candidate) => scoreMatchesRun(candidate.label, newestExperiment.id))
      .sort((left, right) => right.when.localeCompare(left.when))[0];
    if (score) {
      rows.push({
        run: newestExperiment.id,
        status: "experiment",
        location: "yard",
        detail: score.suite?.name ?? score.label,
        tone: "experiment",
      });
    }
  }

  return rows;
}

function scoreMatchesRun(label: string, runId: string): boolean {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[-_])${escaped}(?:[-_]|$)`, "i").test(label);
}

export const releasedRun = getReleasedRun();
export const featuredChartSeries = getFeaturedChartSeries();
export const trainingBoardRows = getTrainingBoardRows();
