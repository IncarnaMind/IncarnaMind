/**
 * The two rounds of the earlier-call gate (#3005, `gates/call-help-earlier-calls.md`): each set's
 * cases, how long before the live call each case's earlier call starts, and which cases put the
 * earlier call first in saying what the live call asks about, each listed as the gate file lists
 * it, by the case's id without its language ("e-then-f").
 */
import { EARLIER_CALL_CASES, type EarlierCallCase } from "./callHelpEarlierCalls";
import { EARLIER_CALL_CASES_2 } from "./callHelpEarlierCalls2";

export const EARLIER_CALL_SETS = ["call-help-earlier-calls", "call-help-earlier-calls-2"] as const;
export type EarlierCallSet = (typeof EARLIER_CALL_SETS)[number];

/** How long before the live call its earlier call starts: days before, or hours before on the same day. */
export type Dating = { days: number } | { sameDayHours: number };

export interface Round {
  cases: readonly EarlierCallCase[];
  datings: Readonly<Record<string, Dating>>;
  /** The cases whose earlier call said it first; every other case's earlier call brings the changes. */
  saidFirst: readonly string[];
}

const SIX_DAYS: Dating = { days: 6 };
const TWENTY_DAYS: Dating = { days: 20 };
const SAME_DAY: Dating = { sameDayHours: 3 };

export const ROUNDS: Readonly<Record<EarlierCallSet, Round>> = {
  "call-help-earlier-calls": {
    cases: EARLIER_CALL_CASES,
    datings: {
      "a-then-b": SIX_DAYS,
      "b-then-a": SIX_DAYS,
      "c-then-d": SIX_DAYS,
      "d-then-c": SIX_DAYS,
    },
    saidFirst: ["a-then-b", "c-then-d"],
  },
  "call-help-earlier-calls-2": {
    cases: EARLIER_CALL_CASES_2,
    datings: {
      "e-then-f": SIX_DAYS,
      "f-then-e": SIX_DAYS,
      "g-then-h": TWENTY_DAYS,
      "h-then-g": TWENTY_DAYS,
      "i-then-j": SAME_DAY,
      "j-then-i": SAME_DAY,
    },
    saidFirst: ["e-then-f", "g-then-h", "i-then-j", "j-then-i"],
  },
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The same-day dating needs the day this much older than its hours, for the run to reach it. */
const SAME_DAY_ROOM_MS = HOUR_MS;

/** A case's id without its language: "en-e-then-f" gives "e-then-f". */
export const withoutLanguage = (caseId: string) => caseId.replace(/^[a-z]{2}-/, "");

/** An item's case: "en-e-then-f-last-time" gives "en-e-then-f". */
export const caseOfItem = (itemId: string) =>
  itemId.replace(/-(?:say|answer|check|last-time)$/, "");

/** The order of the item's case by its round's lists; null for a case the round doesn't list. */
export function orderOf(
  set: EarlierCallSet,
  itemId: string,
): "said-first" | "brings-changes" | null {
  const { datings, saidFirst } = ROUNDS[set];
  const id = withoutLanguage(caseOfItem(itemId));
  if (saidFirst.includes(id)) return "said-first";
  return datings[id] === undefined ? null : "brings-changes";
}

/** How many milliseconds before the live call the earlier call starts. */
export function earlierBy(dating: Dating): number {
  return "days" in dating ? dating.days * DAY_MS : dating.sameDayHours * HOUR_MS;
}

/**
 * A round's cases, each with its dating, or why the run can't start: no cases yet, a case its
 * round doesn't date, a case named twice, or a same-day dating too early in the day to fall on it.
 */
export function datedCases(
  name: string,
  { cases, datings }: Round,
  now: Date,
): { each: EarlierCallCase; dating: Dating }[] {
  if (cases.length === 0) {
    throw new Error(
      `The set ${name} holds no cases yet: its cases are put in eval/speed/callHelpEarlierCalls2.ts for the gated run.`,
    );
  }
  const ids = cases.map((each) => each.id);
  const twice = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (twice.length > 0) throw new Error(`The set ${name} names ${twice.join(", ")} twice.`);
  const undated = ids.filter((id) => datings[withoutLanguage(id)] === undefined);
  if (undated.length > 0) {
    throw new Error(
      `The set ${name} has cases its gate doesn't date: ${undated.join(", ")} (eval/speed/earlierCallsRounds.ts).`,
    );
  }
  const dated = cases.map((each) => ({
    each,
    dating: datings[withoutLanguage(each.id)] as Dating,
  }));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const sameDay = dated.find(({ dating }) => "sameDayHours" in dating);
  if (
    sameDay &&
    now.getTime() - midnight.getTime() < earlierBy(sameDay.dating) + SAME_DAY_ROOM_MS
  ) {
    throw new Error(
      `The set ${name} dates ${sameDay.each.id}'s earlier call earlier the same day: run it later in the day, so that call falls on today.`,
    );
  }
  return dated;
}

/** The round's cases with their datings, as `datedCases` gives them. */
export const roundCases = (set: EarlierCallSet, now: Date) => datedCases(set, ROUNDS[set], now);
