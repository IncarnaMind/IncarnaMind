import type { AnswerSteps, ClaimedTool } from "../../core/api";
import type { Translate } from "./objects";

export type UnrunSteps = Pick<AnswerSteps, "unrunTools" | "calculateUnavailable"> | null;

/**
 * The lines under a reply that still says a Tool calculated or searched when
 * none of its calls did (#1796): its figures unchecked, never wrong. Try
 * again, except where the model has no calculation Tool to use.
 */
export function unrunToolLines(
  t: Translate,
  steps: UnrunSteps,
): { tool: ClaimedTool; text: string; retry: boolean }[] {
  return (steps?.unrunTools ?? []).map((tool) => {
    const unavailable = tool === "calculate" && steps?.calculateUnavailable === true;
    const text =
      tool === "search"
        ? t("answer.notSearched")
        : unavailable
          ? t("answer.notCalculated.unavailable")
          : t("answer.notCalculated");
    return { tool, text, retry: !unavailable };
  });
}
