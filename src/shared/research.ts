/** The kind of Task that does research (#130). */
export const RESEARCH_TASK = "research";

/** Why a Task behind a Folder wall made nothing: that Folder can't be filed in now (#1934). */
export const KEPT_INSIDE = "kept-inside";

/** The longest topic Research takes, in characters. */
export const MAX_RESEARCH_TOPIC = 2_000;
/** The longest step of a plan, in characters. */
export const MAX_RESEARCH_STEP = 300;
/** The most steps a plan has before its draft. */
export const MAX_RESEARCH_STEPS = 8;

/**
 * What a plan of so many steps costs, in Answers' worth (`estimateRun`'s
 * items): a step searches and reads pages, which the model reads again with
 * each call, about four Answers; the draft is one more. Its web searches are
 * counted on their own.
 */
export const researchItems = (steps: number) => steps * 4 + 1;

/** How long a plan of so many steps takes, in minutes: about one to two a step, and the draft. */
export const researchMinutes = (steps: number) => ({ from: steps + 1, to: steps * 2 + 2 });
