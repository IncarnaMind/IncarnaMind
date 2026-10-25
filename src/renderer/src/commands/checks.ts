import type { Editor } from "@tiptap/core";
import { verificationOf } from "../../../shared/verification";
import { documentsAdded, useAddedDocuments } from "../addedDocuments";
import {
  checkSentences,
  setCheckCardOpen,
  setClaimFocus,
  setOpenClaim,
  useChecks,
} from "../checks";
import { type ShownClaim, shownClaims } from "../editor/claimChecks";
import { selectionForEdit } from "../editor/editSelection";
import { startMindCheck } from "../mindCheck";
import {
  applyFigure,
  contradictedAt,
  cutSentence,
  cutUnsupported,
  figureAt,
  fixesFree,
  keepAsView,
  notFoundAt,
  searchAllDocuments,
  searchedLess,
  uncoveredOf,
  unsupportedAt,
} from "../unsupportedFixes";
import { noteHandle } from "./handles";
import type { Command } from "./registry";

/** The Mind last written in, while it has text selected to check and no check of it runs. */
function withSentences() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || useChecks.getState().running[note.mindId]) return null;
  return selectionForEdit(note.editor.state) ? note : null;
}

/**
 * The checked sentence the caret is in: what "Show the check for this
 * sentence" opens. A caret exactly between two sentences takes the one it ends.
 */
function withClaimAtCaret() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed) return null;
  const { head } = note.editor.state.selection;
  const claims = shownClaims(note.editor.state);
  const claim =
    claims.find((each) => each.sentence.from < head && head < each.sentence.to) ??
    claims.find((each) => each.sentence.from <= head && head <= each.sentence.to) ??
    null;
  return claim ? { ...note, claim } : null;
}

function showClaimCard(at: NonNullable<ReturnType<typeof withClaimAtCaret>>): void {
  setCheckCardOpen(at.place, false);
  setOpenClaim(at.place, at.claim.check.id);
  setClaimFocus(at.place, at.claim.check.id);
}

/** Check against Documents (#96), on the selected sentences, from ⌘K; "find support" finds it too. */
const checkAgainstDocuments: Command = {
  id: "check.againstDocuments",
  label: "editor.ai.checkAgainstDocuments",
  keywords: ["editor.ai.checkAgainstDocuments.keywords"],
  group: "main",
  // It changes no words: its marks go with Check again, or when the sentence is edited.
  reversible: true,
  when: () => withSentences() !== null,
  run() {
    const note = withSentences();
    if (note) void checkSentences(note.editor, note.mindId, note.doc, "check-against-documents");
  },
};

function withAdded(): string | null {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || useChecks.getState().running[note.mindId]) return null;
  const added = useAddedDocuments.getState().byMind[note.mindId];
  return documentsAdded(added).length > 0 ? note.mindId : null;
}

function withClaim(find: (editor: Editor) => ShownClaim | null) {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || !fixesFree(note.mindId)) return null;
  const claim = find(note.editor);
  return claim ? { ...note, claim } : null;
}

const withUnsupported = () => withClaim(unsupportedAt);
const withNotFound = () => withClaim(notFoundAt);
const withContradicted = () => withClaim(contradictedAt);
const withNothingBacking = () => withUnsupported() ?? withNotFound();
const withKeepable = () => withNothingBacking() ?? withContradicted();

// A Mind made to verify someone else's document keeps their words.
function withCuttable() {
  const at = withNotFound();
  return at && verificationOf(at.doc) === null ? at : null;
}

export const checkCommands: readonly Command[] = [
  {
    id: "check.showCard",
    label: "claim.showCard",
    group: "main",
    shortcut: { keys: "CmdOrCtrl+Shift+K" },
    // It changes nothing: it shows what a check found, for a keyboard User to act on.
    reversible: true,
    when: () => withClaimAtCaret() !== null,
    run() {
      const at = withClaimAtCaret();
      if (at) showClaimCard(at);
    },
  },
  checkAgainstDocuments,
  {
    id: "check.addedDocuments",
    label: "checks.added.command",
    group: "main",
    reversible: true,
    when: () => withAdded() !== null,
    run() {
      const mindId = withAdded();
      if (mindId) void startMindCheck(mindId, "added");
    },
  },
  {
    id: "check.cutUnsupported",
    label: "claim.cutUnsupported",
    group: "main",
    // Applied as one step of the Mind's Undo.
    reversible: true,
    when: () => {
      const at = withUnsupported();
      return at !== null && uncoveredOf(at.claim) !== null;
    },
    run() {
      const at = withUnsupported();
      if (at) void cutUnsupported(at.editor, at.mindId, at.doc, at.claim);
    },
  },
  {
    id: "check.searchAllDocuments",
    label: "claim.searchAll",
    group: "main",
    // It changes no words, as Check against Documents.
    reversible: true,
    when: () => {
      const at = withNothingBacking();
      return at !== null && searchedLess(at.claim);
    },
    run() {
      const at = withNothingBacking();
      if (at) void searchAllDocuments(at.editor, at.mindId, at.doc, at.claim);
    },
  },
  {
    id: "check.cutSentence",
    label: "claim.cutSentence",
    keywords: ["claim.cutSentence.keywords"],
    group: "main",
    reversible: true,
    when: () => withCuttable() !== null,
    run() {
      const at = withCuttable();
      if (at) cutSentence(at.editor, at.claim);
    },
  },
  {
    id: "check.keepAsView",
    label: "claim.keepAsView",
    group: "main",
    reversible: true,
    when: () => withKeepable() !== null,
    run() {
      const at = withKeepable();
      if (at) keepAsView(at.editor, at.claim);
    },
  },
  {
    id: "check.useFigure",
    label: "claim.useFigure.command",
    group: "main",
    // Applied as one step of the Mind's Undo, which brings back the check it had.
    reversible: true,
    when: () => withClaim(figureAt) !== null,
    run() {
      const at = withClaim(figureAt);
      if (at) applyFigure(at.editor, at.mindId, at.doc, at.claim);
    },
  },
];
