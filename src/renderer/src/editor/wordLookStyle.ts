import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import {
  mindLookOf,
  observeWordLook,
  setMindLook,
  wordFontsOf,
  wordLookOf,
} from "../../../shared/wordLook";
import { useAppStore } from "../store";
import { holdWordLook } from "../wordLooks";
import { openOriginalAtCaret, useWordFile } from "./WordOrigin";
import { wordLookCss, wordLookScope } from "./wordLookCss";

const lookIn = (doc: Y.Doc) => ({ look: wordLookOf(doc), shown: mindLookOf(doc) });

/** The Mind's Word look as its frame's class and stylesheet; null while it is drawn as a plain Mind. */
export function useWordLookStyle(doc: Y.Doc, mindId: string, editor: Editor | null) {
  const [state, setState] = useState(() => lookIn(doc));
  useEffect(() => {
    setState(lookIn(doc));
    return observeWordLook(doc, () => setState(lookIn(doc)));
  }, [doc]);
  const { file } = useWordFile(doc);
  const documentId = file?.documentId ?? null;
  const originalId = useAppStore((app) =>
    documentId && app.documents.some((each) => each.id === documentId) ? documentId : null,
  );

  useEffect(() => {
    if (!state.look) return;
    return holdWordLook(mindId, {
      shown: state.shown,
      choose: (look) => setMindLook(doc, look),
      openOriginal: originalId ? () => openOriginalAtCaret(originalId, editor, doc) : null,
      fonts: wordFontsOf(state.look),
    });
  }, [state, mindId, originalId, doc, editor]);

  return useMemo(
    () =>
      state.look && state.shown === "word"
        ? { className: wordLookScope(mindId), css: wordLookCss(mindId, state.look) }
        : null,
    [state, mindId],
  );
}
