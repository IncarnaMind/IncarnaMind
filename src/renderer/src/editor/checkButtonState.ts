import type { Language } from "../../../core/language";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import {
  type NoteState,
  type NoteStateMark,
  noteStateParts,
  noteStateShowsUnread,
  noteStateUnreadWords,
} from "../noteState";

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
  /** The words and what else is left, for the tooltip: never the time or what can be cited. */
  title: string;
  tone: NoteState["tone"];
  mark: NoteStateMark | "check" | "running";
  /** A run is on, or ended since the User last typed: the button holds its room, and the line above the input keeps it. */
  fresh: boolean;
  /**
   * The words the button says at the widest a run can make them, with every sentence the run
   * could cover checked: the tab strip counts the button's room at them before a run begins, so a
   * press moves nothing beside it (#3765).
   */
  widest: string;
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
  /** The Note's last whole check still speaks for it (`wholeCheckStands`). */
  wholeCheck: boolean;
}

/**
 * The button's state, by what matters most: a run going, then what the User's own AI was asked,
 * then sentences waiting for the Note's first whole check, then what a check found. Until a whole
 * check has run, sentences waiting keep it the dark Check, one press; after one, sentences added
 * or edited never take its verdict away: the card offers to check them (#3840).
 */
export function checkButtonOf(
  input: CheckButtonInput,
  t: Translate,
  language: Language,
): CheckButtonView | null {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const { state } = input;
  const parts = state ? noteStateParts(state, t, language) : [];
  const titled = (words: string) =>
    [...new Set([words, ...(state ? leftParts(state, t, language) : [])])].join(" · ");
  const base = {
    count: null,
    short: null,
    tone: "neutral" as const,
    fresh: input.justChecked,
    widest: widestRunningWords(
      Math.max(input.running?.total ?? 0, state?.checkable ?? 0),
      t,
      language,
    ),
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
  const look =
    state.look > 0
      ? t(state.look === 1 ? "health.state.look.one" : "health.state.look", {
          count: format(state.look),
        })
      : null;
  if (state.notChecked > 0 && !input.wholeCheck) {
    return {
      ...base,
      kind: "check",
      words: t("mindCheck.command"),
      count: format(state.notChecked),
      title: [
        t(state.notChecked === 1 ? "health.toCheck.one" : "health.toCheck", {
          count: format(state.notChecked),
        }),
        ...(look === null ? [] : [look]),
        ...leftParts({ ...state, notChecked: 0 }, t, language),
      ].join(" · "),
      mark: "check",
    };
  }
  if (state.kind === "needs-look" && look !== null) {
    return {
      ...base,
      kind: "look",
      words: look,
      short: format(state.look),
      title: titled(look),
      tone: "warning",
      mark: state.mark,
    };
  }
  if (
    state.kind === "checked" ||
    state.kind === "not-yet-cited" ||
    (input.wholeCheck && state.kind === "not-checked")
  ) {
    // What a check couldn't settle, or hasn't reached since, keeps the ✓ off, as its sentences'
    // own marks are (#2313); a sentence that can be cited shows the margin's ring and "+".
    const unsettled =
      state.kind !== "checked" || state.cantCheck + state.notRecalculated + state.notChecked > 0;
    const words = t("health.state.checked.noTime");
    return {
      ...base,
      kind: "checked",
      words,
      title: titled(words),
      tone: unsettled ? "neutral" : "success",
      mark: state.kind === "not-yet-cited" ? "notYetCited" : unsettled ? "notChecked" : "checked",
    };
  }
  const words = parts[0] ?? t("health.label");
  return {
    ...base,
    kind: "said",
    words,
    title: titled(words),
    tone: state.tone,
    mark: state.mark,
  };
}

/** The running words with `sentences` all checked, or the uncounted words when none are counted. */
function widestRunningWords(sentences: number, t: Translate, language: Language): string {
  if (sentences === 0) return t("checkButton.checking.uncounted");
  const count = new Intl.NumberFormat(language).format(sentences);
  return t("checkButton.checking", { done: count, total: count });
}

/**
 * What else the Note's state leaves, for the button's tooltip: never its time or what can be cited,
 * which the card says once (#3840).
 */
function leftParts(state: NoteState, t: Translate, language: Language): string[] {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const counted = (count: number, one: MessageKey, many: MessageKey) =>
    count > 0 ? [t(count === 1 ? one : many, { count: format(count) })] : [];
  const unread = noteStateShowsUnread(state) ? noteStateUnreadWords(state, t, language) : null;
  return [
    ...counted(state.notChecked, "checks.row.notChecked.one", "checks.row.notChecked"),
    ...counted(state.cantCheck, "health.state.cantCheck.one", "health.state.cantCheck"),
    ...counted(
      state.notRecalculated,
      "health.state.notRecalculated.one",
      "health.state.notRecalculated",
    ),
    ...(unread === null ? [] : [unread]),
  ];
}

export interface VerifyButtonInput extends Omit<CheckButtonInput, "state" | "wholeCheck"> {
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
  if (input.running || input.asked)
    return checkButtonOf({ ...input, state: null, wholeCheck: false }, t, language);
  const base = {
    short: null,
    fresh: input.justChecked,
    widest: widestRunningWords(input.toCheck + input.marked, t, language),
  };
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
