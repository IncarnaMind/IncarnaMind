import { countedByChoice, leftOutOfEvidence } from "../../../shared/evidence";
import { countAsEvidence, markNotCited } from "../evidence";
import { countNow } from "../i18n";
import { useAppStore } from "../store";
import type { Command } from "./registry";
import { documentsOf, everyDocument } from "./targets";

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
    when: (ctx) => everyDocument(ctx, (document) => !document.notCited),
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
    when: (ctx) => everyDocument(ctx, (document) => document.notCited),
    reversible: true,
    run: (ctx) => markNotCited(documentsOf(ctx), false),
  },
];
