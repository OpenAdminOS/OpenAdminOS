import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "Expected owner/repository");

const scorePartSchema = z
  .object({
    passed: nonNegativeInteger,
    total: positiveInteger,
  })
  .strict()
  .refine(({ passed, total }) => passed <= total, {
    message: "passed cannot exceed total",
  });

const suiteReferenceSchema = z
  .object({
    name: nonEmptyText,
    sha256: z.string().regex(/^[a-f0-9]{16,64}$/i),
    count: positiveInteger,
  })
  .strict();

const scoreTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}(?:\.\d{3})?|\d{2}-\d{2}-\d{2}-\d{3})Z$/,
  "Expected an ISO timestamp or the pipeline's filename-safe UTC timestamp",
);

export const trainingScoreSchema = z
  .object({
    label: nonEmptyText,
    passed: nonNegativeInteger,
    total: positiveInteger,
    when: scoreTimestampSchema,
    retrieval: z.boolean().nullable(),
    suite: suiteReferenceSchema.nullable(),
    categories: z.record(nonEmptyText, scorePartSchema),
  })
  .strict()
  .superRefine((score, context) => {
    if (score.passed > score.total) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed cannot exceed total",
      });
    }

    const categoryPassed = Object.values(score.categories).reduce(
      (sum, category) => sum + category.passed,
      0,
    );
    const categoryTotal = Object.values(score.categories).reduce(
      (sum, category) => sum + category.total,
      0,
    );
    if (categoryPassed !== score.passed || categoryTotal !== score.total) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: `Category sums ${categoryPassed}/${categoryTotal} do not match score ${score.passed}/${score.total}`,
      });
    }
  });

export const trainingRunSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    track: nonEmptyText,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    examples: positiveInteger,
    recipe: nonEmptyText,
    trainedOn: z.array(nonEmptyText).min(1),
    outcome: nonEmptyText,
    lesson: nonEmptyText,
    released: nonEmptyText.optional(),
  })
  .strict();

export const trainingPublicDataSchema = z
  .object({
    schemaVersion: z.literal(2),
    model: z
      .object({
        name: nonEmptyText,
        baseModel: nonEmptyText,
        license: nonEmptyText,
        published: z
          .object({
            huggingface: repositoryName,
            gguf: repositoryName,
            ollama: repositoryName,
          })
          .strict(),
        releasedVersion: z.string().regex(/^v\d+(?:\.\d+){0,2}$/),
        quantized: nonEmptyText,
        fileSizeGB: z.number().positive(),
      })
      .strict(),
    hardware: z
      .object({
        measuredOn: nonEmptyText,
        generationTokensPerSecond: z.number().positive(),
        minimumRamGB: positiveInteger,
        recommendedRamGB: positiveInteger,
      })
      .strict()
      .refine(
        ({ minimumRamGB, recommendedRamGB }) =>
          recommendedRamGB >= minimumRamGB,
        { message: "recommended RAM cannot be lower than minimum RAM" },
      ),
    retrieval: z
      .object({
        chunks: nonNegativeInteger,
        corpora: z.array(nonEmptyText),
        builtAt: z.string().datetime(),
        sources: nonEmptyText,
      })
      .strict()
      .nullable(),
    trainingData: z
      .object({
        tracks: z.record(nonEmptyText, nonNegativeInteger),
        total: nonNegativeInteger,
        policy: nonEmptyText,
      })
      .strict(),
    evalSuites: z
      .array(
        suiteReferenceSchema
          .extend({
            what: nonEmptyText,
          })
          .strict(),
      )
      .min(1),
    taskCategories: z
      .array(
        z
          .object({
            name: nonEmptyText,
            what: nonEmptyText,
          })
          .strict(),
      )
      .min(1),
    trainingRuns: z.array(trainingRunSchema).min(1),
    scores: z.array(trainingScoreSchema).min(1),
    featured: z
      .array(
        z
          .object({
            key: nonEmptyText,
            name: nonEmptyText,
            scoreLabel: nonEmptyText,
            noRetrievalLabel: nonEmptyText,
            note: nonEmptyText.nullable(),
          })
          .strict(),
      )
      .min(1),
    generatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((data, context) => {
    const trackTotal = Object.values(data.trainingData.tracks).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (trackTotal !== data.trainingData.total) {
      context.addIssue({
        code: "custom",
        path: ["trainingData", "total"],
        message: `Track sum ${trackTotal} does not match total ${data.trainingData.total}`,
      });
    }

    const releasedRun = data.trainingRuns.find(
      (run) => run.released === data.model.releasedVersion,
    );
    if (!releasedRun) {
      context.addIssue({
        code: "custom",
        path: ["model", "releasedVersion"],
        message: "releasedVersion does not resolve to a trainingRuns entry",
      });
    }

    const categoryNames = new Set(data.taskCategories.map(({ name }) => name));
    const suiteKeys = new Set(
      data.evalSuites.map(
        (suite) => `${suite.name}:${suite.sha256}:${suite.count}`,
      ),
    );
    const scoresByLabel = new Map<string, (typeof data.scores)[number]>();
    data.scores.forEach((score, index) => {
      if (scoresByLabel.has(score.label)) {
        context.addIssue({
          code: "custom",
          path: ["scores", index, "label"],
          message: `Duplicate score label ${score.label}`,
        });
      }
      scoresByLabel.set(score.label, score);

      for (const category of Object.keys(score.categories)) {
        if (!categoryNames.has(category)) {
          context.addIssue({
            code: "custom",
            path: ["scores", index, "categories", category],
            message: "Category is not declared in taskCategories",
          });
        }
      }

      if (score.suite) {
        const suiteKey = `${score.suite.name}:${score.suite.sha256}:${score.suite.count}`;
        if (!suiteKeys.has(suiteKey)) {
          context.addIssue({
            code: "custom",
            path: ["scores", index, "suite"],
            message: "Score suite does not resolve to evalSuites",
          });
        }
        if (score.total !== score.suite.count) {
          context.addIssue({
            code: "custom",
            path: ["scores", index, "total"],
            message: "Suite-scored total must match suite.count",
          });
        }
      }
    });

    const featuredKeys = new Set<string>();
    data.featured.forEach((entry, index) => {
      if (featuredKeys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: ["featured", index, "key"],
          message: `Duplicate featured key ${entry.key}`,
        });
      }
      featuredKeys.add(entry.key);

      const score = scoresByLabel.get(entry.scoreLabel);
      const noRetrieval = scoresByLabel.get(entry.noRetrievalLabel);
      if (!score) {
        context.addIssue({
          code: "custom",
          path: ["featured", index, "scoreLabel"],
          message: `Unknown score label ${entry.scoreLabel}`,
        });
      } else if (score.retrieval !== true || !score.suite) {
        context.addIssue({
          code: "custom",
          path: ["featured", index, "scoreLabel"],
          message: "Featured score must have retrieval on and explicit suite provenance",
        });
      }

      if (!noRetrieval) {
        context.addIssue({
          code: "custom",
          path: ["featured", index, "noRetrievalLabel"],
          message: `Unknown score label ${entry.noRetrievalLabel}`,
        });
      } else if (noRetrieval.retrieval !== false || !noRetrieval.suite) {
        context.addIssue({
          code: "custom",
          path: ["featured", index, "noRetrievalLabel"],
          message:
            "Featured no-retrieval score must have retrieval off and explicit suite provenance",
        });
      }

      if (
        score?.suite &&
        noRetrieval?.suite &&
        (score.suite.name !== noRetrieval.suite.name ||
          score.suite.sha256 !== noRetrieval.suite.sha256 ||
          score.suite.count !== noRetrieval.suite.count)
      ) {
        context.addIssue({
          code: "custom",
          path: ["featured", index],
          message: "Retrieval-on and retrieval-off scores must use the same suite",
        });
      }
    });
  });

export type TrainingPublicData = z.infer<typeof trainingPublicDataSchema>;
export type TrainingRun = z.infer<typeof trainingRunSchema>;
export type TrainingScore = z.infer<typeof trainingScoreSchema>;

export function parseTrainingPublicData(input: unknown): TrainingPublicData {
  const result = trainingPublicDataSchema.safeParse(input);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Training public data failed schemaVersion 2 validation:\n${detail}`,
  );
}
