/**
 * The Mind's column (DESIGN.md, Layout, Mind column): a 680px measure between a
 * margin for controls and one for checks, whose margins narrow to 40px before
 * they fold away at 760px, the folded column keeping that 40px as a gutter on
 * each side. `styles.css` holds the same rule for the page; this is the one its
 * parts that live in script read.
 */
export const MIND_FOLD = 760;
export const MIND_GUTTER = 40;

/** Whether a column this wide has folded its margins, the checks moving into the text. */
export const mindFolded = (columnWidth: number) => columnWidth < MIND_FOLD;
