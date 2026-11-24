import { ProblemLine } from "../../components/ProblemLine";
import { Tip } from "../../components/Tip";
import { useT } from "../../i18n";
import { closeTip, useFeatureTip } from "../../tips";
import type { DeckEditing } from "./deckEditing";

/**
 * The lines over a deck edited by hand, each where the problem is and with one action: the file
 * that couldn't take an edit, which waits to be saved as a copy beside it; a text box that runs
 * past its shape; and once, the first time a deck of the User's own is changed, the tip that the
 * file itself is written and how to put it back.
 */
export function DeckLines({ editing }: { editing: DeckEditing }) {
  const t = useT();
  const { waiting, overflow } = editing;
  const tip = useFeatureTip("deck-edits", "viewer", editing.wroteFile);
  return (
    <div className="viewer-deck-lines" data-quote-skip="">
      {waiting && (
        <ProblemLine
          testId="viewer-deck-unwritable"
          action={{
            label: t("viewer.deck.saveCopy"),
            onClick: editing.saveCopy,
            testId: "viewer-deck-save-copy",
          }}
        >
          {`${t(`error.deck.unwritable.${waiting.why}`, { name: waiting.name })} ${t("viewer.deck.changeKept")}`}
        </ProblemLine>
      )}
      {overflow && (
        <ProblemLine
          testId="viewer-deck-overflow"
          action={{
            label: t("viewer.deck.shrinkToFit"),
            onClick: editing.shrinkToFit,
            testId: "viewer-deck-shrink",
          }}
        >
          {t("viewer.deck.overflow", { slide: overflow.slide })}
        </ProblemLine>
      )}
      {tip && (
        <Tip id="deck-edits" onClose={() => closeTip("deck-edits")}>
          {t("viewer.deck.tip")}
        </Tip>
      )}
    </div>
  );
}
