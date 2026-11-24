import { formatDateTime } from "../../../shared/dates";
import { languageNow } from "../i18n";
import { useAppStore } from "../store";
import { putBack, useKeptDecks } from "../viewer/slides/deckEditing";
import type { Command, CommandContext } from "./registry";
import { documentsOf } from "./targets";

/** The one deck the command acts on, with its states kept before each sitting of hand editing. */
function keptOf(ctx: CommandContext) {
  const documents = documentsOf(ctx);
  const [document] = documents;
  if (documents.length !== 1 || !document || document.kind !== "pptx") return null;
  const kept = useKeptDecks.getState().byDocument[document.id] ?? [];
  const [newest] = kept;
  return newest ? { document, newest } : null;
}

/**
 * A deck of the User's own that a hand edit wrote (#149) is put back as it was before that
 * sitting, as one step Undo takes back: the file kept just before it was written.
 */
export const deckCommands: readonly Command[] = [
  {
    id: "document.putBack",
    label: (ctx, t) => {
      const found = keptOf(ctx);
      return found
        ? t("viewer.deck.putBack.at", {
            time: formatDateTime(found.newest.keptAt, languageNow()),
          })
        : t("viewer.deck.putBack");
    },
    menuLabel: "viewer.deck.putBack",
    group: "main",
    appliesTo: ["document"],
    when: (ctx) => keptOf(ctx) !== null,
    reversible: true,
    run: (ctx) => {
      const found = keptOf(ctx);
      if (!found) return;
      const shown =
        useAppStore.getState().documents.find((each) => each.id === found.document.id)
          ?.contentHash ?? found.document.contentHash;
      putBack(found.document, found.newest, shown);
    },
  },
];
