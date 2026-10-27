export const BADGE_MARKS = ["contradicted", "unsupported", "notFound", "notChecked"] as const;
export type BadgeMark = (typeof BADGE_MARKS)[number];

export interface BadgeInput {
  /** How many sentences or Citations each part of the Mind's health has. */
  marks: Readonly<Partial<Record<BadgeMark, number>>>;
  /** Every claim a check reads, to check or covered (#1909): the badge shows on every note with one (D266). */
  checkable: number;
  /** Every sentence a check still has to make (#1909): what a Verify badge counts. */
  toCheck: number;
  running: boolean;
  asking: boolean;
  /** A check the User started couldn't run or failed. */
  problem: boolean;
  /** What a check the User started checked, until they next type: a Verify run's own result. */
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

/** What the badge's visibility reads: apart from what it shows (#1194, #1909, D266). */
export interface BadgeShown {
  /** How many problem marks it would show. */
  marks: number;
  /** The claims a check reads: with one, the badge says the note's state. */
  checkable: number;
  running: boolean;
  asking: boolean;
  problem: boolean;
  /** What a check the User started checked. */
  checked: boolean;
  quiet?: boolean;
}

/**
 * Whether the check badge shows: a run, a question, a problem, or what a run
 * just checked always do; otherwise a note with checkable sentences does,
 * whatever its Citations (D266), so its state is always where the User
 * writes. The quiet first open stays bare (#856).
 */
export function badgeShows(input: BadgeShown): boolean {
  if (input.running || input.asking || input.problem || input.checked) return true;
  if (input.quiet) return false;
  return input.marks > 0 || input.checkable > 0;
}

/**
 * What the check badge shows, or null for nothing. A Mind's resting states
 * come from `noteStateOf` (D266); a Verify run shows its marks and counts.
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
    checkable: input.quiet ? 0 : input.checkable,
    running: input.running,
    asking: input.asking,
    problem: input.problem,
    checked: input.checked !== null,
    ...(input.quiet && { quiet: true }),
  });
  if (!shown) return null;
  return { marks, toCheck, running: input.running, checked: input.checked };
}
