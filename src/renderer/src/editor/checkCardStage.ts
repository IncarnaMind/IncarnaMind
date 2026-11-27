import type { MindCheckRun } from "../../../core/api";
import type { Language } from "../../../core/language";
import { formatDateTime } from "../../../shared/dates";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import type { NoteState } from "../noteState";
import { type CheckRow, checkRows, healthSummary, type NoteHealth } from "./healthCounts";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * Where the Note's check stands, as the card's first line says it (#3840): a run going and how far
 * it has got, in the run's words, or none for sentences being checked with no run counted here;
 * sentences waiting for the Note's first whole check, counted on the line under the head or,
 * beside the results of checks made so far, on their own row (`inRow`); or done, with when, and
 * All supported when nothing is left to look at.
 */
export type CardStage =
  | { kind: "checking"; words: string | null; done: number; total: number }
  | { kind: "not-checked"; sentences: number; inRow: boolean }
  | { kind: "done"; at: string | null }
  | { kind: "clean"; at: string | null; sentences: number };

/**
 * Whether the Note's last whole check still speaks for it: one ran to its end, the app's or the
 * User's own AI's, a check's result still holds, and no sentence it read is one the model couldn't
 * decide (#1682), which still waits for the Note's Check. Sentences added or edited since leave it
 * standing: the Note keeps its verdict, and the card offers to check them (#3840).
 */
export const wholeCheckStands = (
  run: MindCheckRun | null,
  health: Pick<NoteHealth, "checkedAt" | "unexamined">,
): boolean =>
  run !== null && run.stop === null && health.checkedAt !== null && health.unexamined.length === 0;

export function cardStageOf({
  progress,
  state,
  wholeCheck,
  health,
  problem,
}: {
  /** A run going now, as the Note's button counts it. */
  progress: { words: string; done: number; total: number } | null;
  state: NoteState | null;
  wholeCheck: boolean;
  health: NoteHealth;
  /** A problem with a check waits in the card. */
  problem: boolean;
}): CardStage | null {
  if (progress) return { kind: "checking", ...progress };
  if (health.checking.length > 0) return { kind: "checking", words: null, done: 0, total: 0 };
  if (state === null) return null;
  if (!wholeCheck && state.notChecked > 0) {
    const inRow = checkRows(health).some(({ row }) => row !== "toCheck");
    return { kind: "not-checked", sentences: state.notChecked, inRow };
  }
  // When the newest check ended, as Home and the Saved line say it.
  const at = health.checkedAt;
  return allSupported(health, state, problem)
    ? { kind: "clean", at, sentences: health.supported }
    : { kind: "done", at };
}

/**
 * "All supported" only where it is true: nothing left, kept as written, a writer's own view or
 * unread.
 */
function allSupported(health: NoteHealth, state: NoteState, problem: boolean): boolean {
  const summary = healthSummary(health, {
    running: false,
    problem,
    unread: state.unreadMatters ? state.unread : 0,
  });
  return (
    summary?.kind === "all" &&
    state.unread === 0 &&
    health.kept.length === 0 &&
    health.keptCharts.length === 0 &&
    health.ownViews.length === 0
  );
}

/**
 * Whether the card shows a row at this stage: never one its head, its line or its foot already
 * counts — the sentences being checked or waiting, or every one supported.
 */
export function rowShownAt(stage: CardStage | null, row: CheckRow): boolean {
  switch (stage?.kind) {
    case "checking":
      return row !== "checking" && row !== "toCheck";
    case "not-checked":
      return row !== "toCheck" || stage.inRow;
    case "done":
      return row !== "toCheck";
    case "clean":
      return row !== "supported";
    default:
      return true;
  }
}

/** The head's words, and what stands at its right end: how far a run has got, or when it ended. */
export function cardHeadWords(
  stage: CardStage,
  t: Translate,
  language: Language,
): { words: string; aside: string | null } {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const when = (at: string | null) => (at === null ? null : formatDateTime(at, language));
  switch (stage.kind) {
    case "checking":
      return stage.total > 0
        ? {
            words: t("checkButton.checking.uncounted"),
            aside: t("checks.head.progress", {
              done: format(stage.done),
              total: format(stage.total),
            }),
          }
        : { words: stage.words ?? t("checkButton.checking.uncounted"), aside: null };
    case "not-checked":
      return { words: t("checks.head.notChecked"), aside: null };
    case "done":
      return { words: t("checks.head.done"), aside: when(stage.at) };
    case "clean":
      return { words: t("health.allSupported"), aside: when(stage.at) };
  }
}
