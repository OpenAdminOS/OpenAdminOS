import { z } from "zod";

import rawBenchmarkData from "~/data/benchmarks/public-data.json";

// Parsed at module load. A malformed contract should fail the build, not
// render a page of blank cells: every number here is a public claim.
const categorySchema = z.object({
  key: z.string(),
  name: z.string(),
  blurb: z.string(),
  tasks: z.number().int().positive(),
});

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["own", "hosted"]),
  score: z.number().int().nonnegative(),
  byCategory: z.array(
    z.object({
      key: z.string(),
      passed: z.number().int().nonnegative(),
      tasks: z.number().int().positive(),
    }),
  ),
  medianSeconds: z.number().positive(),
  medianOutputChars: z.number().int().positive(),
  cumulative: z.array(z.number().int().nonnegative()),
  openWeights: z.boolean(),
  parameters: z.string().nullable(),
  sizeOnDisk: z.string().nullable(),
  generationSpeed: z.string().nullable(),
  runsOn: z.string(),
  marginalCost: z.string(),
  tenantData: z.string(),
});

const benchmarkDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    taskCount: z.number().int().positive(),
    timedTaskCount: z.number().int().positive(),
    categories: z.array(categorySchema).nonempty(),
    taskIds: z.array(z.string()).nonempty(),
    models: z.array(modelSchema).min(2),
  })
  .superRefine((data, ctx) => {
    for (const model of data.models) {
      if (model.score > data.taskCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${model.name} scored ${model.score} of ${data.taskCount} tasks`,
        });
      }
      if (model.cumulative.length !== data.taskCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${model.name} has ${model.cumulative.length} cumulative points for ${data.taskCount} tasks`,
        });
      }
    }
  });

export type BenchmarkData = z.infer<typeof benchmarkDataSchema>;
export type BenchmarkModel = BenchmarkData["models"][number];

export const benchmarkData: BenchmarkData =
  benchmarkDataSchema.parse(rawBenchmarkData);

export const ownModel: BenchmarkModel =
  benchmarkData.models.find((model) => model.kind === "own") ??
  benchmarkData.models[0]!;

/** Ranked best first, for tables and hero tiles. */
export function rankedModels(data: BenchmarkData = benchmarkData) {
  return [...data.models].sort((a, b) => b.score - a.score);
}

export function passedIn(model: BenchmarkModel, categoryKey: string) {
  return model.byCategory.find((entry) => entry.key === categoryKey)?.passed ?? 0;
}

/** The widest gap between our model and the best hosted one, in tasks. */
export function leadOverHosted(data: BenchmarkData = benchmarkData) {
  const hosted = data.models.filter((model) => model.kind === "hosted");
  const best = Math.max(...hosted.map((model) => model.score));
  return ownModel.score - best;
}
