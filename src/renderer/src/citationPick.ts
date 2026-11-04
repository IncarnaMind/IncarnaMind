/**
 * Choose the Citation… (#1554): the User gives a sentence the check didn't find its Citation.
 * The chosen Document opens beside the Note, and while the pick waits that Document's selection
 * menu offers Use as Citation. The words become a Citation only where the core finds them in the
 * Document's own text at the place selected (`citeSelection`), never from the page's drawn words;
 * a selection it can't place there, or whose words a scan may have misread, is refused with a
 * plain line. The Citation goes at the sentence's end, as Add as Citation puts one, in one step of
 * Undo that brings back the check the sentence had, and the sentence is checked again on it.
 */
import type { Editor } from "@tiptap/core";
import { create } from "zustand";
import { CITATION_NODE, type Citation, type CitedSelection, type Document } from "../../core/api";
import { checkAgain, citationClosingLength } from "./checks";
import { citationAttributesOf } from "./citedSelection";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { mindEditor } from "./editor/openEditors";
import { editorDoc } from "./editor/proposalReview";
import { noteBusy } from "./editWithAi";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { fixesFree, offersNotFound, restoreCheck } from "./unsupportedFixes";

/** A sentence waiting for its Citation, its words, and the Document it is chosen in. */
export interface CitationPick {
  mindId: string;
  checkId: string;
  documentId: string;
  sentence: string;
}

export const useCitationPick = create<{
  pick: CitationPick | null;
  /** The sentence check whose card was asked, from ⌘K, to open its picker. */
  asked: string | null;
}>()(() => ({ pick: null, asked: null }));

/** Asks the card of `checkId` to open its picker of Documents. */
export const requestCitationPicker = (checkId: string | null) =>
  useCitationPick.setState({ asked: checkId });

/** The pick the viewer of `documentId` offers Use as Citation for; null for none. */
export const usePickIn = (documentId: string): CitationPick | null =>
  useCitationPick((state) => (state.pick?.documentId === documentId ? state.pick : null));

export const dropCitationPick = () => useCitationPick.setState({ pick: null });

/**
 * Opens the Document beside the Note, with the sentence waiting for its Citation: at the Passage
 * `at`, when given, its words shown, else at its start. `inGroup`: in place of the Document the
 * sentence waited in, in that group, rather than in one more beside it.
 */
export function chooseCitationIn(
  pick: CitationPick,
  at?: Pick<Citation, "pageFrom" | "pageTo" | "quote"> | null,
  inGroup?: string,
): void {
  useCitationPick.setState({ pick });
  useAppStore.getState().openDocument(
    {
      documentId: pick.documentId,
      ...(at && {
        pageFrom: at.pageFrom ?? undefined,
        pageTo: at.pageTo ?? undefined,
        quote: at.quote,
      }),
    },
    inGroup === undefined ? { as: "citation", keep: true } : { as: "here", from: inGroup },
  );
}

const showError = (message: string) => useNotices.getState().showError(new Error(message));

/** The sentence a pick waits for, while its card still offers Choose the Citation…. */
function waitingSentence(pick: CitationPick): { editor: Editor; claim: ShownClaim } | null {
  const editor = mindEditor(pick.mindId);
  const claim = editor
    ? shownClaims(editor.state).find((each) => each.check.id === pick.checkId)
    : undefined;
  return editor && claim && offersNotFound(editor, claim) ? { editor, claim } : null;
}

/**
 * Use as Citation: cites the selection as `cite` finds it, at the end of the sentence the pick
 * waits for, and checks the sentence again, in every Document, as the User pointed outside the
 * scope it searched. Says whether the Citation went in.
 */
export async function citeChosenWords(
  pick: CitationPick,
  document: Pick<Document, "id" | "name">,
  cite: () => Promise<CitedSelection>,
): Promise<boolean> {
  let cited: CitedSelection;
  try {
    cited = await cite();
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
  if (cited.check !== "found") {
    showError(translateNow("viewer.selection.refused.unsure"));
    return false;
  }
  const waiting = waitingSentence(pick);
  const doc = waiting && editorDoc(waiting.editor);
  if (!waiting || !doc) {
    dropCitationPick();
    showError(translateNow("error.check.partChanged"));
    return false;
  }
  const { editor, claim } = waiting;
  if (!fixesFree(pick.mindId)) {
    noteBusy(pick.mindId);
    return false;
  }
  const type = editor.state.schema.nodes[CITATION_NODE];
  if (!type) return false;
  const words = editor.state.doc.textBetween(claim.sentence.from, claim.sentence.to, "\n", "￼");
  const at = claim.sentence.to - citationClosingLength(words);
  const earlier = claim.check;
  asOneStep(editor, () =>
    editor.view.dispatch(
      editor.state.tr.insert(at, type.create(citationAttributesOf(cited, document))),
    ),
  );
  dropCitationPick();
  const recheck = () => {
    const again = shownClaims(editor.state).find((each) => each.check.id === earlier.id);
    if (again) void checkAgain(editor, pick.mindId, doc, again, true);
  };
  offerEditorUndo(
    editor,
    (t) => t("claim.chosenCitation.done"),
    undefined,
    () => restoreCheck(editor, claim, earlier),
    recheck,
  );
  recheck();
  return true;
}
