const REQUIRED_ENV = [
  "ADVENT_SUPABASE_URL", "ADVENT_SUPABASE_SERVICE_KEY", "ADVENT_SESSION_SECRET",
  "ADVENT_ANSWER_PEPPER", "ADVENT_RESEND_API_KEY", "ADVENT_EMAIL_FROM", "ADVENT_ADMIN_EMAILS",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CRON_SECRET",
] as const;

export function requiresAnswer(day: number) {
  return day !== 22 && day !== 24;
}

type Door = { day: number; draft: boolean; question?: string };
type AnswerCount = { day: number; answer_count: number };

export function launchReadiness(doors: readonly Door[], answers: readonly AnswerCount[], env: Record<string, string | undefined>) {
  const written = doors.filter(({ day }) => requiresAnswer(day));
  const configuredAnswers = new Set(answers.filter(({ answer_count }) => answer_count > 0).map(({ day }) => day));
  const missingQuestions = written.filter(({ question }) => !question?.trim()).map(({ day }) => day);
  const missingAnswers = written.filter(({ day }) => !configuredAnswers.has(day)).map(({ day }) => day);
  const draftDoors = doors.filter(({ draft }) => draft).map(({ day }) => day);
  const rulesUnapproved = env.ADVENT_RULES_APPROVED !== "true";
  const missingEnv = REQUIRED_ENV.filter((key) => !env[key]?.trim()
    || ((key === "ADVENT_SESSION_SECRET" || key === "ADVENT_ANSWER_PEPPER") && Buffer.byteLength(env[key] ?? "") < 32));
  const completable = doors.filter(({ day, question }) =>
    !requiresAnswer(day) || (question?.trim() && configuredAnswers.has(day))).length;

  return {
    completable, missingQuestions, missingAnswers, draftDoors, rulesUnapproved, missingEnv,
    ready: !missingQuestions.length && !missingAnswers.length && !draftDoors.length && !rulesUnapproved && !missingEnv.length,
  };
}
