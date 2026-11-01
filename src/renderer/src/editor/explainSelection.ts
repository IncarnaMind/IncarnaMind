/**
 * AI › Explain on a selection (#2348): the question goes to the assistant with the selected
 * text as a chip, and the Note is left as it is. Explaining isn't editing: a User who only
 * wants to understand a sentence never has to Undo words added to their own document.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { mindSearchScope } from "../../../shared/searchScope";
import { useComposer } from "../composer";
import { askInAssistant } from "../conversations";
import { core } from "../core";
import { translateNow } from "../i18n";
import { modelInUseOf } from "../modelInUse";
import { scopeWithin } from "../scope";
import { folderHoldsDocumentsNow } from "../scopeDocuments";
import { useAppStore } from "../store";
import { selectionForEdit } from "./editSelection";
import { mindFocusOf } from "./mindFocus";
import { closeSelectionMenu } from "./selectionDismissal";

/** How much of the selection the Question's words quote: the chip above it holds all of it. */
const QUOTE_CHARS = 48;

/** The selection in one line, cut short as a chip shows it. */
function quoteOf(text: string): string {
  const flat = text.replace(/￼/g, "").replace(/\s+/g, " ").trim();
  const characters = [...flat];
  return characters.length > QUOTE_CHARS
    ? `${characters.slice(0, QUOTE_CHARS - 1).join("")}…`
    : flat;
}

/**
 * Asks the assistant to explain what is selected in a Note, as the prototype does: the
 * selection goes with the Question as a chip, the assistant opens where the User left it
 * (unfolded, and docked as it was), and nothing in the Note changes. False when nothing is
 * selected.
 */
export async function explainSelection(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
): Promise<boolean> {
  if (editor.isDestroyed) return false;
  const selection = selectionForEdit(editor.state);
  if (!selection) return false;
  const focus = mindFocusOf(editor.state);
  const state = useAppStore.getState();
  const folderId = state.minds.find((each) => each.id === mindId)?.folderId ?? null;
  const scope = mindSearchScope(
    useComposer.getState().draft(mindId).scope,
    folderId,
    folderHoldsDocumentsNow(folderId),
  );
  // The menu goes, as for an edit: its answer is elsewhere (#2348).
  closeSelectionMenu(editor);
  // The Assistant's own opening: the rail unfolds, and the note keeps the cursor where it was.
  if (state.layout?.assistant.folded) void state.placeAssistant({ folded: false });
  const wall = await core.wallOfTurn({ mindId, conversationId: null }).catch(() => null);
  return askInAssistant({
    mindId,
    text: translateNow("editor.ai.explain.ask", {
      quote: quoteOf(focus.selection === "" ? selection.text : focus.selection),
    }),
    focus,
    scope: scopeWithin(wall, scope),
    model: modelInUseOf(doc),
  });
}
