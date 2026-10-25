/** From 1, and 0 for a Title; null for a style that isn't a heading's: "heading 2", "Title". */
export function headingLevelOfStyleName(name: string): number | null {
  const lower = name.toLowerCase();
  const heading = /^heading (\d)$/.exec(lower);
  if (heading) return Number(heading[1]);
  if (lower === "title") return 0;
  return null;
}

/** The Mind's heading level for a Word one: a Title is a first-level heading, as Word shows it biggest. */
export const mindHeadingLevel = (level: number): number => Math.min(6, Math.max(1, level));
