import type { WorkKind } from "../../../../core/api";
import type { CommandId } from "../../../../shared/commands";
import type { MessageKey } from "../../../../shared/i18n";

/** A step of Get started: the standard three, or the meetings card's first two (#3296). */
export type CardStep = "files" | "question" | "citation" | "record" | "notes";

const STANDARD: readonly CardStep[] = ["files", "question", "citation"];
const MEETINGS: readonly CardStep[] = ["record", "notes", "citation"];

/** The card's steps, in order, for the work the User picked first. */
export const cardStepsOf = (work: WorkKind | undefined): readonly CardStep[] =>
  work === "meetings" ? MEETINGS : STANDARD;

export interface StepWords {
  title: MessageKey;
  done: MessageKey;
  /** The line under an open step's title. */
  body: MessageKey | null;
  /** The link that shows the step in the example. */
  example: MessageKey | null;
}

type Worded = "finance" | "legal" | "research" | "reports";
const isWorded = (work: WorkKind | undefined): work is Worded =>
  work === "finance" || work === "legal" || work === "research" || work === "reports";

/** A step's words in the User's work; Something else, or no pick, keeps the standard ones. */
export function stepWords(work: WorkKind | undefined, step: CardStep): StepWords {
  if (step === "record") {
    return {
      title: "firstOpen.work.meetings.record",
      done: "firstOpen.work.meetings.record.done",
      body: "firstOpen.work.meetings.record.body",
      example: null,
    };
  }
  if (step === "notes") {
    return {
      title: "firstOpen.work.meetings.notes",
      done: "firstOpen.work.meetings.notes.done",
      body: "firstOpen.work.meetings.notes.body",
      example: null,
    };
  }
  if (step === "citation" && (isWorded(work) || work === "meetings")) {
    return {
      title: `firstOpen.work.${work}.citation`,
      done: "firstOpen.step.citation.done",
      body: null,
      example: `firstOpen.work.${work}.citation.example`,
    };
  }
  if (isWorded(work) && step !== "citation") {
    return {
      title: `firstOpen.work.${work}.${step}`,
      done: `firstOpen.step.${step}.done`,
      body: `firstOpen.work.${work}.${step}.body`,
      example: null,
    };
  }
  return {
    title: `firstOpen.step.${step}.title`,
    done: `firstOpen.step.${step}.done`,
    body: `firstOpen.step.${step}.body`,
    example: step === "citation" ? "firstOpen.step.citation.example" : null,
  };
}

/** A feature the done card points to next, each one a command the app has today. */
export type NextFeature =
  | "checkFile"
  | "compare"
  | "exportWord"
  | "ownReport"
  | "citationStyle"
  | "findSources"
  | "addFiles"
  | "record";

/**
 * The command each feature runs, on the example Note where it needs one. Word is the export's
 * own command while it is the last format chosen, and its "Export as" command otherwise.
 */
export const FEATURE_COMMANDS: Readonly<Record<NextFeature, readonly CommandId[]>> = {
  checkFile: ["verify.document"],
  compare: ["comparison.start"],
  exportWord: ["mind.exportAs.docx", "mind.export"],
  ownReport: ["word.import"],
  citationStyle: ["mind.citationStyle"],
  findSources: ["sources.find"],
  addFiles: ["documents.addFilesOrFolder"],
  record: ["meeting.record"],
};

const NEXT_FOR: Readonly<Record<WorkKind, readonly NextFeature[]>> = {
  finance: ["checkFile", "compare", "exportWord"],
  legal: ["compare", "exportWord"],
  research: ["citationStyle", "findSources"],
  reports: ["ownReport", "exportWord", "checkFile"],
  meetings: ["addFiles"],
  other: ["compare", "record", "exportWord"],
};

/** Three features at most, merged across the picks: each pick's first, then each one's second. */
export function nextFeatures(work: readonly WorkKind[]): NextFeature[] {
  const picks = work.length > 0 ? work : (["other"] as const);
  const merged: NextFeature[] = [];
  for (let at = 0; at < 3; at++) {
    for (const kind of picks) {
      const feature = NEXT_FOR[kind][at];
      if (feature && merged.length < 3 && !merged.includes(feature)) merged.push(feature);
    }
  }
  return merged;
}

/** "Next for {work}:", or "Next for you:" for several picks or Something else. */
export const nextLeadOf = (work: readonly WorkKind[]): MessageKey => {
  const [only, ...more] = work;
  return only && only !== "other" && more.length === 0
    ? `firstOpen.next.${only}`
    : "firstOpen.next.you";
};
