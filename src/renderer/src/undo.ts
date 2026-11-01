import { create } from "zustand";
import type { CommandId } from "../../shared/commands";
import { translate } from "../../shared/i18n";
import { describeError } from "./errors";
import type { Words, WordsInLine } from "./lineNames";

/**
 * Undo instead of asking (docs/agents/interaction.md, rule 4): a change the User
 * can take back happens at once and goes on this session's stack, offered as
 * the undo line ("Moved “Shortlist” to Finance · Undo", see `UndoLine`) and as
 * ⌘Z / Ctrl+Z outside text, which ⇧⌘Z / Ctrl+Shift+Z (or Ctrl+Y) does again.
 */
export interface Undoable {
  /**
   * What happened, said plainly, in the words of the interface language when it is shown, so a
   * switch of language reaches a line already showing. A long name in it is cut in the middle.
   */
  said: WordsInLine;
  /** What was done, for the Edit menu: "Move 3 Documents" makes "Undo Move 3 Documents". */
  name?: Words;
  /** Takes it back. Throws `UndoRefused` when a fix would let it. */
  undo(): Promise<void>;
  /**
   * What the line says once it is taken back, when it couldn't take back all of it as it was:
   * a Folder it kept for what the User put in it since. Null: nothing.
   */
  undoneNote?(): Words | null;
  /**
   * What the line says, with Redo, once it is taken back, when that took away something the User
   * may not be looking at: "Removed 7 Documents". A ⌘Z can reach it long after it was made.
   * Null: it took nothing away.
   */
  takenBack?(): WordsInLine | null;
  /**
   * Where its line shows, when that is where the User acted rather than the
   * sidebar's foot: under an Answer in the assistant (`answerUndoPlace`).
   */
  shownAt?: string;
  /** Does it again once taken back. Without it, taking it back ends what can be redone. */
  redo?(): Promise<void>;
  /** An action before Undo, for a change made for the User rather than by them: "Change". */
  also?: { label: Words; testId: string; run(): void };
}

/** Where the line of what was done with an Answer in the assistant shows: under that Answer. */
export const answerUndoPlace = (answerId: string) => `answer:${answerId}`;

/**
 * Where a change's line is drawn by the page itself, as an applied edit's line over its paragraph
 * is: it isn't shown at the sidebar's foot as well.
 */
export const pageUndoPlace = "page";

/** An action a line offers that isn't Undo, such as Reopen after a tab closed. */
export interface LineAction {
  label: Words;
  /** Its shortcut, for the tooltip, in the keyboard's own notation. */
  shortcut?: CommandId;
  testId: string;
  run(): void;
}

/** A line that isn't a change: news, with an action when there is one to take. */
export interface ToldLine {
  says: WordsInLine;
  action?: LineAction;
}

/** The one action that lets a refused undo or redo happen. */
export interface UndoFix {
  label: Words;
  run(): Promise<void>;
}

/**
 * An undo or a redo the core can't do, said in the interface's words: with the fix that lets it,
 * it stays on the stack; with none, it never can and leaves it.
 */
export class UndoRefused extends Error {
  constructor(
    readonly said: Words,
    readonly fix: UndoFix | null,
  ) {
    super(said((key, params) => translate("en", key, params)));
    this.name = "UndoRefused";
  }
}

/** Why taking a change back, or doing it again, didn't happen. */
export interface UndoProblem {
  step: "undo" | "redo";
  reason: Words;
  fix: UndoFix | null;
}

export type UndoLineState =
  | {
      id: number;
      change: Undoable;
      problem?: undefined;
      note?: undefined;
      shownAt?: undefined;
      told?: undefined;
    }
  | {
      id: number;
      problem: UndoProblem;
      shownAt?: string;
      change?: undefined;
      note?: undefined;
      told?: undefined;
    }
  | {
      id: number;
      note: Words;
      busy?: boolean;
      shownAt?: string;
      change?: undefined;
      problem?: undefined;
      told?: undefined;
    }
  | {
      id: number;
      told: ToldLine;
      shownAt?: undefined;
      change?: undefined;
      problem?: undefined;
      note?: undefined;
    };

interface UndoState {
  /** The changes ⌘Z takes back, the last one last. */
  done: readonly Undoable[];
  /** The changes ⇧⌘Z does again, the last one taken back last. */
  undone: readonly Undoable[];
  /** What the undo line shows: the change just made or done again, or why one didn't happen. */
  line: UndoLineState | null;
  /** The step being taken now, off both stacks until it ends: a key pressed meanwhile waits its turn. */
  running: { step: "undo" | "redo"; change: Undoable } | null;
  /**
   * How many changes are being made in turn now, each of which goes on the stack once it lands: a
   * ⌘Z pressed meanwhile is offered, and waits for them (`makeInTurn`).
   */
  making: number;
  /** The places showing their own undo line now (`UndoLineAt`), each once for every time it shows. */
  places: readonly string[];
  /** Says a place shows its own undo line, until the function it returns is called. */
  showPlace(place: string): () => void;
  /** Puts a change just made on the stack and shows its line; nothing more can be redone. */
  push(change: Undoable): void;
  /** Tracks an existing change without showing a new line or clearing Redo. */
  offer(change: Undoable): void;
  /** Shows a line that isn't a change, in place of what shows, as after a tab closes. */
  tell(line: ToldLine): void;
  undo(change?: Undoable): Promise<void>;
  redo(change?: Undoable): Promise<void>;
  /**
   * A change was taken back, or done again, where it was made rather than here, as a note's own
   * ⌘Z takes back its step: it moves to the other stack, so ⌘Z and ⇧⌘Z here go on from there.
   */
  follow(change: Undoable, step: "undo" | "redo"): void;
  /** Takes a change off the stack, once it can't be taken back here any more. */
  withdraw(change: Undoable): void;
  /** Hides the line; the stack stays. */
  dismiss(): void;
  /**
   * A change already made has more to it, made just now: a request's later commands. It goes
   * back on top, past what the User did meanwhile, so ⌘Z takes it back first, and shows its line.
   */
  renew(change: Undoable): void;
}

/** What ⌘Z takes back next, once the step being taken now has ended: a change being done again is. */
export const nextToUndo = ({ done, running }: Pick<UndoState, "done" | "running">) =>
  running?.step === "redo" ? running.change : done.at(-1);

/**
 * Whether ⌘Z has something to take back now: a change done, one being done again, or one still
 * being made.
 */
export const undoReady = ({
  done,
  making,
  running,
}: Pick<UndoState, "done" | "making" | "running">) =>
  making > 0 || nextToUndo({ done, running }) !== undefined;

/** What ⇧⌘Z does again next, once the step being taken now has ended: a change being taken back is. */
export const nextToRedo = ({ undone, running }: Pick<UndoState, "undone" | "running">) =>
  running?.step === "undo" && running.change.redo ? running.change : undone.at(-1);

/**
 * Where the line shows: the place its change showed its line (`Undoable.shownAt`), or null for the
 * sidebar's foot. A problem or a note whose place no `UndoLineAt` shows goes to the sidebar's foot,
 * so what happened is never out of sight: an Answer has no place for them, and a setup card or a
 * Settings page may have closed.
 */
export function lineShownAt({ line, places }: Pick<UndoState, "line" | "places">): string | null {
  const place = line?.change?.shownAt ?? line?.shownAt ?? null;
  return (line?.problem || line?.note) && place !== null && !places.includes(place) ? null : place;
}

/** How long the line shows before it goes by itself. */
export const UNDO_SHOWN_MS = 10_000;

/** Past this, a change still being made says so (docs/agents/interaction.md, rule 8). */
export const SLOW_CHANGE_MS = 1_000;

let lines = 0;
const lineOf = (change: Undoable): UndoLineState => ({ id: ++lines, change });

/** What a change taken back took away, with Redo, which does that change again. */
const takenBackLine = (change: Undoable, says: WordsInLine): UndoLineState => ({
  id: ++lines,
  told: {
    says,
    action: {
      label: (t) => t("menu.redo"),
      shortcut: "edit.redo",
      testId: "redo-action",
      run: () => void useUndo.getState().redo(change),
    },
  },
});

/** Undo and redo run one at a time, in the order asked, so a held ⌘Z steps back change by change. */
let queue: Promise<void> = Promise.resolve();
const inTurn = <T>(step: () => Promise<T>): Promise<T> => {
  const turn = queue.then(step);
  queue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
};

/** Waits for the app's already-queued Undo and Redo transitions, before an Answer is regenerated. */
export const undoSettled = (): Promise<void> => queue;

/**
 * Makes a change that goes on the stack once it is done, in turn with Undo and Redo: a ⌘Z
 * pressed while it runs waits for it, then takes it back, never an earlier change.
 */
export const makeInTurn = <T>(make: () => Promise<T>): Promise<T> => {
  useUndo.setState((state) => ({ making: state.making + 1 }));
  const made = inTurn(make);
  const landed = () => useUndo.setState((state) => ({ making: state.making - 1 }));
  made.then(landed, landed);
  return made;
};

export const useUndo = create<UndoState>()((set, get) => {
  /**
   * A refused step: one with a fix stays where it was, to be tried again after the
   * fix; one without can never happen, so it leaves the stack.
   */
  const refused = (step: UndoProblem["step"], change: Undoable, error: unknown) => {
    const fix = error instanceof UndoRefused ? error.fix : null;
    const stack = step === "undo" ? "done" : "undone";
    const { message, wording } = describeError(error);
    const reason: Words =
      error instanceof UndoRefused
        ? error.said
        : (t) => (wording ? t(wording.key, wording.values) : message);
    set((state) => ({
      ...(fix &&
        (step === "undo"
          ? { done: [...state.done, change] }
          : { undone: [...state.undone, change] })),
      line: {
        id: ++lines,
        problem: {
          step,
          reason,
          fix: fix && {
            label: fix.label,
            run: async () => {
              await fix.run();
              if (get()[stack].at(-1) === change) await get()[step]();
            },
          },
        },
        ...(change.shownAt && { shownAt: change.shownAt }),
      },
    }));
  };

  return {
    done: [],
    undone: [],
    line: null,
    running: null,
    making: 0,
    places: [],
    showPlace(place) {
      set((state) => ({ places: [...state.places, place] }));
      return () =>
        set((state) => {
          const at = state.places.indexOf(place);
          return { places: state.places.filter((_, index) => index !== at) };
        });
    },
    push(change) {
      // A command offers the change its action already offered.
      if (get().done.at(-1) === change) return;
      set((state) => ({ done: [...state.done, change], undone: [], line: lineOf(change) }));
    },
    offer(change) {
      if (get().done.includes(change) || get().undone.includes(change)) return;
      set((state) => ({ done: [...state.done, change] }));
    },
    tell(line) {
      set({ line: { id: ++lines, told: line } });
    },
    undo: (wanted) =>
      inTurn(async () => {
        const change = wanted ?? get().done.at(-1);
        if (!change || !get().done.includes(change)) return;
        set((state) => ({
          done: state.done.filter((each) => each !== change),
          line: null,
          running: { step: "undo", change },
        }));
        try {
          await change.undo();
        } catch (error) {
          if (get().running?.change !== change) return;
          set({ running: null });
          refused("undo", change, error);
          return;
        }
        if (get().running?.change !== change) return;
        const note = change.undoneNote?.() ?? null;
        const takenBack = change.redo ? (change.takenBack?.() ?? null) : null;
        set((state) => ({
          undone: change.redo ? [...state.undone, change] : [],
          running: null,
          ...(note
            ? { line: { id: ++lines, note, ...(change.shownAt && { shownAt: change.shownAt }) } }
            : takenBack && { line: takenBackLine(change, takenBack) }),
        }));
      }),
    redo: (wanted) =>
      inTurn(async () => {
        const change = wanted ?? get().undone.at(-1);
        if (!change?.redo || !get().undone.includes(change)) return;
        set((state) => ({
          undone: state.undone.filter((each) => each !== change),
          line: null,
          running: { step: "redo", change },
        }));
        try {
          await change.redo();
        } catch (error) {
          if (get().running?.change !== change) return;
          set({ running: null });
          refused("redo", change, error);
          return;
        }
        if (get().running?.change !== change) return;
        set((state) => ({ done: [...state.done, change], running: null, line: lineOf(change) }));
      }),
    follow(change, step) {
      if (step === "undo" && get().done.includes(change)) {
        set((state) => ({
          done: state.done.filter((each) => each !== change),
          undone: [...state.undone, change],
          ...(state.line?.change === change && { line: null }),
        }));
      } else if (step === "redo" && get().undone.includes(change)) {
        set((state) => ({
          undone: state.undone.filter((each) => each !== change),
          done: [...state.done, change],
          line: lineOf(change),
        }));
      }
    },
    withdraw(change) {
      set((state) => ({
        done: state.done.filter((each) => each !== change),
        undone: state.undone.filter((each) => each !== change),
        ...(state.running?.change === change && { running: null }),
        ...(state.line?.change === change && { line: null }),
      }));
    },
    dismiss() {
      set({ line: null });
    },
    renew(change) {
      set((state) => ({
        done: [...state.done.filter((each) => each !== change), change],
        undone: [],
        line: lineOf(change),
      }));
    },
  };
});

/**
 * Runs changes that each go on the stack as they are made, then leaves them there as one step:
 * Undo takes them back last first, Redo does them again in order.
 */
export async function asOneStep(
  words: Pick<Undoable, "said" | "name">,
  run: () => Promise<void>,
): Promise<void> {
  const before = useUndo.getState().done.length;
  await run();
  const steps = useUndo.getState().done.slice(before);
  if (steps.length < 2) return;
  for (const step of steps) useUndo.getState().withdraw(step);
  useUndo.getState().push({
    ...words,
    undo: async () => {
      for (const step of [...steps].reverse()) await step.undo();
    },
    // What any step couldn't take back as it was, such as a Meeting's audio (#1253), is said too.
    undoneNote: () => {
      const notes = steps.flatMap((step) => step.undoneNote?.() ?? []);
      if (notes.length === 0) return null;
      return (t) =>
        notes.map((note) => note(t)).reduce((first, then) => t("undo.notes", { first, then }));
    },
    redo: async () => {
      for (const step of steps) await step.redo?.();
    },
  });
}

export const useAnswerLine = (answerId: string) =>
  useUndo((state) =>
    state.line?.change?.shownAt === answerUndoPlace(answerId) ? state.line : null,
  );

/**
 * Whether a key goes to something the User types in, whose ⌘Z is its own: a
 * field that takes text, or editable text such as the note. A checkbox or a
 * button does not.
 */
export function typesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type);
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Says a change is being made now, before it starts, so a long one shows at once; the line goes
 * when `done` is called, unless something else has said since.
 */
export function showWorking(said: Words): () => void {
  const shown = ++lines;
  useUndo.setState({ line: { id: shown, note: said, busy: true } });
  return () => {
    if (useUndo.getState().line?.id === shown) useUndo.setState({ line: null });
  };
}

/**
 * Makes a change; one that takes longer than a second says what it is doing on the undo line,
 * where what it did shows next, until it is done.
 */
export async function sayWhileSlow<T>(said: Words, work: () => Promise<T>): Promise<T> {
  let shown: number | null = null;
  const timer = setTimeout(() => {
    shown = ++lines;
    useUndo.setState({ line: { id: shown, note: said, busy: true } });
  }, SLOW_CHANGE_MS);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    if (shown !== null && useUndo.getState().line?.id === shown) useUndo.setState({ line: null });
  }
}
