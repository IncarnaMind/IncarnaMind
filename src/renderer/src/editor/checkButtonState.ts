import type { Language } from "../../../core/language";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { type NoteState, type NoteStateMark, noteStateParts } from "../noteState";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * What the Note's Check button does when pressed: "check" starts the Note's one Check; every other
 * state opens the Checks card.
 */
export type CheckButtonKind = "check" | "checking" | "look" | "checked" | "said";

/** The Note's Check button as drawn (#3794). */
export interface CheckButtonView {
  kind: CheckButtonKind;
  /** The words drawn: "Check", "Checking… 1 of 2", "2 need a look", "Checked", or the state's own. */
  words: string;
  /** Drawn after the words, and kept when the row is tight: the sentences not checked yet. */
  count: string | null;
  /** What is left of the words when the row is tight: the number the words hold, if any. */
  short: string | null;
  /** Everything the state says, for the tooltip. */
  title: string;
  tone: NoteState["tone"];
  mark: NoteStateMark | "check" | "running";
  /** A run is on, or ended since the User last typed: the button holds its room, and the line above the input keeps it. */
  fresh: boolean;
}

export interface CheckButtonInput {
  /** The Note's resting state; null when no sentence is a check's. */
  state: NoteState | null;
  /** A check running now, the app's or the User's own AI's: its words, and how far it has got once counted. */
  running: { words: string; done: number; total: number } | null;
  /** What the User's own AI was asked and says now, when it is not running a check. */
  asked: { short: string; words: string; failed: boolean } | null;
  /** A question or a problem waits in the card. */
  waiting: boolean;
  /** A run ended since the User last typed. */
  justChecked: boolean;
}

/**
 * The button's state, by what matters most: a run going, then what the User's own AI was asked,
 * then sentences waiting for Check, then what a check found. Sentences waiting keep it the dark
 * Check, so the next check is always one press: what needs a look shows in the margin meanwhile.
 */
export function checkButtonOf(
  input: CheckButtonInput,
  t: Translate,
  language: Language,
): CheckButtonView | null {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const { state } = input;
  const parts = state ? noteStateParts(state, t, language) : [];
  const title = parts.join(" · ");
  const base = {
    count: null,
    short: null,
    tone: "neutral" as const,
    fresh: input.justChecked,
  };
  if (input.running) {
    const { done, total } = input.running;
    return {
      ...base,
      kind: "checking",
      words:
        total > 0
          ? t("checkButton.checking", { done: format(done), total: format(total) })
          : t("checkButton.checking.uncounted"),
      title: input.running.words,
      mark: "running",
      fresh: true,
    };
  }
  if (input.asked) {
    return {
      ...base,
      kind: "said",
      words: input.asked.short,
      title: input.asked.words,
      tone: input.asked.failed ? "warning" : "neutral",
      mark: "notChecked",
    };
  }
  if (state === null) return null;
  if (state.notChecked > 0) {
    return {
      ...base,
      kind: "check",
      words: t("mindCheck.command"),
      count: format(state.notChecked),
      title,
      mark: "check",
    };
  }
  if (state.kind === "needs-look" && state.look > 0) {
    return {
      ...base,
      kind: "look",
      words: t(state.look === 1 ? "health.state.look.one" : "health.state.look", {
        count: format(state.look),
      }),
      short: format(state.look),
      title,
      tone: "warning",
      mark: state.mark,
    };
  }
  if (state.kind === "checked") {
    // What a check couldn't settle keeps the ✓ off, as its sentences' own marks are (#2313).
    const unsettled = state.cantCheck + state.notRecalculated > 0;
    return {
      ...base,
      kind: "checked",
      words: t("health.state.checked.noTime"),
      title,
      tone: unsettled ? "neutral" : "success",
      mark: unsettled ? "notChecked" : "checked",
    };
  }
  return {
    ...base,
    kind: "said",
    words: parts[0] ?? t("health.label"),
    title,
    tone: state.tone,
    mark: state.mark,
  };
}

export interface VerifyButtonInput extends Omit<CheckButtonInput, "state"> {
  /** The claims waiting for Check: those found and not yet checked, or else the sentences to check. */
  toCheck: number;
  /** The claims a check has marked, and those of them that need a look or weren't checked. */
  marked: number;
  look: number;
  notChecked: number;
}

/** The same button on a Note made to check someone else's file (#97), which counts its claims. */
export function verifyButtonOf(
  input: VerifyButtonInput,
  t: Translate,
  language: Language,
): CheckButtonView | null {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  if (input.running || input.asked) return checkButtonOf({ ...input, state: null }, t, language);
  const base = { short: null, fresh: input.justChecked };
  if (input.toCheck > 0) {
    return {
      ...base,
      kind: "check",
      words: t("mindCheck.command"),
      count: format(input.toCheck),
      title: t(input.toCheck === 1 ? "verify.check.one" : "verify.check", {
        count: format(input.toCheck),
      }),
      tone: "neutral",
      mark: "check",
    };
  }
  if (input.marked === 0) {
    return input.waiting
      ? {
          ...base,
          kind: "said",
          words: t("health.label"),
          count: null,
          title: "",
          tone: "neutral",
          mark: "notChecked",
        }
      : null;
  }
  const checked = t(input.marked === 1 ? "verify.checked.one" : "verify.checked", {
    count: format(input.marked),
  });
  if (input.look > 0) {
    const look = t(input.look === 1 ? "verify.needLook.one" : "verify.needLook", {
      count: format(input.look),
    });
    return {
      ...base,
      kind: "look",
      words: look,
      count: null,
      short: format(input.look),
      title: `${checked} · ${look}`,
      tone: "warning",
      mark: "unsupported",
    };
  }
  if (input.notChecked > 0) {
    const notChecked = t("verify.notChecked", { count: format(input.notChecked) });
    return {
      ...base,
      kind: "said",
      words: notChecked,
      count: null,
      title: `${checked} · ${notChecked}`,
      tone: "neutral",
      mark: "notChecked",
    };
  }
  return {
    ...base,
    kind: "checked",
    words: t("health.state.checked.noTime"),
    count: null,
    title: checked,
    tone: "success",
    mark: "checked",
  };
}
