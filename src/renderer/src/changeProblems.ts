/**
 * What an Answer in the assistant says under its reply about the changes it
 * couldn't make: changes waiting in a Mind that kept it from changing
 * the text, a reply that claims a change none of its calls made, and why a
 * call changed nothing. Only data and words.
 */
import type { ClaimedChange, ConversationAnswer, MindProblem } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import type { Translate } from "./objects";

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

/** The line for a reply that claims changes none of its calls made, the weightiest first; null for none. */
export function unbackedClaimKey(claims: readonly ClaimedChange[] | undefined): MessageKey | null {
  if (!claims || claims.length === 0) return null;
  if (claims.includes("made")) return "answer.unbacked.made";
  if (claims.includes("removed") && claims.length === 1) return "answer.unbacked.removed";
  return "answer.unbacked.changed";
}

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
    case "uncited":
      return t("mindCall.failed.uncited", { mind });
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
