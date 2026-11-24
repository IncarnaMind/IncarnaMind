import type { KeptDeckStates } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { languageNow } from "../i18n";
import { putBack, useKeptDecks, versionHere } from "../viewer/slides/deckEditing";
import type { Command, CommandContext } from "./registry";
import { documentsOf } from "./targets";

/** The one deck the command acts on, with what it can be put back to that the file doesn't hold. */
function keptOf(ctx: CommandContext, which: keyof KeptDeckStates) {
  const documents = documentsOf(ctx);
  const [document] = documents;
  if (documents.length !== 1 || !document || document.kind !== "pptx") return null;
  const kept = useKeptDecks.getState().byDocument[document.id]?.[which];
  if (!kept || kept.contentHash === versionHere(document)) return null;
  return { document, kept };
}

/**
 * A deck of the User's own that a hand edit wrote (#149) is put back, as one step Undo takes back:
 * as it was before its latest sitting, or as it was before IncarnaMind first changed it. Each
 * writes the User's own file, which only their hand does: no Tool of the core reaches it.
 */
export const deckCommands: readonly Command[] = [
  {
    id: "document.putBack",
    label: (ctx, t) => {
      const found = keptOf(ctx, "sitting");
      return found
        ? t("viewer.deck.putBack.at", { time: formatDateTime(found.kept.keptAt, languageNow()) })
        : t("viewer.deck.putBack");
    },
    menuLabel: "viewer.deck.putBack",
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => keptOf(ctx, "sitting") !== null,
    reversible: true,
    assistant: false,
    run: (ctx) => {
      const found = keptOf(ctx, "sitting");
      if (found) putBack(found.document, "sitting");
    },
  },
  {
    id: "document.putBackFirst",
    label: (_ctx, t) => t("viewer.deck.putBackFirst"),
    menuLabel: "viewer.deck.putBackFirst",
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => keptOf(ctx, "first") !== null,
    reversible: true,
    assistant: false,
    run: (ctx) => {
      const found = keptOf(ctx, "first");
      if (found) putBack(found.document, "first");
    },
  },
];
