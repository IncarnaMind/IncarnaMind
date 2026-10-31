import { type ReactNode, type RefObject, useContext, useEffect, useRef } from "react";
import { shortcutLabel } from "../commands/keymap";
import { useDismissOnEscape } from "../escapeDismiss";
import { useT } from "../i18n";
import { type Said, saidInLine } from "../lineNames";
import { useBreathing, useFade } from "../motion";
import { useAppStore } from "../store";
import { type LineAction, lineShownAt, UNDO_SHOWN_MS, type UndoLineState, useUndo } from "../undo";
import { showsUndoPill } from "../undoPill";
import { SidebarControlContext } from "./SidebarToggle";

const lineClass = (inPill: boolean) =>
  `${inPill ? "" : "mx-2 pt-0.5 pb-1 pl-2"} flex min-w-0 shrink-0 gap-1 text-[12px] leading-4 text-ink-secondary`;
const changeLineClass = (inPill: boolean) =>
  `${inPill ? "" : "mx-2 pt-0.5 pb-1 pl-2"} min-w-0 shrink-0 text-[12px] leading-4 text-ink-secondary`;
const actionClass =
  "h-6 shrink-0 rounded-md px-1 text-[12px] leading-5 font-semibold text-ink-secondary hover:bg-hover hover:text-ink";

/**
 * The undo line (CONTEXT.md) at the foot of the sidebar, above Settings: what
 * the User just changed, then Undo, which does what ⌘Z does. One at a time; it
 * goes after a few seconds, with Esc or with the next change, while ⌘Z still
 * reaches the change. An undo the core refuses shows as one problem line with
 * one action, which stays until dismissed: here, or where its change showed
 * its line. Read out politely. With the sidebar out of sight the line is the
 * pill instead (`UndoPill`).
 */
export function UndoLine() {
  const line = useUndo((state) => (lineShownAt(state) === null ? state.line : null));
  const sidebar = useContext(SidebarControlContext);
  return (
    <div role="status" aria-live="polite" data-testid="undo-line" className="flex flex-col">
      {!showsUndoPill(sidebar) && line && <UndoLineBody key={line.id} line={line} />}
    </div>
  );
}

/**
 * The line of a change made in a place of its own, shown there instead of the sidebar's foot
 * (`Undoable.shownAt`): also a problem in taking it back or doing it again, and the note the undo
 * leaves. Once the place has closed, a problem and a note show at the foot (`lineShownAt`).
 */
export function UndoLineAt({ place, className }: { place: string; className?: string }) {
  const line = useUndo((state) => (lineShownAt(state) === place ? state.line : null));
  useEffect(() => useUndo.getState().showPlace(place), [place]);
  return (
    <div
      aria-live="polite"
      data-testid="undo-line-here"
      data-undo-place={place}
      className={className}
    >
      {line && <UndoLineBody key={line.id} line={line} />}
    </div>
  );
}

const report = (error: unknown) => useAppStore.getState().reportError(error);

export function UndoLineBody({
  line,
  inPill = false,
  held = false,
  fade = true,
}: {
  line: UndoLineState;
  inPill?: boolean;
  held?: boolean;
  fade?: boolean;
}) {
  const t = useT();
  const shown = useRef<HTMLDivElement>(null);
  const working = useRef<HTMLSpanElement>(null);
  useFade(shown, fade);
  useBreathing(working, Boolean(line.note && line.busy));

  useGoesBy(line.change || line.told || (line.note && !line.busy) ? line.id : null, held);
  useDismissOnEscape(true, () => useUndo.getState().dismiss());

  if (line.told) {
    const said = saidInLine(t, line.told.says);
    const action = line.told.action;
    if (!action) {
      return (
        <div ref={shown} className={lineClass(inPill)}>
          <span data-testid="undo-message" className="min-w-0 break-words" title={said.fullMessage}>
            {said.message}
          </span>
        </div>
      );
    }
    return (
      <ChangeLine
        said={said}
        undo={<ActionButton action={action} />}
        line={shown}
        inPill={inPill}
      />
    );
  }

  if (line.note) {
    return (
      <div
        ref={shown}
        data-testid="undo-note"
        aria-busy={line.busy || undefined}
        className={`${lineClass(inPill)} items-center`}
      >
        {line.busy && (
          <span
            ref={working}
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-ink-secondary"
          />
        )}
        <span className="min-w-0 break-words">{line.note(t)}</span>
      </div>
    );
  }

  if (line.problem) {
    const { step, reason, fix } = line.problem;
    return (
      <div
        ref={shown}
        role="alert"
        data-testid="undo-problem"
        className={`${lineClass(inPill)} items-end`}
      >
        <span aria-hidden="true" className="mb-[9px] size-1.5 shrink-0 rounded-full bg-attention" />
        <span className="line-clamp-2 min-w-0 mb-1 break-words">
          {t(step === "undo" ? "undo.refused" : "redo.refused", { reason: reason(t) })}
        </span>
        <span aria-hidden="true" className="mb-1">
          ·
        </span>
        <button
          type="button"
          data-testid="undo-fix"
          onClick={() => (fix ? void fix.run().catch(report) : useUndo.getState().dismiss())}
          className={actionClass}
        >
          {fix ? fix.label(t) : t("move.dismiss")}
        </button>
      </div>
    );
  }

  const said = saidInLine(t, line.change.said);
  const { message, fullMessage } = said;
  const { also } = line.change;
  const undo = (
    <button
      type="button"
      data-testid="undo-action"
      aria-label={t("move.undoLabel", { message: fullMessage ?? message })}
      title={t("undo.title", { shortcut: shortcutLabel("edit.undo") })}
      onClick={() => void useUndo.getState().undo()}
      className={actionClass}
    >
      {t("move.undo")}
    </button>
  );
  if (also) {
    // A longer line, said for the User rather than by them: all of it, its actions under it.
    return (
      <div ref={shown} className={`${lineClass(inPill)} flex-col`}>
        <span data-testid="undo-message" className="min-w-0 break-words text-balance">
          {message}
        </span>
        <span className="-ml-1 flex items-center gap-1">
          <button
            type="button"
            data-testid={also.testId}
            onClick={() => also.run()}
            className={actionClass}
          >
            {also.label(t)}
          </button>
          <span aria-hidden="true">·</span>
          {undo}
        </span>
      </div>
    );
  }
  return <ChangeLine said={said} undo={undo} line={shown} inPill={inPill} />;
}

/**
 * The message wraps rather than cutting a name within the line's limit, so a narrow pane or a
 * wide system font may take it to a third line (DESIGN.md, Sidebar; D304). Only a name past the
 * limit is cut, in the middle, and the whole message is its tooltip.
 */
function ChangeLine({
  said,
  undo,
  line,
  inPill,
}: {
  said: Said;
  undo: ReactNode;
  line: RefObject<HTMLDivElement | null>;
  inPill: boolean;
}) {
  const whole = said.fullMessage ?? said.message;
  // No-break spaces join the message's last word, the dot and Undo, and they don't break inside
  // their span, so a wrapped line never leaves "· Undo" alone: Chinese can break after any
  // character, and an inline-block may start a line of its own.
  return (
    // Chinese wraps between words, at the quotes around a name, not inside a word (`break-keep`).
    <div ref={line} className={`${changeLineClass(inPill)} break-words break-keep`}>
      <span data-testid="undo-message" title={said.message === whole ? undefined : whole}>
        {said.message}
      </span>
      <span className="whitespace-nowrap">
        <span aria-hidden="true">{"\u00A0·\u00A0"}</span>
        <span className="-my-1 inline-block align-middle">{undo}</span>
      </span>
    </div>
  );
}

function ActionButton({ action }: { action: LineAction }) {
  const t = useT();
  const label = action.label(t);
  const title = action.shortcut
    ? t("line.actionKeys", { label, keys: shortcutLabel(action.shortcut) })
    : label;
  return (
    <button
      type="button"
      data-testid={action.testId}
      aria-label={title}
      title={title}
      onClick={action.run}
      className={`${actionClass} whitespace-nowrap`}
    >
      {label}
    </button>
  );
}

/**
 * A change's line goes after a few seconds, unless a newer line took its place; ⌘Z still reaches
 * it. `held`: the pointer or the focus rests on the line, so its clock doesn't run.
 */
export function useGoesBy(lineId: number | null, held = false): void {
  useEffect(() => {
    if (lineId === null || held) return;
    const timer = setTimeout(() => {
      if (useUndo.getState().line?.id === lineId) useUndo.getState().dismiss();
    }, UNDO_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [lineId, held]);
}
