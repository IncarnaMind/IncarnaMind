import type { DeckUnwritable } from "../../../../core/api";
import { type ProblemAction, ProblemLine, ProblemMark } from "../../components/ProblemLine";
import { Tip } from "../../components/Tip";
import { useT } from "../../i18n";
import { closeTip, useFeatureTip } from "../../tips";
import type { DeckEditing } from "./deckEditing";

/**
 * A file another app holds is written once that app lets it go, so Try again comes first; a file
 * that is gone can only be saved as a copy.
 */
function unwritableActions(
  why: DeckUnwritable["why"],
  actions: { saveCopy: ProblemAction; tryAgain: ProblemAction },
): { action: ProblemAction; also?: ProblemAction } {
  if (why === "gone") return { action: actions.saveCopy };
  return why === "locked"
    ? { action: actions.tryAgain, also: actions.saveCopy }
    : { action: actions.saveCopy, also: actions.tryAgain };
}

/**
 * The lines over a deck edited by hand, each where the problem is: the file that couldn't take an
 * edit, which waits to be written again or saved as a copy beside it; a text box that runs
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
          {...unwritableActions(waiting.why, {
            saveCopy: {
              label: t("viewer.deck.saveCopy"),
              onClick: editing.saveCopy,
              testId: "viewer-deck-save-copy",
            },
            tryAgain: {
              label: t("viewer.deck.tryAgain"),
              onClick: editing.tryAgain,
              testId: "viewer-deck-try-again",
            },
          })}
        >
          <ProblemMark />
          {t("viewer.deck.unwritableLine", {
            problem: t(`error.deck.unwritable.${waiting.why}`, { name: waiting.name }),
            kept: t("viewer.deck.changeKept"),
          })}
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
