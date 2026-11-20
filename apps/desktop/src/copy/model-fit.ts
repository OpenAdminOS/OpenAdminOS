import type { ModelFitIssue, ProviderId } from "../shared/openAdminOS";
import { sendsThroughTool } from "./trust";

/**
 * Copy for the model fit notice and its accept step (SPEC.md, "Model fit";
 * mockup 36). Where data goes always comes from `providerDataLocation`;
 * nothing here names a region.
 */

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

type Surface = "chat" | "run";

const noun = (surface: Surface) => (surface === "run" ? "run" : "request");

export const MODEL_FIT_COPY = {
  title(issue: ModelFitIssue, model: string, surface: Surface): string {
    if (issue.reason === "repeated-failure") return `${model} could not investigate this question`;
    if (issue.reason === "thinking-only") return `${model} did not finish an answer`;
    return `${model} cannot fit this ${noun(surface)}`;
  },
  /** The reason in plain numbers, where the provider gave them. */
  why(issue: ModelFitIssue, model: string, surface: Surface): string {
    if (issue.reason === "repeated-failure") {
      return "It did not hold the investigation format twice in a row, so this answer comes from cached data only.";
    }
    if (issue.reason === "thinking-only") return `${model} spent its whole answer budget on reasoning.`;
    const what = `This ${noun(surface)}`;
    const limitVerb = issue.limitIsModelMax ? "supports at most" : "is set to";
    if (issue.limitTokens && issue.limitIsMemory && !issue.neededTokens) {
      return `${model} could not run with ${tokens(issue.limitTokens)} tokens of context on this device, usually because free memory ran out.`;
    }
    if (issue.neededTokens && issue.limitTokens && issue.limitIsMemory) {
      return `${what} needs about ${tokens(issue.neededTokens)} tokens. ${model} could not load with ${tokens(issue.limitTokens)} on this device, usually because free memory ran out.`;
    }
    if (issue.neededTokens && issue.limitTokens && issue.neededTokens < issue.limitTokens) {
      // The count is the prompt alone (Apple Foundation): it fits, but leaves no room for an answer.
      return `${what} uses about ${tokens(issue.neededTokens)} of the ${tokens(issue.limitTokens)} tokens ${model} ${limitVerb}, which leaves too little room for an answer.`;
    }
    if (issue.neededTokens && issue.limitTokens) {
      return `${what} needs about ${tokens(issue.neededTokens)} tokens. ${model} ${limitVerb} ${tokens(issue.limitTokens)}.`;
    }
    if (issue.neededTokens) return `${what} needs about ${tokens(issue.neededTokens)} tokens, more than ${model} can take.`;
    if (issue.limitTokens) return `${what} is larger than the ${tokens(issue.limitTokens)} tokens ${model} ${limitVerb}.`;
    return `${what} is larger than the context ${model} is set to.`;
  },
  nothingSent: "Nothing was sent to another provider.",
  /** Read out when the notice appears: the heading, and that choices follow. */
  announce: (issue: ModelFitIssue, model: string, surface: Surface) =>
    `${MODEL_FIT_COPY.title(issue, model, surface)}. Choices follow.`,
  /** `answered`: Chat already answered from cached data, so the offer asks again. */
  groupLabel(issue: ModelFitIssue, surface: Surface, answered = issue.reason === "repeated-failure"): string {
    if (surface === "run") return "Run again with";
    return answered ? "Ask this again with" : "Run this one request with";
  },
  runWith: (tool: string) => `Run with ${tool}`,
  useLocal: (model: string) => `Use ${model}`,
  localWhere: (providerName: string) => `${providerName} · on this device`,
  localNote: (surface: Surface) =>
    `A larger model on this device. Its context size is not checked before the ${noun(surface)}.`,
  /**
   * Where the cost lands. The app does not know the admin's plan or price.
   * TODO(ugur): is this cost note enough, or should hosted rows show an estimate?
   */
  costNote(providerId: ProviderId, tool: string, surface: Surface): string {
    if (providerId === "azure-openai") return `Billed to the Azure subscription of your Azure OpenAI resource.`;
    if (sendsThroughTool({ id: providerId })) {
      return `Uses your ${tool} sign-in. The ${noun(surface)} counts toward that account's usage or bill.`;
    }
    return `Billing follows your ${tool} account.`;
  },
  costFact(providerId: ProviderId, tool: string): string {
    if (providerId === "azure-openai") return "Billed to the Azure subscription of your Azure OpenAI resource";
    return `Counts toward your ${tool} account's usage or bill`;
  },
  split: "Split the question",
  splitNotice:
    "Your question is back in the composer. Ask about one part at a time, for example one platform or one group.",
  keep: (model: string) => `Keep on ${model}`,
  keepAnswer: "Keep this answer",
  declined: (model: string) =>
    `Kept on ${model}. Nothing was sent. Narrow the question, for example to one platform or one group, or split it into smaller questions, then send again.`,
  policy: "Your organization's policy allows only providers on this device, so no hosted provider is offered.",
  noneSetUp: "No hosted provider is set up, so none is offered.",
  openProviders: "Open Settings, Providers",

  acceptTitle: (tool: string) => `Run this request with ${tool}?`,
  /** `model` could not do the request; `returnModel` is the active one the next message goes to. */
  acceptBody(issue: ModelFitIssue, model: string, returnModel: string, tool: string): string {
    const why = issue.reason === "repeated-failure" ? `${model} could not investigate it.` : issue.reason === "thinking-only" ? `${model} did not finish it.` : `${model} cannot fit it.`;
    return `${why} ${tool} answers this one request. Your next message goes to ${returnModel} again.`;
  },
  cost: "Cost",
  // TODO(ugur): offer "Remember for this conversation"? v1 asks for every request.
  once: "Asked for every request. Nothing is remembered.",
  back: "Back",
  questionLabel: "Question that is sent",
  acceptWithdrawn: "Your question or attachments changed, so nothing was sent. Choose a provider again to review what is sent, or send the edited question as a new message.",

  answeredBy: "Answered by",
  /** A switched request that failed or was stopped: the prompt still left this device. */
  sentTo: "Sent to",
  answeredRest: (model: string) => `for this request only. Chat is back on ${model}.`,
  answeredLocal: (model: string, providerName: string) => `${model} on this device (${providerName})`,

  destinationPending: (provider: string) => `Checking where ${provider} is reached before the run can start.`,
  destinationFailedChat: (provider: string) =>
    `OpenAdminOS could not read where ${provider} is reached, so nothing was sent. Choose the provider again.`,
  destinationFailed: (provider: string) =>
    `OpenAdminOS could not read where ${provider} is reached, so this run cannot start. Close the review and choose the provider again.`,
  /** The run review's line when a run is started again on another provider after a fit failure. */
  runReason(issue: ModelFitIssue, model: string, tool: string): string {
    const why = issue.reason === "context-too-small" ? `${model} could not fit the last run` : `${model} could not finish the last run`;
    return `${why}, so this run uses ${tool}. This run only: the agent keeps its model for later runs.`;
  },
} as const;
