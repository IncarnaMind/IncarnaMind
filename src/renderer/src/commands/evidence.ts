import type { Document } from "../../../core/api";
import { countedByChoice, leftOutOfEvidence } from "../../../shared/evidence";
import { countAsEvidence, markNotCited } from "../evidence";
import { countNow } from "../i18n";
import { isListedDocument } from "../meetingTranscript";
import { useAppStore } from "../store";
import type { Command, CommandContext } from "./registry";
import { documentsOf, everyDocument, mindsOf, targetsOf } from "./targets";

/** The Transcripts of the one meeting Note a menu or ⌘K acts on (#2528); none otherwise. */
function transcriptsOf(ctx: CommandContext): Document[] {
  const minds = mindsOf(ctx);
  const [mind] = minds;
  if (!mind || minds.length !== 1 || targetsOf(ctx).length !== 1) return [];
  return useAppStore.getState().documents.filter((each) => each.meetingMindId === mind.id);
}

/** "Count it" for the files IncarnaMind wrote (#80), and taking it back. */
export const evidenceCommands: readonly Command[] = [
  {
    id: "document.countAsEvidence",
    label: (ctx, t) => {
      const count = documentsOf(ctx).length;
      return count > 1 ? t("evidence.countMany", { count: countNow(count) }) : t("evidence.count");
    },
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => {
      const { settings, library } = useAppStore.getState();
      return everyDocument(ctx, (document) => leftOutOfEvidence(document, settings, library));
    },
    reversible: true,
    run: (ctx) => countAsEvidence(documentsOf(ctx), true),
  },
  {
    id: "document.leaveOutOfEvidence",
    label: (ctx, t) => {
      const count = documentsOf(ctx).length;
      return count > 1
        ? t("evidence.leaveOutMany", { count: countNow(count) })
        : t("evidence.leaveOut");
    },
    group: "main",
    appliesTo: ["document"],
    // Only where taking the choice back leaves it out: not while Settings or its Folder counts it.
    when: (ctx) => {
      const { settings, library } = useAppStore.getState();
      return everyDocument(ctx, (document) => countedByChoice(document, settings, library));
    },
    reversible: true,
    run: (ctx) => countAsEvidence(documentsOf(ctx), false),
  },
  {
    id: "document.dontCite",
    label: (ctx, t) => {
      const count = documentsOf(ctx).length;
      return count > 1
        ? t("evidence.notCitedMany", { count: countNow(count) })
        : t("evidence.notCited");
    },
    hint: "evidence.notCited.hint",
    group: "main",
    appliesTo: ["document"],
    // A meeting's Transcript is left out from its Note's menu (#2528).
    when: (ctx) =>
      everyDocument(ctx, (document) => isListedDocument(document) && !document.notCited),
    reversible: true,
    run: (ctx) => markNotCited(documentsOf(ctx), true),
  },
  {
    id: "document.citeAgain",
    label: (ctx, t) => {
      const count = documentsOf(ctx).length;
      return count > 1
        ? t("evidence.citeAgainMany", { count: countNow(count) })
        : t("evidence.citeAgain");
    },
    group: "main",
    appliesTo: ["document"],
    when: (ctx) =>
      everyDocument(ctx, (document) => isListedDocument(document) && document.notCited),
    reversible: true,
    run: (ctx) => markNotCited(documentsOf(ctx), false),
  },
  {
    id: "mind.dontCiteTranscript",
    label: "evidence.notCited.transcript",
    hint: "evidence.notCited.hint",
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => {
      const transcripts = transcriptsOf(ctx);
      return transcripts.length > 0 && transcripts.every((each) => !each.notCited);
    },
    reversible: true,
    run: (ctx) => markNotCited(transcriptsOf(ctx), true),
  },
  {
    id: "mind.citeTranscriptAgain",
    label: "evidence.citeAgain.transcript",
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => {
      const transcripts = transcriptsOf(ctx);
      return transcripts.length > 0 && transcripts.every((each) => each.notCited);
    },
    reversible: true,
    run: (ctx) => markNotCited(transcriptsOf(ctx), false),
  },
];
