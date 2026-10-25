import type { Editor } from "@tiptap/core";
import type { ClaimCheckAction } from "../../../core/api";
import { verificationOf } from "../../../shared/verification";
import { documentsAdded, useAddedDocuments } from "../addedDocuments";
import { checkSentences, useChecks } from "../checks";
import type { ShownClaim } from "../editor/claimChecks";
import { selectionForEdit } from "../editor/editSelection";
import { startMindCheck } from "../mindCheck";
import {
  contradictedAt,
  cutSentence,
  cutUnsupported,
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

/** Find support and Check against Documents (#96), on the selected sentences, from ⌘K. */
const checkCommand = (
  action: ClaimCheckAction,
  label: "editor.ai.findSupport" | "editor.ai.checkAgainstDocuments",
): Command => ({
  id: action === "find-support" ? "check.findSupport" : "check.againstDocuments",
  label,
  group: "main",
  // It changes no words: its marks go with Check again, or when the sentence is edited.
  reversible: true,
  when: () => withSentences() !== null,
  run() {
    const note = withSentences();
    if (note) void checkSentences(note.editor, note.mindId, note.doc, action);
  },
});

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
  checkCommand("find-support", "editor.ai.findSupport"),
  checkCommand("check-against-documents", "editor.ai.checkAgainstDocuments"),
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
];
