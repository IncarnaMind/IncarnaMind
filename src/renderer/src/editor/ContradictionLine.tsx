import type * as Y from "yjs";
import { type ContradictionCheckOutcome, MIND_SETTINGS_FIELD } from "../../../core/api";
import { clearContradictionWatch } from "../../../shared/contradictionWatch";
import { ProblemLine } from "../components/ProblemLine";
import {
  checkContradictions,
  dismissContradictions,
  useContradictionLine,
} from "../contradictions";
import { formatMoney } from "../cost";
import { useLanguage, useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { contradictionOutcomeParts } from "./contradictionOutcome";
import { AskBlock } from "./MindCheckLine";

/**
 * Contradiction watch (#112) in the check badge's card: what the last run a
 * new version of a Document started found and cost. It closes, for good. A
 * run on demand is the one Check's, whose result is the contradicted marks.
 */
export function ContradictionLine({ doc, mindId }: { doc: Y.Doc; mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const shown = useContradictionLine(doc, mindId);
  const outcome = (run: ContradictionCheckOutcome) => contradictionOutcomeParts(run, t, language);

  if (shown?.kind === "watched") {
    const watched = shown.run;
    const [first = "", ...rest] = outcome(watched);
    const cost = watched.cost ? [formatMoney(watched.cost, language)] : [];
    const after = saidInLine(t, (t) =>
      t("contradictions.after", { document: watched.documentName, result: first }),
    );
    return (
      <>
        <div className="check-card-sep" />
        <ProblemLine
          role="status"
          testId="contradictions-watched"
          title={after.fullMessage}
          className="mind-health-line"
          details={[...rest, ...cost]}
          action={{
            label: t("checks.close"),
            testId: "contradictions-watched-close",
            // Closed for good: the record goes from the Mind, everywhere it is open.
            onClick: () => clearContradictionWatch(doc.getMap(MIND_SETTINGS_FIELD)),
          }}
        >
          {after.message}
        </ProblemLine>
      </>
    );
  }
  return null;
}

export function ContradictionAsk({ doc, mindId }: { doc: Y.Doc; mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const shown = useContradictionLine(doc, mindId);
  if (shown?.kind !== "asking") return null;
  return (
    <AskBlock
      testId="contradictions-ask"
      question={t(shown.claims === 1 ? "contradictions.ask.one" : "contradictions.ask", {
        count: new Intl.NumberFormat(language).format(shown.claims),
      })}
      estimate={shown.estimate}
      check={{
        label: t("contradictions.check"),
        testId: "contradictions-check",
        onClick: () => void checkContradictions(mindId),
      }}
      notNow={{
        label: t("contradictions.cancel"),
        testId: "contradictions-cancel",
        onClick: () => dismissContradictions(mindId),
      }}
    />
  );
}
