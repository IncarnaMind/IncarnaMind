import type { Editor } from "@tiptap/core";
import { TranslatableError } from "../../../core/errors";
import { verificationOf } from "../../../shared/verification";
import { documentsAdded, useAddedDocuments } from "../addedDocuments";
import {
  checkSentences,
  fixesFree,
  requestDocumentPicker,
  requestDocumentRead,
  setCheckCardOpen,
  setClaimFocus,
  setOpenClaim,
  useChecks,
} from "../checks";
import { chooseCitationIn, requestCitationPicker } from "../citationPick";
import { applyCorrection, correctionAt } from "../correctionFixes";
import { type ShownClaim, shownClaims } from "../editor/claimChecks";
import { selectionForEdit } from "../editor/editSelection";
import { checkOpinion, opinionAt } from "../editor/opinionChecks";
import { useFindSources } from "../findSources";
import { startMindCheck } from "../mindCheck";
import { readableNow } from "../readableDocuments";
import { rewriteAt, rewriteWithDocuments } from "../rewriteFix";
import {
  applyDocumentWording,
  applyFigure,
  contradictedAt,
  cutSentence,
  cutUnsupported,
  documentWordingAt,
  figureAt,
  findSourcesAt,
  keepAsView,
  notFoundAt,
  searchAllDocuments,
  searchedLess,
  sentenceOf,
  uncoveredOf,
  unsupportedAt,
} from "../unsupportedFixes";
import { noteHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

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
const withCorrection = () => withClaim(correctionAt);
const withNothingBacking = () => withUnsupported() ?? withNotFound();
const withKeepable = () => withNothingBacking() ?? withContradicted();

// A Mind made to verify someone else's document keeps their words.
function withCuttable() {
  const at = withNotFound();
  return at && verificationOf(at.doc) === null ? at : null;
}

const withRewrite = () => {
  const doc = noteHandle.current?.doc;
  return doc ? withClaim((editor) => rewriteAt(editor, doc)) : null;
};

/**
 * What a command on the sentence at the caret acts on: its Note, or the one Document or Folder the
 * assistant found or ⌘K has in focus, when the Note may read it: on the Note's side of a Folder
 * wall, and a Document with text, as the card's picker offers them. Null for none.
 */
function sentenceTarget(
  ctx: CommandContext,
  kinds: readonly ("document" | "folder")[],
): { kind: "mind" | "document" | "folder"; id: string } | null {
  const at = withCuttable();
  const [one, ...more] = ctx.selection.length > 0 ? ctx.selection : ctx.focus ? [ctx.focus] : [];
  if (!at || !one || more.length > 0) return null;
  if (one.kind === "mind") return one.id === at.mindId ? { kind: "mind", id: one.id } : null;
  const kind = kinds.find((each) => each === one.kind);
  if (!kind) return null;
  const target = { kind, id: one.id };
  return readableNow(at.mindId, target) ? target : null;
}

function withOpinion() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || !fixesFree(note.mindId)) return null;
  const opinion = opinionAt(note.editor, note.doc);
  return opinion ? { ...note, opinion } : null;
}

export const checkCommands: readonly Command[] = [
  {
    id: "check.anyway",
    label: "claim.checkAnyway",
    group: "main",
    reversible: true,
    when: (ctx) =>
      ctx.here?.["check.anyway"] !== undefined ||
      (ctx.focus?.kind !== "check" && withOpinion() !== null),
    run(ctx) {
      const here = ctx.here?.["check.anyway"];
      if (here) {
        here();
        return;
      }
      const at = withOpinion();
      if (at) checkOpinion(at.editor, at.mindId, at.doc, at.opinion, at.place);
    },
  },
  {
    id: "check.showCard",
    label: "claim.showCard",
    group: "main",
    shortcut: { keys: "CmdOrCtrl+Shift+K" },
    // It changes nothing: it shows what a check found, for a keyboard User to act on.
    reversible: true,
    when: () => withClaimAtCaret() !== null || withOpinion() !== null,
    run() {
      const at = withClaimAtCaret();
      if (at) showClaimCard(at);
      else {
        const left = withOpinion();
        if (!left) return;
        setCheckCardOpen(left.place, false);
        setOpenClaim(left.place, left.opinion.id);
        setClaimFocus(left.place, left.opinion.id);
      }
    },
  },
  {
    id: "check.useDocumentWording",
    label: "claim.useDocumentWording",
    group: "main",
    reversible: true,
    when: (ctx) => {
      if (ctx.here?.["check.useDocumentWording"]) return true;
      const note = noteHandle.current;
      return (
        ctx.focus?.kind !== "check" &&
        note !== null &&
        !note.editor.isDestroyed &&
        fixesFree(note.mindId) &&
        documentWordingAt(note.editor) !== null
      );
    },
    run(ctx) {
      const here = ctx.here?.["check.useDocumentWording"];
      if (here) {
        here();
        return;
      }
      const note = noteHandle.current;
      if (!note || note.editor.isDestroyed) return;
      const at = documentWordingAt(note.editor);
      if (at) applyDocumentWording(note.editor, at.claim, at.part);
    },
  },
  checkAgainstDocuments,
  {
    // On the Note, the picker opens with a Document open beside it chosen; on a Document or Folder
    // the assistant names ("check this sentence against the lease"), it is read with no picker,
    // the card asking before it reads (#1554).
    id: "check.againstDocument",
    label: "claim.checkAgainstDocument",
    keywords: ["claim.checkAgainstDocument.keywords"],
    group: "main",
    appliesTo: ["mind", "document", "folder"],
    reversible: true,
    when: (ctx) => sentenceTarget(ctx, ["document", "folder"]) !== null,
    run(ctx) {
      const at = withCuttable();
      const target = sentenceTarget(ctx, ["document", "folder"]);
      if (!at || !target) return;
      showClaimCard(at);
      if (target.kind === "mind" || !ctx.assistant) {
        requestDocumentPicker(at.claim.check.id);
        return;
      }
      requestDocumentRead(at.claim.check.id, {
        folderIds: target.kind === "folder" ? [target.id] : [],
        tagIds: [],
        documentIds: target.kind === "document" ? [target.id] : [],
      });
    },
  },
  {
    // On a Document the assistant names ("the source is the lease"), it opens beside the Note for
    // the User to select the words; else as the card's action. The Citation is one step of Undo.
    id: "check.chooseCitation",
    label: "claim.chooseCitation",
    keywords: ["claim.chooseCitation.keywords"],
    group: "main",
    appliesTo: ["mind", "document"],
    reversible: true,
    when: (ctx) => sentenceTarget(ctx, ["document"]) !== null,
    run(ctx) {
      const at = withCuttable();
      const target = sentenceTarget(ctx, ["document"]);
      if (!at || !target) return;
      if (target.kind === "mind" || !ctx.assistant) {
        showClaimCard(at);
        requestCitationPicker(at.claim.check.id);
        return;
      }
      chooseCitationIn({
        mindId: at.mindId,
        checkId: at.claim.check.id,
        documentId: target.id,
        sentence: at.claim.sentence.text,
      });
    },
  },
  {
    id: "check.rewrite",
    label: "claim.rewrite",
    group: "main",
    // Applied as one step of the Note's Undo, which brings back the check it had.
    reversible: true,
    when: () => withRewrite() !== null,
    async run(ctx) {
      const at = withRewrite();
      if (!at) return;
      const end = await rewriteWithDocuments(at.editor, at.mindId, at.doc, at.claim);
      if (end !== "written" && ctx.assistant) {
        throw new TranslatableError({
          key: end === "same" ? "claim.rewrite.same" : "claim.rewrite.kept",
        });
      }
    },
  },
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
    id: "check.findSources",
    label: "claim.findSourcesFor",
    menuLabel: "claim.findSources.menu",
    group: "main",
    // It opens Find sources for the sentence's words; it changes no words.
    reversible: true,
    when: (ctx) =>
      ctx.here?.["check.findSources"] !== undefined || withClaim(findSourcesAt) !== null,
    run(ctx) {
      const here = ctx.here?.["check.findSources"];
      if (here) {
        here();
        return;
      }
      const at = withClaim(findSourcesAt);
      if (at) useFindSources.getState().show({ query: sentenceOf(at.editor, at.claim) });
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
    id: "check.correctContradiction",
    label: "claim.correction.command",
    group: "main",
    reversible: true,
    when: () => withCorrection() !== null,
    run() {
      const at = withCorrection();
      if (at)
        applyCorrection(at.editor, at.mindId, at.doc, at.claim, null, () => showClaimCard(at));
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
      if (at) applyFigure(at.editor, at.mindId, at.doc, at.claim, () => showClaimCard(at));
    },
  },
];
