import type { Editor } from "@tiptap/core";
import type { EditAction } from "../../../core/api";
import { translate } from "../../../shared/i18n";
import {
  actOnAppliedEdit,
  offersReview,
  restorableAt,
  restoreChange,
  reviewApplied,
  reviewedChangeAt,
} from "../appliedEdits";
import { useComposer } from "../composer";
import { holdsAiText } from "../editor/aiText";
import {
  type AppliedAction,
  type AppliedLine,
  appliedLineIn,
  appliedOriginalAt,
  toggleAppliedOriginal,
} from "../editor/appliedEditLine";
import { selectionForEdit } from "../editor/editSelection";
import { noteHolding } from "../editor/noteKeymap";
import { madeAgain, pendingAtSelection, pendingIn } from "../editor/proposalReview";
import { proposalOriginalAt, toggleProposalOriginal } from "../editor/proposalRewrites";
import { requestEditField } from "../editor/selectionCommands";
import {
  regenerateChange,
  requestEdit,
  resolveProposalsIn,
  startEditing,
  useEdits,
} from "../editWithAi";
import { markSelectionAsMine } from "../markAsMine";
import { useAppStore } from "../store";
import { noteHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/*
 * Proposals (#93), Edit with AI and Mark as mine (#95), from the keyboard
 * and ⌘K. ⌘↵ and ⌘⌫ act in the note, on the change the cursor is in or the
 * changes a selection touches (a section, as in Word); anywhere else they do
 * what they always do.
 */

/** The note the cursor's Block is in, while the cursor or the selection is on a Proposal. */
function noteOnProposal(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : null;
  return editor && !editor.isDestroyed && pendingAtSelection(editor.state).length > 0
    ? editor
    : null;
}

/** The note the cursor's Block is in, while the cursor is in an applied edit's change shown again. */
function noteOnReviewedChange(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : null;
  return editor && !editor.isDestroyed && reviewedChangeAt(editor.state) !== null ? editor : null;
}

function restorableHere(ctx: CommandContext): boolean {
  const editor = noteOnReviewedChange(ctx);
  return editor !== null && restorableAt(editor.state);
}

function originalAt() {
  const editor = noteHandle.current?.editor;
  if (!editor || editor.isDestroyed) return null;
  const applied = appliedOriginalAt(editor.state);
  if (applied) return { editor, ...applied, toggle: toggleAppliedOriginal };
  const waiting = proposalOriginalAt(editor.state);
  return waiting && { editor, ...waiting, toggle: toggleProposalOriginal };
}

function resolveAt(ctx: CommandContext, outcome: "accept" | "reject"): void {
  const editor = noteOnProposal(ctx);
  const note = noteHandle.current;
  if (!editor || note?.editor !== editor) return;
  const ids = pendingAtSelection(editor.state).map((each) => each.id);
  resolveProposalsIn(editor, note.mindId, ids, outcome);
}

/** The change out of date the cursor is on, in the Mind last written in, while no request runs there. */
function outOfDateAt(ctx: CommandContext) {
  const editor = noteOnProposal(ctx);
  const note = noteHandle.current;
  if (!editor || note?.editor !== editor || useEdits.getState().pending[note.mindId]) return null;
  // Someone's change from a Word file, or an outside agent's, can't be made again.
  const made = madeAgain(editor.state);
  const proposal = pendingAtSelection(editor.state).find((each) => each.outOfDate && made(each));
  return proposal ? { note, proposal } : null;
}

/** The Mind last written in, while it has Proposals waiting. */
function withProposals() {
  const note = noteHandle.current;
  return note && !note.editor.isDestroyed && pendingIn(note.editor.state).length > 0 ? note : null;
}

function resolveAll(outcome: "accept" | "reject"): void {
  const note = withProposals();
  if (!note) return;
  resolveProposalsIn(note.editor, note.mindId, "all", outcome);
}

/** The Mind last written in, while it has text selected that Edit with AI can change. */
function withSelection() {
  const note = noteHandle.current;
  if (!note || note.editor.isDestroyed || useEdits.getState().pending[note.mindId]) return null;
  return selectionForEdit(note.editor.state) ? note : null;
}

/** The Mind last written in, while it has AI text selected. */
function withAiText() {
  const note = noteHandle.current;
  return note && !note.editor.isDestroyed && holdsAiText(note.editor.state) ? note : null;
}

/** An AI action of the selection menu, on the selected text. */
const editAction = (
  action: Extract<EditAction, "improve" | "shorten" | "explain">,
  label: "editor.ai.improve" | "editor.ai.shorten" | "editor.ai.explain",
): Command => ({
  id: `edit.${action}`,
  label,
  group: "main",
  // It applies at once; ⌘Z takes it back.
  reversible: true,
  when: () => withSelection() !== null,
  run() {
    const note = withSelection();
    if (note) void requestEdit(note.editor, note.mindId, note.doc, action);
  },
});

/** The Mind last written in, while the line over an edit it applied shows, of one of `kinds`. */
function withAppliedLine(kinds: readonly AppliedLine["kind"][], also = (_: AppliedLine) => true) {
  const note = noteHandle.current;
  const line = note && !note.editor.isDestroyed ? appliedLineIn(note.editor.state) : null;
  return note && line && kinds.includes(line.kind) && also(line) ? note : null;
}

/** The Mind last written in, while it offers Review changes for the last edit it applied. */
function withReview() {
  const note = noteHandle.current;
  return note && offersReview(note.editor) ? note : null;
}

/** What the line over an applied edit offers, from ⌘K while it shows. */
const appliedCommand = (
  id: `edit.${string}`,
  label: Command["label"],
  action: AppliedAction,
  kinds: readonly AppliedLine["kind"][],
  also?: (line: AppliedLine) => boolean,
): Command => ({
  id,
  label,
  group: "main",
  // ⌘Z takes each back, the line's Undo the whole edit.
  reversible: true,
  when: () => withAppliedLine(kinds, also) !== null,
  run() {
    const note = withAppliedLine(kinds, also);
    if (note) actOnAppliedEdit(note.editor, action);
  },
});

export const proposalCommands: readonly Command[] = [
  appliedCommand(
    "edit.undoApplied",
    "command.edit.undoApplied",
    "undo",
    ["applied", "review"],
    // Changed since, it can't take the edit back: its line says so on Undo all.
    (line) => line.kind !== "review" || !line.undo || line.undo.available(),
  ),
  {
    // After the line has gone too, while some of the edit's words are as it wrote them (#1795).
    id: "edit.reviewApplied",
    label: "edit.applied.review",
    group: "main",
    // It shows what was applied; nothing in the Mind changes.
    reversible: true,
    when: () => withReview() !== null,
    run() {
      const note = withReview();
      if (note) reviewApplied(note.editor, { focus: true });
    },
  },
  appliedCommand(
    "edit.removeKept",
    "command.edit.removeKept",
    "remove-kept",
    ["applied"],
    (line) => line.kind === "applied" && line.kept !== null,
  ),
  appliedCommand("edit.reviewDone", "command.edit.reviewDone", "done", ["review"]),
  appliedCommand("edit.applyHeld", "command.edit.applyHeld", "apply", ["held"]),
  appliedCommand("edit.discardHeld", "command.edit.discardHeld", "discard", ["held"]),
  {
    id: "proposal.accept",
    label: "command.proposal.accept",
    shortcut: { keys: "CmdOrCtrl+Enter" },
    group: "main",
    appliesTo: ["block"],
    // ⌘Z, or Undo on its line, takes it back.
    reversible: true,
    when: (ctx) => noteOnProposal(ctx) !== null,
    run: (ctx) => resolveAt(ctx, "accept"),
  },
  {
    id: "proposal.reject",
    label: (ctx, t) =>
      noteOnProposal(ctx) === null && noteOnReviewedChange(ctx) !== null
        ? t("edit.review.restore")
        : t("command.proposal.reject"),
    shortcut: { keys: "CmdOrCtrl+Backspace", inText: true },
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    // In the text, ⌘⌫ in a change the User changed since does nothing, rather than delete their line.
    when: (ctx) =>
      noteOnProposal(ctx) !== null ||
      (ctx.surface === "palette" ? restorableHere(ctx) : noteOnReviewedChange(ctx) !== null),
    run(ctx) {
      if (noteOnProposal(ctx)) {
        resolveAt(ctx, "reject");
        return;
      }
      const editor = noteOnReviewedChange(ctx);
      const index = editor ? reviewedChangeAt(editor.state) : null;
      if (editor && index !== null) restoreChange(editor, index);
    },
  },
  {
    // A paragraph or section written anew: its "Was: …" or "Show original" line, from ⌘K.
    id: "change.original",
    label: (_ctx, t) => t(originalAt()?.shown ? "change.hideOriginal" : "change.showOriginal"),
    group: "main",
    // It shows or hides the old text; nothing in the Mind changes.
    reversible: true,
    when: () => originalAt() !== null,
    run() {
      const found = originalAt();
      found?.toggle(found.editor, found.key);
    },
  },
  {
    // "Regenerate" under a change out of date, from the keyboard and ⌘K.
    id: "proposal.regenerate",
    label: "command.proposal.regenerate",
    group: "main",
    appliesTo: ["block"],
    // Its new changes wait as Proposals, and rejecting them leaves the text as it was.
    reversible: true,
    when: (ctx) => outOfDateAt(ctx) !== null,
    run(ctx) {
      const found = outOfDateAt(ctx);
      if (found) {
        const { editor, mindId, doc } = found.note;
        void regenerateChange(editor, mindId, doc, found.proposal);
      }
    },
  },
  {
    id: "proposal.acceptAll",
    label: "command.proposal.acceptAll",
    group: "main",
    reversible: true,
    when: () => withProposals() !== null,
    run: () => resolveAll("accept"),
  },
  {
    id: "proposal.rejectAll",
    label: "command.proposal.rejectAll",
    group: "main",
    reversible: true,
    when: () => withProposals() !== null,
    run: () => resolveAll("reject"),
  },
  {
    // ⌘J with text selected does it too (see "composer.focus").
    id: "edit.withAi",
    label: "editor.ai.edit",
    group: "main",
    // What the User then asks for applies at once; ⌘Z takes it back.
    reversible: true,
    when: () => withSelection() !== null,
    run() {
      const note = withSelection();
      if (!note || requestEditField(note.editor, true)) return;
      if (startEditing(note.editor, note.mindId)) useComposer.getState().requestFocus();
    },
  },
  editAction("improve", "editor.ai.improve"),
  editAction("shorten", "editor.ai.shorten"),
  {
    // From ⌘K the language is said in the composer: "Translate into …".
    id: "edit.translate",
    label: "editor.ai.translate",
    group: "main",
    reversible: true,
    when: () => withSelection() !== null,
    run() {
      const note = withSelection();
      if (!note || !startEditing(note.editor, note.mindId)) return;
      const language = useAppStore.getState().settings?.language ?? "en";
      useComposer
        .getState()
        .update(note.mindId, { text: translate(language, "composer.edit.translateInto") });
      useComposer.getState().requestFocus();
    },
  },
  editAction("explain", "editor.ai.explain"),
  {
    id: "edit.markAsMine",
    label: "editor.ai.markAsMine",
    assistant: { never: "authorship" },
    group: "main",
    // ⌘Z, or Undo on its line, takes it back.
    reversible: true,
    when: () => withAiText() !== null,
    run() {
      const note = withAiText();
      if (note) markSelectionAsMine(note.editor);
    },
  },
];
