import {
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { NAME_IN_LINE_COLUMNS } from "../../../shared/naming";
import { shortcutLabel } from "../commands/keymap";
import { useDismissOnEscape } from "../escapeDismiss";
import { useLanguage, useT } from "../i18n";
import { type Said, saidInLine } from "../lineNames";
import { useFade } from "../motion";
import { useAppStore } from "../store";
import { type LineAction, UNDO_SHOWN_MS, type UndoLineState, useUndo } from "../undo";
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
 * reaches the change. An undo the core refuses shows here as one problem line
 * with one action, which stays until dismissed. Read out politely. With the
 * sidebar out of sight the line is the pill instead (`UndoPill`).
 */
export function UndoLine() {
  const line = useUndo((state) => state.line);
  const sidebar = useContext(SidebarControlContext);
  return (
    <div role="status" aria-live="polite" data-testid="undo-line" className="flex flex-col">
      {/* A change shown where the User made it, under an Answer in the assistant, isn't shown twice. */}
      {!showsUndoPill(sidebar) && line && !line.change?.shownAt && (
        <UndoLineBody key={line.id} line={line} />
      )}
    </div>
  );
}

/** The line of a change made in a place of its own, shown there instead of the sidebar's foot (`Undoable.shownAt`). */
export function UndoLineAt({ place }: { place: string }) {
  const line = useUndo((state) => (state.line?.change?.shownAt === place ? state.line : null));
  return (
    <div aria-live="polite" data-testid="undo-line-here" data-undo-place={place}>
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
  useFade(shown, fade);

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
      <div ref={shown} data-testid="undo-note" className={lineClass(inPill)}>
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
        <span data-testid="undo-message" className="min-w-0 break-words">
          {message}
        </span>
        <span className="-ml-1 flex items-center gap-1">
          <button
            type="button"
            data-testid={also.testId}
            onClick={() => {
              useUndo.getState().dismiss();
              also.run();
            }}
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

const MAX_LINES = 2;
const LEAST_NAME_COLUMNS = 8;

/**
 * The message takes two lines at most (DESIGN.md, Sidebar): a name in it is cut shorter, two
 * columns at a time, until it does, and again when the sidebar changes width or the language
 * changes, its words being of another length. Its words never are cut.
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
  const { within } = said;
  const [columns, setColumns] = useState(NAME_IN_LINE_COLUMNS);
  const [, measureAgain] = useReducer((times: number) => times + 1, 0);
  const language = useLanguage();
  const [measuredIn, setMeasuredIn] = useState(language);
  if (measuredIn !== language) {
    setMeasuredIn(language);
    setColumns(NAME_IN_LINE_COLUMNS);
  }

  // After every render, as the room can change without the columns. The whole line is measured:
  // "· Undo" goes with the message's last word, so it can push that word to a line of its own.
  useLayoutEffect(() => {
    const element = line.current;
    if (!element || columns <= LEAST_NAME_COLUMNS) return;
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    const padding =
      Number.parseFloat(getComputedStyle(element).paddingTop) +
      Number.parseFloat(getComputedStyle(element).paddingBottom);
    if (element.getBoundingClientRect().height - padding > lineHeight * MAX_LINES + 1) {
      setColumns(columns - 2);
    }
  });

  useEffect(() => {
    const element = line.current;
    if (!element) return;
    let width: number | null = null;
    const watch = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (width !== null && next !== width) {
        setColumns(NAME_IN_LINE_COLUMNS);
        measureAgain();
      }
      width = next;
    });
    watch.observe(element);
    return () => watch.disconnect();
  }, [line]);

  const shown = within(columns);
  const whole = said.fullMessage ?? said.message;
  // No-break spaces join the message's last word, the dot and Undo, so a wrapped line never leaves
  // "· Undo" alone at the end of its second line.
  return (
    <div ref={line} className={`${changeLineClass(inPill)} break-words`}>
      <span data-testid="undo-message" title={shown === whole ? undefined : whole}>
        {shown}
      </span>
      <span aria-hidden="true">{"\u00A0·\u00A0"}</span>
      <span className="-my-1 inline-block align-middle">{undo}</span>
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
