/**
 * What an Answer in the assistant says under its reply about the changes it
 * couldn't make: changes waiting in a Mind that kept it from changing
 * the text, what wasn't done of a change its reply still claims, and why a
 * call changed nothing. Only data and words.
 */
import type { AnswerSteps, AnswerToolCall, ConversationAnswer, MindProblem } from "../../core/api";
import { changedMinds } from "./changedMinds";
import type { Translate } from "./objects";

const field = (call: AnswerToolCall, name: string): string => {
  const value: unknown = call.input?.[name];
  return typeof value === "string" ? value : "";
};

/** The Mind a call names before it has changed one: the name it gave, else the Mind in focus. */
export const namedMind = (t: Translate, call: AnswerToolCall): string =>
  field(call, "mind") || field(call, "title") || t("mindCall.thisMind");

/**
 * The Mind whose waiting changes kept the Answer from changing it, and how
 * many wait there (0: not known); null when none did, or a later call of the
 * Answer changed that Mind after all.
 */
export function waitingProblemOf(
  answer: Pick<ConversationAnswer, "toolCalls">,
): { mindId: string; count: number } | null {
  const calls = answer.toolCalls;
  for (let at = calls.length - 1; at >= 0; at--) {
    const problem = calls[at]?.mindProblem;
    if (problem?.kind !== "waiting") continue;
    const later = calls.slice(at + 1).some((call) => call.mindChange?.mindId === problem.mindId);
    return later ? null : { mindId: problem.mindId, count: problem.count };
  }
  return null;
}

/**
 * The line under a reply that still claims a change none of its calls made, once asked again
 * (#1559). With no Mind changed, "Nothing was written: {reason}", the reason being what the
 * first write call that changed nothing says, else that none ran; with one changed, whose card
 * says how, that not all the reply says was done. Null for no such claim.
 */
export function unbackedClaimLine(
  t: Translate,
  answer: {
    steps: Pick<AnswerSteps, "unbackedClaims"> | null;
    toolCalls: ConversationAnswer["toolCalls"];
  },
): string | null {
  if ((answer.steps?.unbackedClaims ?? []).length === 0) return null;
  if (changedMinds(answer).length > 0) return t("answer.notAllDone");
  const failed = answer.toolCalls.find(
    (call) => call.source === "minds" && call.status === "failed" && call.tool !== "read_mind",
  );
  const mind = failed ? namedMind(t, failed) : "";
  const reason = !failed
    ? t("answer.notWritten.noCall")
    : (failed.mindProblem && problemText(t, failed.mindProblem, mind)) ||
      t(failed.tool === "create_mind" ? "mindCall.createFailed" : "mindCall.failed", { mind });
  return t("answer.notWritten", { reason });
}

/**
 * The Minds an Answer wrote new text into with none of it cited, once it had searched and found
 * Passages (#1415): nothing written there was checked against the Documents. A later call that
 * revised that text with Citations takes it back; a cited paragraph added beside it doesn't. In
 * the order it wrote them.
 */
export function uncitedWritesOf(answer: Pick<ConversationAnswer, "toolCalls">): string[] {
  const changes = answer.toolCalls.flatMap((call) => call.mindChange ?? []);
  const uncited = changes.flatMap((change, at) =>
    change.uncited &&
    !changes
      .slice(at + 1)
      .some((later) => later.mindId === change.mindId && later.revised && (later.cited ?? 0) > 0)
      ? [change.mindId]
      : [],
  );
  return [...new Set(uncited)];
}

/** Whether an Answer's reply has no Citation though the model was asked for them, so nothing in it was checked (#1415). */
export const uncitedReply = (answer: {
  steps: Pick<AnswerSteps, "notCitedAfterAsking"> | null;
  citations: ConversationAnswer["citations"];
}): boolean => answer.steps?.notCitedAfterAsking === true && answer.citations.length === 0;

/** Why a call of a Minds' Tool changed nothing, in its row's words; null for one of no kind it knows. */
export function problemText(t: Translate, problem: MindProblem, mind: string): string | null {
  switch (problem.kind) {
    case "waiting":
      if (problem.mixed) return t("mindCall.failed.mixed", { mind });
      if (problem.count === 0) return t("mindCall.failed.waiting.some", { mind });
      return problem.count === 1
        ? t("mindCall.failed.waiting.one", { mind })
        : t("mindCall.failed.waiting", { mind, count: problem.count });
    case "no-mind":
      return t("mindCall.failed.noMind");
    case "not-found":
      return t("mindCall.failed.notFound", { name: problem.name });
    case "several":
      return t("mindCall.failed.several", { name: problem.name });
    case "not-picked":
      return t("mindCall.failed.notPicked", { name: problem.name });
    case "no-heading":
      return t("mindCall.failed.noHeading", { mind, heading: problem.heading });
    case "no-place":
      return t("mindCall.failed.noPlace", { mind, place: problem.place });
    case "several-places":
      return t(
        problem.adding ? "mindCall.failed.severalPlaces.add" : "mindCall.failed.severalPlaces",
        {
          mind,
          name: problem.name,
        },
      );
    case "no-text":
      return t("mindCall.failed.noText", { mind });
    case "too-long":
      return t("mindCall.failed.tooLong", { mind });
    case "changed":
      return t("mindCall.failed.changed", { mind });
    case "content-not-own":
      return t("mindCall.failed.contentNotOwn", { mind });
    case "copy":
      return t("mindCall.failed.copy", { mind, text: problem.text });
    case "new-version":
      return t("mindCall.failed.newVersion", { mind, text: problem.text });
    case "stopped":
      return t("mindCall.failed.stopped", { mind });
    case "no-table":
      return t("mindCall.failed.noTable", { mind });
    case "unplaced":
      return t("mindCall.failed.unplaced", { mind });
    case "misnamed":
      return t("mindCall.failed.misnamed", { mind });
    case "typed-tag":
      return t("mindCall.failed.typedTag", { mind });
    case "uncited":
      return t("mindCall.failed.uncited", { mind });
    case "no-chart":
      return t(`mindCall.failed.noChart.${problem.problem}`, { mind });
    case "new-mind":
      return t("mindCall.failed.newMind", { mind });
    case "local-mode":
      return t("mindCall.failed.localMode", { mind });
    case "not-ready":
      return t("mindCall.failed.notReady", { mind });
    case "model":
      return t("mindCall.failed.model", { mind });
    default:
      return null;
  }
}
