import { type LiveStep, liveStepKey } from "./answerSteps";

/** The least time a live step stays up while another replaces it, so the line never flickers. */
export const MIN_STEP_MS = 1000;

/** A step where the line waits for the User: an approval, a consent, or a question they answer below. */
const waitsForUser = (step: LiveStep) =>
  step.kind === "waiting" ||
  step.kind === "consent" ||
  (step.kind === "call" && step.call.source === "asks");

/** A step on screen, and since when. */
export interface ShownStep {
  step: LiveStep;
  since: number;
}

export interface StepHold {
  /** The step an Answer's line is offered, as it changes. */
  offer(step: LiveStep): void;
  /** What is on screen now. */
  shown(): ShownStep;
  /** Counts the line as on screen, for the line that replaces it to take over from; returns its undoing. */
  mount(): () => void;
  stop(): void;
}

const mounted = new Set<StepHold>();

/**
 * The step on screen in the line that the new one for `first` replaces (the
 * Question's line, then its Answer's), while that step is within its minimum
 * time: the new line starts on it, and so keeps its hold. Null when none
 * is, or `first` waits for the User, which shows at once.
 */
export function takeOver(first: LiveStep): ShownStep | null {
  if (waitsForUser(first)) return null;
  const before = [...mounted].at(-1)?.shown();
  return before && Date.now() - before.since < MIN_STEP_MS ? before : null;
}

/**
 * Shows the steps of an Answer one at a time, `onShow` hearing each: a new
 * step shows once the one before has been up `MIN_STEP_MS`, then the latest
 * of those that came meanwhile; one where the line waits for the User shows at
 * once, and so does the step after it. `from` is the step it starts on, and
 * since when.
 */
export function holdSteps(from: ShownStep, onShow: (step: LiveStep) => void): StepHold {
  let current = from;
  let latest = from.step;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = () => {
    timer = undefined;
    current = { step: latest, since: Date.now() };
    onShow(latest);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hold: StepHold = {
    offer(step) {
      latest = step;
      stop();
      if (liveStepKey(step) === liveStepKey(current.step)) return;
      const left = MIN_STEP_MS - (Date.now() - current.since);
      if (waitsForUser(step) || waitsForUser(current.step) || left <= 0) show();
      else timer = setTimeout(show, left);
    },
    shown: () => current,
    mount() {
      mounted.add(hold);
      return () => {
        mounted.delete(hold);
        stop();
      };
    },
    stop,
  };
  return hold;
}
