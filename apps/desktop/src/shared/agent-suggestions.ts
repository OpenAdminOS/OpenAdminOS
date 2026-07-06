import type { AgentSummary } from "./openAdminOS.js";

type AgentSuggestionScore = {
  agent: AgentSummary;
  score: number;
  hitCount: number;
  strongHitCount: number;
  index: number;
};

type TextField = "name" | "category" | "description";

type AgentTextProfile = {
  tokens: Record<TextField, Set<string>>;
  bigrams: Record<TextField, Set<string>>;
  synonymGroups: Map<string, TextField>;
};

type QuestionProfile = {
  tokens: string[];
  bigrams: string[];
  synonymGroupIds: Set<string>;
};

const MINIMUM_SCORE = 8;
const TOKEN_WEIGHTS: Record<TextField, number> = {
  name: 4,
  category: 4,
  description: 1.25,
};
const BIGRAM_WEIGHTS: Record<TextField, number> = {
  name: 5.5,
  category: 5.5,
  description: 2.5,
};
const SYNONYM_WEIGHTS: Record<TextField, number> = {
  name: 9,
  category: 9,
  description: 3.5,
};

const STRONG_FIELDS = new Set<TextField>(["name", "category"]);

const STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "day",
  "days",
  "do",
  "does",
  "for",
  "from",
  "get",
  "give",
  "had",
  "has",
  "have",
  "how",
  "in",
  "intune",
  "is",
  "last",
  "list",
  "me",
  "microsoft",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "recent",
  "recently",
  "show",
  "tenant",
  "tenants",
  "the",
  "their",
  "there",
  "these",
  "this",
  "to",
  "was",
  "were",
  "what",
  "whats",
  "which",
  "who",
  "with",
  "without",
]);

/**
 * Domain synonym groups keep chat-to-agent discovery local and deterministic.
 * They map common Microsoft admin phrasing to the domains represented by
 * bundled agents without asking an LLM to infer intent.
 */
const DOMAIN_SYNONYM_GROUPS = [
  {
    id: "device-inactivity",
    terms: [
      "device inactivity",
      "inactive",
      "inactivity",
      "last sync",
      "not synced",
      "stale",
      "stale device",
      "stale devices",
      "sync age",
    ],
  },
  {
    id: "compliance",
    terms: ["compliance", "compliant", "non compliant", "noncompliant"],
  },
  {
    id: "guests",
    terms: ["b2b", "external user", "external users", "guest", "guests"],
  },
  {
    id: "app-registrations",
    terms: [
      "app registration",
      "app registrations",
      "client secret",
      "credential",
      "credentials",
      "enterprise application",
      "enterprise applications",
      "service principal",
      "service principals",
    ],
  },
  {
    id: "sign-in",
    terms: [
      "authentication failure",
      "failed login",
      "failed logins",
      "failed sign in",
      "failed sign ins",
      "login failure",
      "login failures",
      "sign in",
      "sign ins",
      "signin",
    ],
  },
  {
    id: "conditional-access",
    terms: [
      "access policy",
      "access policies",
      "ca",
      "conditional access",
    ],
  },
] as const;

export function suggestAgentForQuestion(
  question: string,
  agents: AgentSummary[],
): { agent: AgentSummary; score: number } | null {
  const questionProfile = buildQuestionProfile(question);
  if (
    questionProfile.tokens.length === 0 &&
    questionProfile.bigrams.length === 0 &&
    questionProfile.synonymGroupIds.size === 0
  ) {
    return null;
  }

  const best = agents
    .map((agent, index) => scoreAgent(agent, index, questionProfile))
    .filter((entry) => entry.score >= MINIMUM_SCORE)
    .filter((entry) => entry.hitCount >= 2 || entry.strongHitCount >= 1)
    .sort(compareScores)
    .at(0);

  return best ? { agent: best.agent, score: roundScore(best.score) } : null;
}

function scoreAgent(
  agent: AgentSummary,
  index: number,
  question: QuestionProfile,
): AgentSuggestionScore {
  const profile = buildAgentTextProfile(agent);
  let score = 0;
  let hitCount = 0;
  let strongHitCount = 0;

  for (const token of question.tokens) {
    const match = bestFieldMatch(token, profile.tokens, TOKEN_WEIGHTS);
    if (!match) continue;
    score += match.weight;
    hitCount += 1;
    if (STRONG_FIELDS.has(match.field)) strongHitCount += 1;
  }

  for (const bigram of question.bigrams) {
    const match = bestFieldMatch(bigram, profile.bigrams, BIGRAM_WEIGHTS);
    if (!match) continue;
    score += match.weight;
    hitCount += 1;
    if (STRONG_FIELDS.has(match.field)) strongHitCount += 1;
  }

  for (const groupId of question.synonymGroupIds) {
    const field = profile.synonymGroups.get(groupId);
    if (!field) continue;
    score += SYNONYM_WEIGHTS[field];
    strongHitCount += 1;
  }

  return { agent, score, hitCount, strongHitCount, index };
}

function compareScores(left: AgentSuggestionScore, right: AgentSuggestionScore): number {
  if (right.score !== left.score) return right.score - left.score;
  if (right.strongHitCount !== left.strongHitCount) {
    return right.strongHitCount - left.strongHitCount;
  }
  if (right.hitCount !== left.hitCount) return right.hitCount - left.hitCount;
  if (left.agent.mode !== right.agent.mode) return left.agent.mode === "read" ? -1 : 1;
  return left.index - right.index;
}

function bestFieldMatch(
  term: string,
  fieldTerms: Record<TextField, Set<string>>,
  weights: Record<TextField, number>,
): { field: TextField; weight: number } | null {
  let best: { field: TextField; weight: number } | null = null;
  for (const field of ["name", "category", "description"] as const) {
    if (!fieldTerms[field].has(term)) continue;
    const weight = weights[field];
    if (!best || weight > best.weight) best = { field, weight };
  }
  return best;
}

function buildQuestionProfile(question: string): QuestionProfile {
  const tokens = unique(tokenize(question, { dropStopwords: true }));
  return {
    tokens,
    bigrams: bigrams(tokens),
    synonymGroupIds: findSynonymGroups(question),
  };
}

function buildAgentTextProfile(agent: AgentSummary): AgentTextProfile {
  const nameTokens = unique(tokenize(agent.name, { dropStopwords: true }));
  const categoryTokens = unique(tokenize(String(agent.category), { dropStopwords: true }));
  const descriptionTokens = unique(tokenize(agent.description, { dropStopwords: true }));

  const profile: AgentTextProfile = {
    tokens: {
      name: new Set(nameTokens),
      category: new Set(categoryTokens),
      description: new Set(descriptionTokens),
    },
    bigrams: {
      name: new Set(bigrams(nameTokens)),
      category: new Set(bigrams(categoryTokens)),
      description: new Set(bigrams(descriptionTokens)),
    },
    synonymGroups: new Map(),
  };

  for (const field of ["name", "category", "description"] as const) {
    for (const groupId of findSynonymGroups(agent[field])) {
      const existing = profile.synonymGroups.get(groupId);
      if (!existing || SYNONYM_WEIGHTS[field] > SYNONYM_WEIGHTS[existing]) {
        profile.synonymGroups.set(groupId, field);
      }
    }
  }

  return profile;
}

function findSynonymGroups(text: string): Set<string> {
  const textTokens = tokenize(text, { dropStopwords: false });
  const matches = new Set<string>();
  for (const group of DOMAIN_SYNONYM_GROUPS) {
    if (
      group.terms.some((term) =>
        containsTokenSequence(textTokens, tokenize(term, { dropStopwords: false })),
      )
    ) {
      matches.add(group.id);
    }
  }
  return matches;
}

function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[start + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function tokenize(
  text: string,
  options: { dropStopwords: boolean },
): string[] {
  const normalized = normalizeText(text);
  const rawTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  return rawTokens
    .map(normalizeToken)
    .filter((token) => token.length > 0)
    .filter((token) => !options.dropStopwords || !STOP_WORDS.has(token));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token: string): string {
  if (token === "synced" || token === "syncing") return "sync";
  if (token === "signins") return "signin";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function bigrams(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    result.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return unique(result);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}
