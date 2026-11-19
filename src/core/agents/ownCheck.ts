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

// Measured with these words (#3342, #3363), sent as they are here.
export const howToJudge = (folderId: string | null): string =>
  [
    "Judge every sentence below by these rules, one sentence at a time, each on its own.",
    "",
    judgingRules(),
    "- nothing to check: the sentence says nothing about its subject for a Document to state. It is only about the note itself (where its figures come from, what it covers or leaves out, how or for whom it was written), a greeting, a question, or a bare title.",
    "",
    `For each sentence: search the Documents with \`search\`${folderId === null ? "" : `, with folderIds ["${folderId}"]`}, in the Documents' language, again with other words if the Passages don't decide it (three searches at most); read on with \`read_passages\` where a Passage is cut short. Get a Citation with \`cite\` for every quote that decides the sentence. A supported or contradicted result needs one, unless it rests on a run; for overstated, partly supported and own view, cite what the Passages do state.`,
    "A figure no Passage states (a total or a count over a sheet's rows, a count of the Documents, Folders or Notes you may read, a sum of figures Passages give) is worked out with `run_analysis` or `calculate`, never in your head, and its result rests on that run: give its id as `run`, not a quote that doesn't state the figure.",
    "Then call `report_check` once, with the task given here and a result for every sentence: its number, the verdict, the [cite:…] Citations or the run it rests on, and one plain sentence of explanation in the note's language.",
  ].join("\n");
