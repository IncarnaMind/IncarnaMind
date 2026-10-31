/**
 * The first own Question with no model set (#103): it waits in the assistant's conversation while
 * the composer becomes the setup card, and is asked as it was as soon as its first step works,
 * without being typed again (`askWaitingQuestion`, in ./conversations). "Set up later" gives its
 * words back to the composer.
 *
 * Once step 1 works the composer is back and stays: steps 2 and 3 wait as one line above it, and
 * Set up opens the next one above the composer, which works on below (#2310).
 */
import { create } from "zustand";
import type { AskInConversationInput } from "../../core/api";
import { NO_MIND, quotesFrom, useComposer, withQuotes } from "./composer";

export type WaitingQuestion = Omit<AskInConversationInput, "conversationId"> & {
  mindId: string | null;
  /** The conversation it was typed in (null: a new chat), where it is asked once a model is set. */
  conversationId: string | null;
};

/** Steps 2 and 3, in the order they are offered (#1922). */
export type SetupStep = "transcription" | "sorting";

export const SETUP_STEPS: readonly SetupStep[] = ["transcription", "sorting"];

/** What a step is called, in the card and in the line above the composer (#2310). */
export const setupStepTitle = (
  step: SetupStep,
): "setup.step.transcription" | "setup.step.sorting" =>
  step === "transcription" ? "setup.step.transcription" : "setup.step.sorting";

export const useModelSetup = create<{
  waiting: WaitingQuestion | null;
  wanted: boolean;
  /** A model works: the steps that come after it are still to do (#1922). */
  ready: boolean;
  /** The step in hand, in its card above the composer; null while the line alone shows (#2310). */
  step: SetupStep | null;
  /** What each step was finished or skipped with; the line counts the ones still null (#2310). */
  done: Readonly<Record<SetupStep, string | null>>;
}>(() => ({
  waiting: null,
  wanted: false,
  ready: false,
  step: null,
  done: { transcription: null, sorting: null },
}));

const KEPT = "incarnamind.setup.waiting";

function keepWaiting(question: WaitingQuestion | null): void {
  try {
    if (question) {
      const { mindId, text, quotes } = question;
      localStorage.setItem(KEPT, JSON.stringify({ mindId, text, quotes: quotes ?? [] }));
    } else localStorage.removeItem(KEPT);
  } catch (error) {
    console.warn("A Question waiting for a model couldn't be kept on this computer.", error);
  }
}

function restoreWaiting(): void {
  try {
    const kept = localStorage.getItem(KEPT);
    if (!kept) return;
    localStorage.removeItem(KEPT);
    const { mindId, text, quotes } = JSON.parse(kept) as {
      mindId: string | null;
      text: string;
      quotes?: unknown;
    };
    giveBack({ mindId, text, quotes: quotesFrom(quotes) });
  } catch (error) {
    console.warn("The Question kept while waiting for a model couldn't be read.", error);
  }
}

// Quitting before Continue would lose a Question that waits for a model, so its words are kept and
// put back in the composer they were typed in at the next start.
restoreWaiting();
useModelSetup.subscribe((state, before) => {
  if (state.waiting !== before.waiting) keepWaiting(state.waiting);
});

/** The setup card with no Question waiting, which the first open's steps card asks for (#1027). */
export const openModelSetup = (): void => useModelSetup.setState({ wanted: true });

/**
 * The setup card takes the composer's place only while no model works: the first step is what the
 * waiting Question needs (#2310). Once one works, the composer and ⌘J are there.
 */
export const useSettingUp = (): boolean =>
  useModelSetup((state) => (state.waiting !== null || state.wanted) && !state.ready);

/** Steps 2 and 3 after a model works: they wait as one line above the composer (#2310). */
export const useSetupStepsWaiting = (): boolean =>
  useModelSetup((state) => state.ready && state.wanted);

/** The next step still to do, or null when both are done or skipped. */
function nextStep(done: Readonly<Record<SetupStep, string | null>>): SetupStep | null {
  return SETUP_STEPS.find((step) => done[step] === null) ?? null;
}

/**
 * Set up, on the line, opens the next step still to do above the composer (#2310); a later step
 * the User opened ahead gives way to it.
 */
export function openSetupSteps(): void {
  const { ready, wanted, step, done } = useModelSetup.getState();
  if (!ready || !wanted) return;
  const next = nextStep(done);
  if (next !== null && next !== step) useModelSetup.setState({ step: next });
}

/** A later step's title, in the card, opens it: an order, never a gate (#2310). */
export const openSetupStep = (step: SetupStep): void => useModelSetup.setState({ step });

/**
 * Whether the cursor is in the setup line or a step above the composer: the only place a skip or
 * a last step may take it from, so typing in the Note is never interrupted (#2310).
 */
function focusInSetup(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return (
    active instanceof Element &&
    (active.closest(".assistant-setup-line") !== null ||
      active.closest('[data-testid="model-setup"]') !== null)
  );
}

/** The composer takes the cursor as the setup lets go, when the User was in it (#2310). */
function handComposerTheCursor(): void {
  if (focusInSetup()) useComposer.getState().requestFocus();
}

/**
 * A step is finished or skipped: the next one opens, and after the last the card and its line go,
 * with the composer left where the User asks next (#2310).
 */
export function finishSetupStep(step: SetupStep, choice: string): void {
  const { done } = useModelSetup.getState();
  const nextDone = { ...done, [step]: choice };
  const next = nextStep(nextDone);
  if (next === null) {
    handComposerTheCursor();
    useModelSetup.setState({ done: nextDone, step: null, wanted: false });
  } else useModelSetup.setState({ done: nextDone, step: next });
}

/** The line's ✕: what is left waits in Settings › Models, and the composer takes the cursor (#2310). */
export function skipSetupSteps(): void {
  handComposerTheCursor();
  useModelSetup.setState({ wanted: false, step: null });
}

/** Keeps a Question that couldn't be asked for want of a model, for the setup card to wait on. */
export const waitForModel = (question: WaitingQuestion): void =>
  useModelSetup.setState({ waiting: question });

/** "Set up later": the Question's words and quotes go back to the composer they were typed in. */
export function giveUpWaiting(): void {
  const { waiting } = useModelSetup.getState();
  useModelSetup.setState({ waiting: null, wanted: false, step: null });
  if (waiting) giveBack(waiting);
  useComposer.getState().requestFocus();
}

/**
 * A Question that couldn't be asked — the User moved to another chat while its conversation was
 * read — goes back to the composer it was typed in, with the cursor, rather than being asked in a
 * chat the User didn't mean (#2310).
 */
export function returnQuestion(
  question: Pick<WaitingQuestion, "mindId" | "text" | "quotes">,
): void {
  giveBack(question);
  useComposer.getState().requestFocus();
}

// The words only into an empty composer; the quotes whatever it holds, each once.
function giveBack({ mindId, text, quotes }: Pick<WaitingQuestion, "mindId" | "text" | "quotes">) {
  const key = mindId ?? NO_MIND;
  const draft = useComposer.getState().draft(key);
  useComposer.getState().update(key, {
    ...(draft.text === "" && typeof text === "string" && { text }),
    quotes: withQuotes(quotes ?? [], draft.quotes ?? []),
  });
}
