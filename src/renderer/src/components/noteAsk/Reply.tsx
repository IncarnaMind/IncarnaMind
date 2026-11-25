import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import type { NoteCitation } from "../../../../core/api";
import { replyBlocks } from "../../../../shared/replyBlocks";
import { CitationView } from "../../editor/CitationView";
import { checklistLabel } from "../../editor/checklistLabel";
import { CitationGlue, withCitationGlue } from "../../editor/citationGlue";
import { CitationNumbers } from "../../editor/citationNumbers";
import { CopyCitations } from "../../editor/copyCitations";
import { noteExtensions } from "../../editor/noteSchema";

/** A Citation redraws when it changes, and when its number does, as in a Note. */
const citationView = ReactNodeViewRenderer(CitationView, {
  as: "span",
  update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
    if (newNode.type !== oldNode.type) return false;
    if (newNode !== oldNode || oldDecorations !== newDecorations) updateProps();
    return true;
  },
});

const docOf = (text: string, citations: readonly NoteCitation[]) => ({
  type: "doc",
  content: withCitationGlue(replyBlocks(text, citations)),
});

const PROPS = {
  attributes: {
    "data-testid": "note-ask-reply",
    class: "mind-editor assistant-answer-text note-ask-reply-text",
  },
};

/**
 * A reply of the User's own AI as it wrote it, drawn by a Note's own schema and node views, read
 * only: its paragraphs, lists and bold, and each Citation IncarnaMind gave its connection the
 * Note's own chip, whose card shows its quote and opens its Document there (#3677, #3765). Text
 * can be selected in it to copy.
 */
export function Reply({ text, citations }: { text: string; citations: readonly NoteCitation[] }) {
  const shown = useRef(JSON.stringify([text, citations]));
  const editor = useEditor(
    {
      editable: false,
      shouldRerenderOnTransaction: false,
      content: docOf(text, citations),
      editorProps: PROPS,
      extensions: [
        ...noteExtensions({ citationView, checklistLabel }),
        CitationGlue,
        CitationNumbers,
        CopyCitations,
      ],
    },
    [],
  );
  // A reply is written as it comes: drawn again as it changes, and only then.
  useEffect(() => {
    const next = JSON.stringify([text, citations]);
    if (next === shown.current || editor.isDestroyed) return;
    shown.current = next;
    editor.commands.setContent(docOf(text, citations), { emitUpdate: false });
  }, [editor, text, citations]);
  return <EditorContent editor={editor} />;
}
