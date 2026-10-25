import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationAnswer } from "../../../../core/api";
import { addNamesItsMind } from "../../answerAdd";
import { copyAnswer } from "../../answerEditors";
import { shortcutLabel } from "../../commands/keymap";
import { useDismissOnEscape } from "../../escapeDismiss";
import { useT } from "../../i18n";
import { saidInLine } from "../../lineNames";
import { useAppStore } from "../../store";
import { closeTip, offerTip, useTipRoom, useTipShown } from "../../tips";
import { useAnswerLine, useUndo } from "../../undo";
import {
  CheckLineIcon,
  ChevronDownLineIcon,
  CopyLineIcon,
  MindLineIcon,
  PlusLineIcon,
} from "../lineIcons";
import { Tip } from "../Tip";
import { useGoesBy } from "../UndoLine";

/** How long "Copied" says so. */
const COPIED_MS = 1500;

/**
 * Under an Answer in the assistant (#201, #391; DESIGN.md, Answer): only
 * "Copy · Add to note ▾ · New Mind" (#1559), after "Stopped" for one stopped; on hover or focus,
 * and always on the newest. Its model, scope and searches are in its steps.
 * While it is written, Stop is the composer's and the wait line's, not here.
 * Once added, "Added to “{Mind}” · Undo" (⌘Z too), while that can be taken
 * back. Tab reaches each by its name. In an empty Mind, or under a long Answer with
 * Citations, Add to note comes first and names its Mind.
 */
export function AnswerActions({
  answer,
  streaming,
  canKeep,
  focusedMindName,
  mindEmpty,
  onAdd,
  onPick,
  onNewMind,
}: {
  answer: ConversationAnswer;
  streaming: boolean;
  /** It has something to keep: Copy and Add to note. */
  canKeep: boolean;
  /** The Mind in focus, which Add to note adds to; null opens the ▾ instead. */
  focusedMindName: string | null;
  /** The Mind in focus has nothing written in it. */
  mindEmpty: boolean;
  onAdd(): void;
  onPick(anchor: HTMLElement): void;
  /** The Answer as it is, in the empty Mind in front, else in a new Mind (`AddTarget` "new"). */
  onNewMind(): void;
}) {
  const t = useT();
  const pick = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const addedLine = useAnswerLine(answer.id);
  const added = addedLine?.change ?? null;
  useGoesBy(addedLine?.id ?? null);
  useDismissOnEscape(added !== null, () => useUndo.getState().dismiss());
  // Added from its own buttons (which are gone now): the focus goes to its Undo, so the keyboard
  // can take it back at once. Added from elsewhere (⌘⇧A in the note), the focus stays there.
  useEffect(() => {
    const active = document.activeElement;
    if (added && (active === document.body || active?.closest(".assistant-answer"))) {
      undoButton.current?.focus();
    }
  }, [added]);
  const named = useMemo(
    () => canKeep && !streaming && focusedMindName !== null && addNamesItsMind(answer, mindEmpty),
    [canKeep, streaming, focusedMindName, answer, mindEmpty],
  );
  const room = useTipRoom("add-answer", answer.id);
  const tipWanted =
    room &&
    canKeep &&
    focusedMindName !== null &&
    answer.citations.length > 0 &&
    answer.status === "done";
  // Only an Answer seen being written gets the tip: one opened later, from History, doesn't.
  const [watched, setWatched] = useState(streaming);
  useEffect(() => {
    if (streaming) setWatched(true);
  }, [streaming]);
  const offered = useRef(false);
  useEffect(() => {
    if (!streaming && watched && tipWanted && !offered.current) {
      offered.current = true;
      offerTip("add-answer", answer.id);
    }
  }, [streaming, watched, tipWanted, answer.id]);
  const tipShown = useTipShown("add-answer", answer.id);
  useEffect(() => {
    if (added && tipShown) closeTip("add-answer");
  }, [added, tipShown]);
  const keepsRoom =
    tipShown ||
    (watched && room && focusedMindName !== null && (streaming || answer.status === "done"));
  // Once kept, the line stays until a later Question takes it back: closing the tip or adding the
  // Answer must not slide the Answer.
  const [kept, setKept] = useState(false);
  if (keepsRoom && !kept) setKept(true);
  const holdsRoom = kept || keepsRoom;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (streaming) {
    return (
      <>
        <WritingLine />
        {holdsRoom && <TipRoom />}
      </>
    );
  }

  if (added) {
    const said = saidInLine(t, added.said);
    return (
      <>
        <div
          data-testid="answer-added"
          className="assistant-answer-actions assistant-answer-actions--added"
        >
          <CheckLineIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-secondary" />
          <span role="status" title={said.fullMessage} className="assistant-answer-added">
            {said.message}
          </span>
          <span aria-hidden="true">·</span>
          <button
            ref={undoButton}
            type="button"
            data-testid="answer-added-undo"
            aria-label={t("move.undoLabel", { message: said.fullMessage ?? said.message })}
            onClick={() => {
              useUndo
                .getState()
                .undo()
                .catch((error: unknown) => useAppStore.getState().reportError(error));
            }}
            className="assistant-answer-action"
          >
            {t("move.undo")}
          </button>
        </div>
        {holdsRoom && <TipRoom />}
      </>
    );
  }

  const addTitle = focusedMindName
    ? t("answer.add.to", { mind: focusedMindName, shortcut: shortcutLabel("answer.addToNote") })
    : t("answer.add.choose");
  const copyButton = (
    <button
      type="button"
      data-testid="answer-copy"
      aria-label={
        copied
          ? t("answer.copied")
          : t("answer.copy.label", { shortcut: shortcutLabel("assistant.copyAnswer") })
      }
      title={t("answer.copy.label", { shortcut: shortcutLabel("assistant.copyAnswer") })}
      // A selection in the Answer stays as it is: Copy copies just that.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        void copyAnswer(answer.id).then((done) => setCopied(done));
      }}
      className="assistant-answer-action assistant-answer-action--collapses"
    >
      {copied ? <CheckLineIcon className="size-3.5" /> : <CopyLineIcon className="size-3.5" />}
      <span className="assistant-answer-action-label">
        {copied ? t("answer.copied") : t("answer.copy")}
      </span>
    </button>
  );
  const newMindButton = mindEmpty ? null : (
    <button
      type="button"
      data-testid="answer-new-mind"
      aria-label={t("answer.newMind.label")}
      title={t("answer.newMind.label")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onNewMind}
      className="assistant-answer-action assistant-answer-action--collapses"
    >
      <MindLineIcon className="size-3.5" />
      <span className="assistant-answer-action-label">{t("answer.newMind")}</span>
    </button>
  );
  const addButtons = (
    <span className="assistant-answer-add">
      <button
        ref={addButton}
        type="button"
        data-testid="answer-add"
        aria-label={addTitle}
        title={addTitle}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (focusedMindName ? onAdd() : pick.current && onPick(pick.current))}
        className="assistant-answer-action assistant-answer-add-main"
      >
        <PlusLineIcon className="size-3.5 shrink-0" />
        <span data-testid="answer-add-label" className="assistant-answer-add-label">
          {named && focusedMindName
            ? t("answer.add.named", { mind: focusedMindName })
            : t("answer.add")}
        </span>
      </button>
      <button
        ref={pick}
        type="button"
        data-testid="answer-add-to"
        aria-haspopup="dialog"
        aria-label={t("answer.addTo")}
        title={t("answer.addTo")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => onPick(event.currentTarget)}
        className="assistant-answer-action assistant-answer-add-more"
      >
        <ChevronDownLineIcon className="size-3" />
      </button>
    </span>
  );
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: an Answer's buttons, named together; a fieldset is for a form's. */}
      <div
        role="group"
        aria-label={t("answer.actions")}
        data-testid="answer-actions"
        data-named={named || undefined}
        className="assistant-answer-actions"
      >
        {answer.status === "stopped" && (
          <span data-testid="answer-stopped" className="assistant-answer-status">
            {t("answer.status.stopped")}
          </span>
        )}
        {canKeep && named && (
          <>
            {addButtons}
            {copyButton}
            {newMindButton}
          </>
        )}
        {canKeep && !named && (
          <>
            {copyButton}
            {addButtons}
            {newMindButton}
          </>
        )}
      </div>
      {holdsRoom && (
        <TipRoom>
          {tipShown && (
            <Tip
              id="add-answer"
              onClose={() => {
                closeTip("add-answer");
                addButton.current?.focus();
              }}
            >
              {t("tip.addAnswer")}
            </Tip>
          )}
        </TipRoom>
      )}
    </>
  );
}

/** The line a tip takes under an Answer's actions, kept before the tip comes so the thread doesn't move. */
export function TipRoom({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="tip-room" className="assistant-answer-tip-room">
      {children}
    </div>
  );
}

/**
 * Under an Answer being written, or on its way: the room its actions take, so
 * they come without moving the page, and "Stopped" for one stopped before it
 * started. Its step is on its steps' line.
 */
export function WritingLine({ status }: { status?: ReactNode }) {
  return (
    <div data-testid="answer-actions" className="assistant-answer-actions">
      {status}
    </div>
  );
}
