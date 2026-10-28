import type { AnswerSteps, ClaimedTool } from "../core/api";
import type { NodeJSON } from "./blockJson";
import type { MessageKey, MessageParams } from "./i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export type UnrunSteps =
  | Pick<AnswerSteps, "unrunTools" | "calculateUnavailable">
  | null
  | undefined;

/**
 * The lines under a reply that still says a Tool calculated or searched when
 * none of its calls did (#1796): its worked-out figures unchecked, never
 * wrong. Try again, except where the model has no calculation Tool to use.
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

/** The same lines as italic paragraphs, which go with the Answer into a Note so its claim stays marked there. */
export const unrunToolNotes = (t: Translate, steps: UnrunSteps): NodeJSON[] =>
  unrunToolLines(t, steps).map(({ text }) => ({
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "italic" }] }],
  }));
