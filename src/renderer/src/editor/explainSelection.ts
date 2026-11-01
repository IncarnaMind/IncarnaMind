/**
 * AI › Explain on a selection (#2348): the question goes to the assistant with the selected
 * text as a chip, and the Note is left as it is. Explaining isn't editing: a User who only
 * wants to understand a sentence never has to Undo words added to their own document.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { mindSearchScope } from "../../../shared/searchScope";
import { useComposer } from "../composer";
import { answerBeingWritten, askInAssistant } from "../conversations";
import { core } from "../core";
import { queueExplain } from "../explainQueue";
import { translateNow } from "../i18n";
import { modelInUseOf } from "../modelInUse";
import { revealAssistant } from "../quietAssistant";
import { scopeWithin } from "../scope";
import { folderHoldsDocumentsNow } from "../scopeDocuments";
import { useAppStore } from "../store";
import { quoteOf, selectionForEdit } from "./editSelection";
import { mindFocusOf } from "./mindFocus";
import { closeSelectionMenu } from "./selectionDismissal";

/**
 * Asks the assistant to explain what is selected in a Note, as the prototype does: the
 * selection goes with the Question as a chip, the assistant opens where the User left it
 * (revealed and unfolded, docked as it was), and nothing in the Note changes. Asked while an
 * Answer is being written, it waits in view, cancellable, until that Answer is done: one
 * Answer at a time, one Stop. False when nothing is selected.
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
  revealAssistant();
  const wall = await core.wallOfTurn({ mindId, conversationId: null }).catch(() => null);
  const question = {
    mindId,
    text: translateNow("editor.ai.explain.ask", {
      quote: quoteOf(focus.selection === "" ? selection.text : focus.selection),
    }),
    focus,
    scope: scopeWithin(wall, scope),
    model: modelInUseOf(doc),
  };
  // An Answer being written goes first: the Question waits in view, and can be cancelled.
  if (answerBeingWritten() !== null) {
    queueExplain(question);
    return true;
  }
  return askInAssistant(question);
}
