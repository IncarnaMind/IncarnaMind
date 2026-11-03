import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import {
  checkSentences,
  setCheckCardOpen,
  setClaimFocus,
  setOpenClaim,
  useChecks,
} from "../checks";
import { opinionsIn } from "./opinionLocations";
import { keepMenuClosed } from "./selectionDismissal";

export const opinionChecks = (editor: Editor, doc: Y.Doc) => opinionsIn(editor.state.doc, doc);

export type OpinionCheck = ReturnType<typeof opinionChecks>[number];

const sameOpinions = (a: readonly OpinionCheck[], b: readonly OpinionCheck[]) =>
  a.length === b.length &&
  a.every((each, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      each.id === other.id &&
      each.text === other.text &&
      each.span.start === other.span.start &&
      each.span.end === other.span.end &&
      each.range.from === other.range.from &&
      each.range.to === other.range.to
    );
  });

export function useOpinionChecks(editor: Editor, doc: Y.Doc): readonly OpinionCheck[] {
  const [opinions, setOpinions] = useState(() => opinionChecks(editor, doc));
  useEffect(() => {
    // Each keystroke runs this twice, from the editor and from Yjs: an unchanged list keeps its
    // array, so the cards and the badge that read it don't render again.
    const update = () => {
      if (editor.isDestroyed) return;
      const next = opinionChecks(editor, doc);
      setOpinions((previous) => (sameOpinions(previous, next) ? previous : next));
    };
    update();
    editor.on("transaction", update);
    doc.on("afterTransaction", update);
    return () => {
      editor.off("transaction", update);
      doc.off("afterTransaction", update);
    };
  }, [editor, doc]);
  return opinions;
}

export function opinionAt(editor: Editor, doc: Y.Doc): OpinionCheck | undefined {
  const { from, to } = editor.state.selection;
  return opinionChecks(editor, doc).find(
    (opinion) => opinion.range.from <= from && to <= opinion.range.to && from < opinion.range.to,
  );
}

export function showNextOpinion(editor: Editor, doc: Y.Doc, place: string): void {
  if (editor.isDestroyed) return;
  const opinions = opinionChecks(editor, doc);
  const { from, to } = editor.state.selection;
  const current = opinions.findIndex(
    (opinion) => opinion.range.from === from && opinion.range.to === to,
  );
  const next =
    current < 0
      ? (opinions.find((opinion) => opinion.range.from >= to) ?? opinions[0])
      : opinions[(current + 1) % opinions.length];
  if (!next) return;
  keepMenuClosed(editor, next.range.from, next.range.to);
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, next.range.from, next.range.to))
      .scrollIntoView(),
  );
  editor.view.focus();
  setCheckCardOpen(place, false);
  setClaimFocus(place, null);
  setOpenClaim(place, next.id);
}

export function checkOpinion(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  opinion: OpinionCheck,
  place: string,
): void {
  if (editor.isDestroyed || useChecks.getState().running[mindId]) return;
  const current = opinionChecks(editor, doc).find(
    (each) =>
      each.id === opinion.id &&
      each.span.start === opinion.span.start &&
      each.span.end === opinion.span.end &&
      each.text.slice(each.span.start, each.span.end) ===
        opinion.text.slice(opinion.span.start, opinion.span.end),
  );
  if (!current) return;
  keepMenuClosed(editor, current.range.from, current.range.to);
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, current.range.from, current.range.to),
    ),
  );
  setCheckCardOpen(place, false);
  setOpenClaim(place, current.id);
  setClaimFocus(place, current.id);
  void checkSentences(editor, mindId, doc, "check-against-documents", {
    ranges: [current.range],
    part: { id: current.id, span: current.span },
  });
}
