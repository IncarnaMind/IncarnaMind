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
import {
  CITATION_NODE,
  type Citation,
  type CitedSelection,
  type Document,
  type TabItem,
  type WindowLayout,
} from "../../core/api";
import { citationClosingLength } from "../../shared/citations";
import { checkAgain, fixesFree, restoreCheck } from "./checks";
import { citationAttributesOf } from "./citedSelection";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { mindEditor, whenMindEditor } from "./editor/openEditors";
import { editorDoc } from "./editor/proposalReview";
import { noteBusy } from "./editWithAi";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { offersNotFound } from "./unsupportedFixes";

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

const holds = (layout: WindowLayout | null, held: (item: TabItem) => boolean): boolean =>
  (layout?.groups ?? []).some((group) => group.tabs.some((tab) => held(tab.item)));

let stopWatching: (() => void) | null = null;

/**
 * Ends the wait once no tab holds the Document it waits in, or the Note its sentence is in, as
 * closing either tab does; only after a tab has held it, as the Document's opens once the wait has
 * begun.
 */
function watchPickTab(): void {
  if (stopWatching) return;
  let heldDocument: string | null = null;
  let heldNote: string | null = null;
  const look = () => {
    const { pick } = useCitationPick.getState();
    if (!pick) {
      stopWatching?.();
      stopWatching = null;
      return;
    }
    const { layout } = useAppStore.getState();
    const { documentId, mindId } = pick;
    const documentInTab = holds(
      layout,
      (item) => item.kind === "document" && item.documentId === documentId,
    );
    const noteInTab = holds(layout, (item) => item.kind === "mind" && item.mindId === mindId);
    if (documentInTab) heldDocument = documentId;
    if (noteInTab) heldNote = mindId;
    if ((!documentInTab && heldDocument === documentId) || (!noteInTab && heldNote === mindId)) {
      dropCitationPick();
    }
  };
  const fromLayout = useAppStore.subscribe(look);
  const fromPick = useCitationPick.subscribe(look);
  stopWatching = () => {
    fromLayout();
    fromPick();
  };
  look();
}

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
  watchPickTab();
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

/**
 * The Note's editor, its tab brought to the front when another is in front of it, as a window
 * under 1,000 px puts the Document in front of the Note; null when no tab holds the Note.
 */
async function noteEditor(mindId: string): Promise<Editor | null> {
  const open = mindEditor(mindId);
  if (open) return open;
  const state = useAppStore.getState();
  const tab = (state.layout?.groups ?? [])
    .flatMap((group) => group.tabs)
    .find((each) => each.item.kind === "mind" && each.item.mindId === mindId);
  if (!tab) return null;
  await state.changeLayout({ type: "show", tabId: tab.id });
  return whenMindEditor(mindId, 5_000);
}

/** The sentence a pick waits for, while its card still offers Choose the Citation…. */
async function waitingSentence(
  pick: CitationPick,
): Promise<{ editor: Editor; claim: ShownClaim } | null> {
  const editor = await noteEditor(pick.mindId);
  const claim = editor
    ? shownClaims(editor.state).find((each) => each.check.id === pick.checkId)
    : undefined;
  return editor && claim && offersNotFound(editor, claim) ? { editor, claim } : null;
}

/**
 * Use as Citation: cites the selection as `cite` finds it for the Note the pick waits in, which
 * a Folder wall may refuse, at the end of the sentence the pick waits for, and checks the
 * sentence again, in every Document, as the User pointed outside the scope it searched. Says
 * whether the Citation went in.
 */
export async function citeChosenWords(
  pick: CitationPick,
  document: Pick<Document, "id" | "name">,
  cite: (mindId: string) => Promise<CitedSelection>,
): Promise<boolean> {
  let cited: CitedSelection;
  try {
    cited = await cite(pick.mindId);
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
  if (cited.check !== "found") {
    showError(translateNow("viewer.selection.refused.unsure"));
    return false;
  }
  const waiting = await waitingSentence(pick);
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
