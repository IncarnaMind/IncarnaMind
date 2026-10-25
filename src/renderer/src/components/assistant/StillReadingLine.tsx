import type { ConversationAnswer } from "../../../../core/api";
import { useT } from "../../i18n";
import { saidInLine } from "../../lineNames";
import { MetaLine } from "../MetaLine";

/**
 * Under an Answer written while Documents in its Search scope were still being read (#1503): no
 * search could find their text, so what it says it didn't find may be in them.
 */
export function StillReadingLine({ answer }: { answer: Pick<ConversationAnswer, "steps"> }) {
  const t = useT();
  const reading = answer.steps?.stillReading;
  if (!reading) return null;
  const said = saidInLine(t, (t, cut) =>
    reading.count === 1 && reading.name !== undefined
      ? t("answer.stillReading.one", { name: cut(reading.name) })
      : t("answer.stillReading", { count: reading.count }),
  );
  return (
    <MetaLine
      data-testid="answer-still-reading"
      title={said.fullMessage}
      className="answer-info"
      parts={[said.message, t("answer.stillReading.again")]}
    />
  );
}
