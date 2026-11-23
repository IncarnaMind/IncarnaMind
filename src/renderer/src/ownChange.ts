/**
 * The change the User's own AI gave with a sentence's check (#3715): whether it can be made now, and
 * making it. One test decides, and the card, ⌘K and Accept all ask it, so Accept is offered only
 * where it works.
 */
import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { CLAIM_CHECK_MARK, GENERATED_MARK } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import { checkAgain, checkRestorer, useChecks } from "./checks";
import { core } from "./core";
import { blockIdAt } from "./correctionFixes";
import {
  type ChangeRefused,
  type PlacedChange,
  placeChange,
  refused,
} from "./editor/changePlacement";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { useEdits } from "./editWithAi";
import { checksHandedFile } from "./handedFiles";
import { translateNow } from "./i18n";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";

/**
 * Whether the change of `claim`'s check can be made now, and where: the one test the card, ⌘K and
 * Accept all ask. Not in a Note the User can't edit, nor in one that checks a file an outside agent
 * handed over, whose words are the file's; not while an edit or a check runs in the Note.
 */
export function changeToMake(editor: Editor, mindId: string, claim: ShownClaim): PlacedChange {
  if (!editor.isEditable || checksHandedFile(mindId)) return refused("none");
  if (useEdits.getState().pending[mindId]) return refused("editing");
  if (useChecks.getState().running[mindId]) return refused("checking");
  return placeChange(editor.state, claim);
}

/** The sentence at the selection whose check gave a change that can be made now, for ⌘K. */
export function changeAt(editor: Editor, mindId: string): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) =>
        claim.sentence.from <= from &&
        to <= claim.sentence.to &&
        changeToMake(editor, mindId, claim).ok,
    ) ?? null
  );
}

/** What a press says when the change can't be made after all: the Note changed since it showed. */
const REFUSED_LINE: Record<Exclude<ChangeRefused, "none">, MessageKey> = {
  changed: "error.check.partChanged",
  inside: "claim.change.inside",
  review: "claim.change.underReview",
  editing: "edit.problem.busy",
  checking: "error.check.partChecking",
};

/** Each Note's last check again after an accepted change: a check still running turns the next away. */
const rechecks = new Map<string, Promise<void>>();

/**
 * Writes the change the User's own AI gave over its words, as AI text by that agent, with one Undo
 * (#3715). With a model set up in IncarnaMind the sentence is checked again like any edit; with
 * only the User's own AI it reads Needs re-check until that AI checks it again. Nothing here
 * turns it into Supported.
 */
export function acceptChange(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  recheck: boolean,
): boolean {
  const placed = changeToMake(editor, mindId, claim);
  if (!placed.ok) {
    if (placed.why === "none") console.error("A change was accepted where the check gives none.");
    else useNotices.getState().showError(new Error(translateNow(REFUSED_LINE[placed.why])));
    return false;
  }
  const tr = editor.state.tr;
  const { marks } = tr.doc.type.schema;
  const checkType = marks[CLAIM_CHECK_MARK];
  const generated = marks[GENERATED_MARK];
  // The check's mark isn't inclusive: words written at its end, or in place of all its words, would
  // lose it.
  let checked: Mark | undefined;
  tr.doc.nodesBetween(claim.from, claim.to, (node) => {
    checked ??= node.marks.find((mark) => mark.type === checkType);
    return checked === undefined;
  });
  const restore = checkRestorer(editor, claim, claim.check);
  for (const edit of [...placed.edits].reverse()) {
    if (edit.text === "") {
      tr.delete(edit.from, edit.to);
      continue;
    }
    tr.insertText(edit.text, edit.from, edit.to);
    const end = edit.from + edit.text.length;
    if (checked) tr.addMark(edit.from, end, checked);
    if (generated) tr.addMark(edit.from, end, generated.create());
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  const again = () => {
    if (!recheck) return;
    const next = (rechecks.get(mindId) ?? Promise.resolve())
      .then(async () => {
        await flushMindUpdates(mindId);
        const now = shownClaims(editor.state).find((each) => each.check.id === claim.check.id);
        if (now) await checkAgain(editor, mindId, doc, now);
      })
      .catch((error: unknown) =>
        console.error("A sentence couldn't be checked again after its change.", error),
      );
    rechecks.set(mindId, next);
  };
  offerEditorUndo(editor, (t) => t("claim.changeAccepted"), undefined, restore, again);
  again();
  const first = placed.edits[0];
  const blockId = first ? blockIdAt(editor.state.doc, tr.mapping.map(first.from, -1)) : null;
  core
    .recordAiUse([
      {
        mindId,
        kind: "outside-agent-change-accepted",
        providerId: null,
        modelId: null,
        agent: claim.check.modelId,
        characters: placed.change.with.length,
        ...(blockId && { blockIds: [blockId] }),
      },
    ])
    .catch((error: unknown) => useNotices.getState().showError(error));
  return true;
}
