import { useMemo } from "react";
import { appliedWaiting } from "../../../../shared/proposals";
import { type ArrivingInMind, arrivingInMind } from "../../arrivingChanges";
import {
  type AskedOutcome,
  reviewAsked,
  undoAsked,
  useAcceptedChanges,
  useArrivingAnswers,
  useAskedFacts,
  useAskedReview,
  useAskedState,
  useWrittenOnTop,
} from "../../askedChanges";
import type { ChangedMind } from "../../changedMinds";
import {
  appliedFact,
  changeFact,
  inNoteText,
  keptText,
  leftText,
  ownWaiting,
} from "../../changeFacts";
import { shortcutLabel } from "../../commands/keymap";
import { useConversations } from "../../conversations";
import { useT } from "../../i18n";
import {
  showChanges,
  showNoteWaiting,
  useWaitingBesidesApplied,
  type WaitingRow,
} from "../../mindChanges";
import { PencilLineIcon } from "../lineIcons";
import { useReadMindId } from "./readMind";

/**
 * The card under an Answer whose changes applied at once (#880, #1559): a
 * line for each Mind, "Wrote “Q3 summary” · Open · Undo" for one it made,
 * "Wrote it into “Untitled” · Undo" for the empty Mind in front, "Changed 3
 * paragraphs in “Q3 review” · Undo" for an edit, with Open too when that Mind
 * isn't the one in front. Undo takes back this Answer's changes there alone,
 * and says why it can't once the Mind changed since or closed; Review changes
 * shows them while the Mind's ⌘K and ⋯ offer it (#1795). Then a line of
 * their own for the changes that wait: "I also suggested 2 changes in
 * “Sources” · Review".
 */
export function AskedChangesCard({
  answerId,
  rows,
  outcomes,
  waiting,
  nameOf,
}: {
  answerId: string;
  rows: readonly ChangedMind[];
  outcomes: Readonly<Record<string, AskedOutcome>>;
  waiting: readonly WaitingRow[];
  nameOf(row: ChangedMind): string;
}) {
  const t = useT();
  const messages = useConversations((state) => state.messages);
  const arrivingAnswers = useArrivingAnswers();
  const arrivingByMind = useMemo(() => {
    const arriving = new Map<string, ArrivingInMind>();
    for (const row of rows) {
      arriving.set(row.mindId, arrivingInMind(messages, row.mindId, arrivingAnswers));
    }
    return arriving;
  }, [messages, rows, arrivingAnswers]);
  const applied = rows.filter((row) => outcomes[row.mindId] !== undefined);
  const also = rows.flatMap((row, index) => {
    const count = waiting[index]?.count;
    return outcomes[row.mindId] === undefined && typeof count === "number" && count > 0
      ? [{ row, count }]
      : [];
  });
  return (
    <section data-testid="mind-changes" className="mind-changes">
      {applied.map((row) => (
        <AskedRow
          key={row.mindId}
          answerId={answerId}
          row={row}
          outcome={outcomes[row.mindId]}
          waiting={waiting[rows.indexOf(row)]}
          arriving={arrivingByMind.get(row.mindId)}
          name={nameOf(row)}
        />
      ))}
      {also.map(({ row, count }) => (
        <p key={row.mindId} data-testid="mind-changes-also" className="mind-changes-line">
          <span className="mind-changes-title">
            {count === 1
              ? t("mindChanges.also.one", { mind: nameOf(row) })
              : t("mindChanges.also", { mind: nameOf(row), count })}
          </span>
          <Dot />
          <button
            type="button"
            data-testid="mind-changes-also-review"
            onClick={() => showChanges(row)}
            className="mind-changes-review"
          >
            {t("mindChanges.also.review")}
          </button>
        </p>
      ))}
    </section>
  );
}

function AskedRow({
  answerId,
  row,
  outcome,
  waiting,
  arriving,
  name,
}: {
  answerId: string;
  row: ChangedMind;
  outcome: AskedOutcome | undefined;
  waiting: WaitingRow | undefined;
  arriving: ArrivingInMind | undefined;
  name: string;
}) {
  const t = useT();
  const facts = useAskedFacts(answerId, row.mindId) ?? row;
  const accepted = useAcceptedChanges(answerId, row.mindId);
  const settled =
    typeof waiting?.count === "number" ? appliedWaiting(waiting.pending, accepted) : null;
  const held = outcome === "held";
  // Once the apply takes the changes they stop waiting, but the hidden waiting row keeps the count
  // it had, and with it the room of the state that was on show (#400).
  const heldLeft = leftText(
    t,
    row,
    accepted === undefined ? waiting?.count : accepted.length + (settled?.count ?? 0),
  );
  const kept = keptText(t, row);
  const noteTotal = useWaitingBesidesApplied(row.mindId, arriving);
  const heldInNote = inNoteText(t, noteTotal, ownWaiting(waiting));
  // Only the row on show carries the test's hooks; the other is hidden from sight and from the
  // accessibility tree, as a person would never reach it.
  const id = (live: boolean, testId: string) => (live ? testId : undefined);
  return (
    <div className="mind-changes-head">
      <PencilLineIcon aria-hidden="true" className="mind-changes-icon" />
      {/*
       * The waiting row and the applied row share one cell, so the head is as tall as the taller
       * of the two at this width, whatever the Note's name, the font or the language, and nothing
       * under it moves when its words change (DESIGN.md, a line that changes its words in place).
       */}
      <div className="mind-changes-rows">
        <p
          className="mind-changes-line"
          data-shown={held ? "true" : "false"}
          aria-hidden={held ? undefined : true}
        >
          <span data-testid={id(held, "mind-changes-title")} className="mind-changes-title">
            {changeFact(t, facts, name)}
          </span>
          {heldLeft && (
            <>
              {" "}
              <span
                data-testid={id(held, "mind-changes-left")}
                className="mind-changes-count whitespace-nowrap"
              >
                {heldLeft}
              </span>
            </>
          )}
          {heldInNote && (
            <>
              {" "}
              <span
                data-testid={id(held, "mind-changes-in-note")}
                className="mind-changes-count whitespace-nowrap"
              >
                {heldInNote}
              </span>
            </>
          )}
          {kept && (
            <span data-testid={id(held, "mind-changes-kept")} className="mind-changes-count">
              {" "}
              {kept}
            </span>
          )}
          <Dot />
          <button
            type="button"
            data-testid={id(held, "mind-changes-review")}
            onClick={() => showChanges(row)}
            className="mind-changes-review"
          >
            {t("mindChanges.review")}
          </button>
        </p>
        <AppliedLine
          answerId={answerId}
          row={row}
          name={name}
          outcome={outcome}
          waiting={waiting}
          arriving={arriving}
          shown={!held}
        />
      </div>
    </div>
  );
}

/**
 * The applied row of an Answer's changes in one Mind, and the room it holds while the waiting row
 * shows: the two rows share one cell and the card takes the taller of the two at this width, so
 * nothing under it moves when the waiting row becomes the applied one (#400, DESIGN.md's feel rules).
 */
export function AppliedLine({
  answerId,
  row,
  name,
  outcome,
  waiting,
  arriving,
  shown,
}: {
  answerId: string;
  row: ChangedMind;
  name: string;
  outcome: AskedOutcome | undefined;
  waiting: WaitingRow | undefined;
  arriving: ArrivingInMind | undefined;
  /** This row is the one on show: it draws, and only it carries the card's hooks. */
  shown: boolean;
}) {
  const t = useT();
  const answerArrivingNow = useArrivingAnswers().has(answerId);
  const facts = useAskedFacts(answerId, row.mindId) ?? row;
  const accepted = useAcceptedChanges(answerId, row.mindId);
  const settled =
    typeof waiting?.count === "number" ? appliedWaiting(waiting.pending, accepted) : null;
  // On show, the count is the changes still waiting after this apply took its share. Hidden, the
  // applied row keeps no count of its own: the waiting row beside it already says its count, and a
  // count kept there would leave a line for words that never show (#400).
  const appliedLeft =
    shown && outcome !== "undone" && settled !== null && settled.count > 0
      ? leftText(t, row, settled.count)
      : null;
  // The count keeps its room from the first frame of the applied row; it shows once the Mind's copy
  // has the apply, so it neither shows what was taken nor moves anything when it appears (#1325).
  const countShown = settled === null || settled.settled;
  const kept = keptText(t, row);
  const total = useWaitingBesidesApplied(row.mindId, arriving);
  // The Note's copy can still hold the changes this apply took for a frame after the Answer stops
  // arriving: they are not waiting, so the Note's count leaves them out too (#1325). While the
  // Answer is arriving, the count already leaves them out; subtracting again would hide others.
  const takenHere =
    answerArrivingNow || outcome !== "applied" || !settled || !waiting
      ? 0
      : waiting.pending.length - settled.count;
  const noteTotal = typeof total === "number" ? Math.max(0, total - takenHere) : total;
  const appliedInNote = outcome === "undone" ? null : inNoteText(t, noteTotal, settled?.count ?? 0);
  const id = (testId: string) => (shown ? testId : undefined);
  return (
    <p
      className="mind-changes-line"
      data-shown={shown ? "true" : "false"}
      aria-hidden={shown ? undefined : true}
    >
      <span data-testid={id("mind-changes-title")} className="mind-changes-title">
        {appliedFact(t, facts, name)}
      </span>
      {appliedLeft && (
        <>
          {" "}
          <span
            data-testid={id("mind-changes-left")}
            className={`mind-changes-count whitespace-nowrap${countShown ? "" : " invisible"}`}
          >
            {appliedLeft}
          </span>
        </>
      )}
      {appliedInNote && (
        <>
          {" "}
          <span
            data-testid={id("mind-changes-in-note")}
            className="mind-changes-count whitespace-nowrap"
          >
            {appliedInNote}
          </span>
          <Dot />
          <button
            type="button"
            data-testid={id("mind-changes-note-review")}
            onClick={() => showNoteWaiting(row)}
            className="mind-changes-review"
          >
            {t("mindChanges.review")}
          </button>
        </>
      )}
      {kept && (
        <span data-testid={id("mind-changes-kept")} className="mind-changes-count">
          {" "}
          {kept}
        </span>
      )}
      <AppliedActions answerId={answerId} row={row} name={name} live={shown} />
    </p>
  );
}

function AppliedActions({
  answerId,
  row,
  name,
  live,
}: {
  answerId: string;
  row: ChangedMind;
  name: string;
  live: boolean;
}) {
  const id = (testId: string) => (live ? testId : undefined);
  const t = useT();
  const { mindId } = row;
  const state = useAskedState(answerId, mindId);
  const reviewable = useAskedReview(answerId, mindId);
  const onTop = useWrittenOnTop(answerId, mindId);
  const inFront = useReadMindId() === mindId;
  if (state === "undone") {
    return (
      <>
        <Dot />
        <span data-testid={id("mind-changes-undone")} className="mind-changes-count">
          {t("mindChanges.undone")}
        </span>
      </>
    );
  }
  const why =
    state === "changed-since"
      ? reviewable
        ? t("mindChanges.undo.changedSince", { mind: name, palette: shortcutLabel("palette.open") })
        : t("mindChanges.undo.changedSince.noReview", { mind: name })
      : state === "closed"
        ? t("mindChanges.undo.closed", { mind: name })
        : undefined;
  return (
    <>
      {onTop && (
        <span data-testid={id("mind-changes-on-top")} className="mind-changes-count">
          {" "}
          {t("mindChanges.onTop")}
        </span>
      )}
      {(row.created || !inFront) && state !== "closed" && (
        <>
          <Dot />
          <button
            type="button"
            data-testid={id("mind-changes-open")}
            aria-label={`${t("mindChanges.open")} ${name}`}
            onClick={() => showChanges(row)}
            className="mind-changes-review"
          >
            {t("mindChanges.open")}
          </button>
        </>
      )}
      <Dot />
      <button
        type="button"
        data-testid={id("mind-changes-undo")}
        aria-disabled={why !== undefined || undefined}
        title={why}
        onClick={() => undoAsked(answerId, mindId)}
        className="mind-changes-review"
      >
        {t("edit.applied.undo")}
      </button>
      {/* Review changes holds its room before the Mind can offer it, so the row keeps its height
          when it appears (#400). */}
      <span
        className={reviewable ? undefined : "invisible"}
        aria-hidden={reviewable ? undefined : true}
      >
        <Dot />
        <button
          type="button"
          data-testid={reviewable ? id("mind-changes-review") : undefined}
          onClick={() => reviewAsked(answerId, mindId)}
          className="mind-changes-review"
        >
          {t("edit.applied.review")}
        </button>
      </span>
    </>
  );
}

export const Dot = () => (
  <span aria-hidden="true" className="mind-changes-dot">
    {" · "}
  </span>
);
