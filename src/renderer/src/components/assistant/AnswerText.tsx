import "katex/dist/katex.min.css";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { RetainedFigureAnalysis } from "../../../../core/api";
import type { NodeJSON } from "../../../../shared/blockJson";
import { installFigureRuns, readFigureRunClosure } from "../../../../shared/figureRuns";
import { lendAnswerEditor } from "../../answerEditors";
import { AnswerTableSlots } from "../../editor/answerTables";
import { CalculatedFigureView } from "../../editor/CalculatedFigureView";
import { CitationView } from "../../editor/CitationView";
import { checklistLabel } from "../../editor/checklistLabel";
import { CitationGlue, withCitationGlue } from "../../editor/citationGlue";
import { CitationNumbers } from "../../editor/citationNumbers";
import { CopyCitations } from "../../editor/copyCitations";
import { RegenerateAnswerContext } from "../../editor/mindContext";
import { noteExtensions } from "../../editor/noteSchema";
import { useT } from "../../i18n";
import { useTableFades } from "../useTableFades";
import { OpenAsTable } from "./OpenAsTable";

/** A Citation redraws when it changes, and when its number does (as in a Mind). */
const citationView = ReactNodeViewRenderer(CitationView, {
  as: "span",
  update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
    if (newNode.type !== oldNode.type) return false;
    if (newNode !== oldNode || oldDecorations !== newDecorations) updateProps();
    return true;
  },
});

const docOf = (blocks: readonly NodeJSON[]) => ({
  type: "doc",
  content: withCitationGlue(blocks),
});

const editorPropsFor = (label: string) => ({
  attributes: {
    "data-testid": "assistant-answer-text",
    "aria-label": label,
    class: "mind-editor assistant-answer-text",
  },
});

/**
 * An Answer's text in the assistant (#201): its Blocks drawn by the note's own
 * schema and node views, read only, with its Citations numbered from 1, each
 * badge holding its check in the line. Text can be selected in it, to copy or
 * add just that part (`selectedNotes`). While the Answer is written its Blocks
 * are drawn again as they change, and only then. A table wider than the Answer
 * has "Open as a table" as an icon on its corner, greyed out until the Answer is written.
 */
export function AnswerText({
  answerId,
  blocks,
  figureRuns = [],
  label,
  streaming,
  regenerate,
  onOpenTable,
}: {
  answerId: string;
  blocks: readonly NodeJSON[];
  figureRuns?: readonly RetainedFigureAnalysis[];
  label: string;
  streaming: boolean;
  /** Writes the Answer again. */
  regenerate(): void;
  onOpenTable(table: NodeJSON): void;
}) {
  const t = useT();
  const shown = useRef(JSON.stringify(blocks));
  const receipts = useRef(figureRuns);
  receipts.current = figureRuns;
  // The Analyses its figures came from, where their cards read them as a Note's cards read its own.
  const [runs] = useState(() => new Y.Doc());
  useEffect(() => {
    try {
      installFigureRuns(runs, figureRuns);
    } catch (error) {
      console.error(error);
    }
  }, [runs, figureRuns]);
  useEffect(() => () => runs.destroy(), [runs]);
  const editor = useEditor(
    {
      editable: false,
      shouldRerenderOnTransaction: false,
      content: docOf(blocks),
      editorProps: editorPropsFor(label),
      extensions: [
        // A calculated figure shows its marker and card here as in a Note (#2307).
        ...noteExtensions({
          citationView,
          checklistLabel,
          calculatedFigureView: ReactNodeViewRenderer(
            (props) => <CalculatedFigureView {...props} doc={runs} />,
            { as: "span" },
          ),
        }),
        CitationGlue,
        CitationNumbers,
        CopyCitations.configure({
          figureRuns: (selected) => readFigureRunClosure(selected, receipts.current),
        }),
        AnswerTableSlots,
      ],
    },
    [],
  );

  const frame = useRef<HTMLDivElement>(null);
  useTableFades(frame, t("answer.table.label"));

  useEffect(() => lendAnswerEditor(answerId, editor), [answerId, editor]);

  useEffect(() => {
    const next = JSON.stringify(blocks);
    if (next === shown.current || editor.isDestroyed) return;
    shown.current = next;
    editor.commands.setContent(docOf(blocks), { emitUpdate: false });
  }, [editor, blocks]);

  // When the language changes: relabelled.
  useEffect(() => {
    if (!editor.isDestroyed) editor.setOptions({ editorProps: editorPropsFor(label) });
  }, [editor, label]);

  return (
    // A quote not found offers to write the Answer again, from its Citation's card.
    <RegenerateAnswerContext.Provider value={regenerate}>
      <div ref={frame} className="assistant-answer-frame">
        <EditorContent editor={editor} />
        <OpenAsTable frame={frame} editor={editor} streaming={streaming} onOpen={onOpenTable} />
      </div>
    </RegenerateAnswerContext.Provider>
  );
}
