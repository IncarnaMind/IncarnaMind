import type { DeckUnwritable } from "../../../../core/api";
import { type ProblemAction, ProblemLine, ProblemMark } from "../../components/ProblemLine";
import { Tip } from "../../components/Tip";
import { useT } from "../../i18n";
import { closeTip, useFeatureTip } from "../../tips";
import type { DeckEditing } from "./deckEditing";

/** The longest file name the line shows whole; a longer one keeps its start and its end. */
const NAME_FITS = 32;

/** A long name cut in the middle, so the line and its actions stay on one line in a narrow pane. */
export const middleCut = (name: string): string =>
  name.length <= NAME_FITS ? name : `${name.slice(0, NAME_FITS - 13)}…${name.slice(-12)}`;

/**
 * A file another app holds is written once that app lets it go, so Try again comes first; a file
 * that is gone can only be saved as a copy.
 */
function unwritableActions(
  why: DeckUnwritable["why"],
  actions: { saveCopy: ProblemAction; tryAgain: ProblemAction },
): { action: ProblemAction; also?: ProblemAction } {
  // Gone, or written by another program since: only a copy beside it keeps the change.
  if (why === "gone" || why === "changed") return { action: actions.saveCopy };
  return why === "locked" || why === "full"
    ? { action: actions.tryAgain, also: actions.saveCopy }
    : { action: actions.saveCopy, also: actions.tryAgain };
}

/**
 * The lines over a deck edited by hand, each where the problem is: the file that couldn't take an
 * edit, which waits to be written again or saved as a copy beside it; a text box that runs
 * past its shape; and once, the first time a deck of the User's own is changed, the tip that the
 * file itself is written and how to put it back.
 */
export function DeckLines({
  editing,
  waitingOnly = false,
  fileGone = false,
}: {
  editing: DeckEditing;
  /** Only the line of a change that waits: the deck can't be edited, so nothing else applies. */
  waitingOnly?: boolean;
  /** The Library found the file gone since the change was refused: that is what the line says. */
  fileGone?: boolean;
}) {
  const t = useT();
  const { waiting } = editing;
  const why = fileGone ? "gone" : waiting?.why;
  const overflow = waitingOnly ? null : editing.overflow;
  const tip = useFeatureTip("deck-edits", "viewer", editing.wroteFile && !waitingOnly);
  return (
    <div className="viewer-deck-lines" data-quote-skip="">
      {waiting && (
        <ProblemLine
          testId="viewer-deck-unwritable"
          {...unwritableActions(why ?? waiting.why, {
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
          {/* Copy-beside refusal is said right where the User clicked; the edit stays waiting. */}
          {waiting.copyFailed && !fileGone
            ? t(`error.deck.copyFailed.${waiting.copyFailed}`)
            : waiting.lock && waiting.again && !fileGone
              ? t("error.deck.unwritable.lockFile", { lock: middleCut(waiting.lock) })
              : t(`error.deck.unwritable.${why ?? waiting.why}`, {
                  name: middleCut(waiting.name),
                  folder: middleCut(waiting.folder ?? ""),
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
