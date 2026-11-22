/**
 * What an outside agent is told when it checks a Note it wrote with its own model (#3342): the
 * rules IncarnaMind's own check judges by, and how to gather evidence and hand its results back.
 */
import type { JudgedVerdict } from "../answers/checks/judgedOutside";
import { judgingRules } from "../answers/checks/prompt";

/** The result an agent gives a sentence, in the words its rules use. */
export const OWN_VERDICTS = {
  supported: "supported",
  overstated: "overstated",
  "partly supported": "partly-supported",
  "not found": "not-found",
  contradicted: "contradicted",
  "own view": "own-view",
  "nothing to check": "nothing-to-check",
} as const satisfies Record<string, JudgedVerdict>;

export type OwnVerdict = keyof typeof OWN_VERDICTS;

export const OWN_VERDICT_WORDS = Object.keys(OWN_VERDICTS) as [OwnVerdict, ...OwnVerdict[]];

// Measured with these words (#3342, #3363, #3393), sent as they are here.
export const howToJudge = (folderId: string | null): string =>
  [
    "Judge every sentence below by these rules, one sentence at a time, each on its own.",
    "",
    judgingRules(),
    "- nothing to check: the sentence says nothing about its subject for a Document to state. It is only about the note itself (where its figures come from, what it covers or leaves out, how or for whom it was written), a greeting, a question, or a bare title.",
    "",
    `For each sentence: search the Documents with \`search\`${folderId === null ? "" : `, with folderIds ["${folderId}"]`}, in the Documents' language, again with other words if the Passages don't decide it (three searches at most); read on with \`read_passages\` where a Passage is cut short. Get a Citation with \`cite\` for every quote that decides the sentence. A supported or contradicted result needs one, unless it rests on a run; for overstated, partly supported and own view, cite what the Passages do state.`,
    "A figure no Passage states rests on how it was worked out, not on a quote that doesn't state it. A total or a count over a sheet's rows, or a count of the Documents, Folders or Notes you may read, is worked out with `run_analysis`: give its id as `run`. One worked out from numbers Passages give (a sum, a difference, a share, a product) you work out yourself and give as `working`: each input's number as a plain value with the [cite:…] whose quote holds it, the expression over their names, and the figure it gives, with its unit: for a sentence it contradicts, that right figure, not the sentence's. IncarnaMind confirms each number in its quote and that the expression gives the figure: a number the expression writes itself, other than 0, 1, 2 or 100, is in no quote, so give it as an input with its Citation.",
    "A sentence you wrote from a file IncarnaMind doesn't hold, citing it by its path, is judged against that file as it is now: read it again, and `cite` the quote that decides it with the file's `path`.",
    "Then call `report_check` once, with the task given here and a result for every sentence: its number, the verdict, the [cite:…] Citations, the run or the working it rests on, and one plain sentence of explanation in the note's language.",
  ].join("\n");
