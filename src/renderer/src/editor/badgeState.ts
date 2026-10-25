export const BADGE_MARKS = ["contradicted", "unsupported", "notFound", "notChecked"] as const;
export type BadgeMark = (typeof BADGE_MARKS)[number];

export interface BadgeInput {
  /** How many sentences or Citations each part of the Mind's health has. */
  marks: Readonly<Partial<Record<BadgeMark, number>>>;
  /** Every sentence a check still has to make (#1909). */
  toCheck: number;
  /** How many of them have a Citation or an Answer's words: what makes the badge show (#1194). */
  citable: number;
  running: boolean;
  asking: boolean;
  /** A check the User started couldn't run or failed. */
  problem: boolean;
  /** What a check the User started checked, until they next type. */
  checked: number | null;
  /** The quiet first open (#856): only a run, a question or a problem shows it, never the marks alone. */
  quiet?: boolean;
}

export interface Badge {
  marks: { part: BadgeMark; count: number }[];
  toCheck: number;
  running: boolean;
  checked: number | null;
}

/** What the badge's visibility reads: apart from the count it shows (#1194, #1909). */
export interface BadgeShown {
  /** How many problem marks it would show. */
  marks: number;
  toCheck: number;
  /** The to-check sentences with a Citation or an Answer's words. */
  citable: number;
  running: boolean;
  asking: boolean;
  problem: boolean;
  /** What a check the User started checked. */
  checked: boolean;
  quiet?: boolean;
}

/**
 * Whether the check badge shows: a run, a question, a problem, or what a run
 * just checked always do; otherwise its marks do, and its count does only when
 * a Citation or an Answer's words are among the sentences to check, so a Mind
 * of plain notes stays bare (#1194).
 */
export function badgeShows(input: BadgeShown): boolean {
  if (input.running || input.asking || input.problem || input.checked) return true;
  if (input.quiet) return false;
  return input.marks > 0 || (input.toCheck > 0 && input.citable > 0);
}

/**
 * What the check badge shows, or null for nothing. "Needs re-check" and
 * "with no Citation" are in its card but never show it on their own.
 */
export function badgeOf(input: BadgeInput): Badge | null {
  const marks = input.quiet
    ? []
    : BADGE_MARKS.flatMap((part) => {
        const count = input.marks[part] ?? 0;
        return count > 0 ? [{ part, count }] : [];
      });
  const toCheck = input.quiet ? 0 : input.toCheck;
  const shown = badgeShows({
    marks: marks.length,
    toCheck,
    citable: input.citable,
    running: input.running,
    asking: input.asking,
    problem: input.problem,
    checked: input.checked !== null,
    ...(input.quiet && { quiet: true }),
  });
  if (!shown) return null;
  return { marks, toCheck, running: input.running, checked: input.checked };
}
