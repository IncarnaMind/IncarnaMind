import type { NodeViewRenderer } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { type Editor, useEditorState } from "@tiptap/react";
import { useRef } from "react";
import type { CitationAttributes } from "../../../core/api";
import { citationSource, citationState, withShownName } from "../../../shared/citations";
import { noteOfCitation, useMindFormatting } from "../citationFormatting";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { numberedCitations, numberedFootnotes } from "./citationNumbers";
import { FootnoteText } from "./FootnoteText";
import { focusNow, returnToFootnote } from "./footnoteSchema";
import { CheckMarkIcon } from "./icons";
import { useMindId } from "./mindContext";
import { noteMarker } from "./noteLabels";
import { StyledRuns } from "./StyledRuns";

/** One footnote of the area, in the Mind's one numbering, or an endnote, in theirs (#746). */
type Row =
  | { kind: "footnote"; number: number; id: string; endnote: boolean }
  /** A Word file's note kept as is: its text, read-only. */
  | { kind: "kept"; number: number; id: string; endnote: boolean; text: string }
  | { kind: "citation"; number: number; key: string; attributes: CitationAttributes };

interface Rows {
  footnotes: Row[];
  endnotes: Row[];
}

/** The Mind's footnotes and endnotes in order, or none while the User has written no footnote of their own. */
function rowsOf(editor: Editor): Rows {
  const notes = numberedFootnotes(editor.state);
  if (notes.length === 0) return { footnotes: [], endnotes: [] };
  const rowOf = ({ number, id, endnote, kept, node }: (typeof notes)[number]): Row =>
    kept
      ? { kind: "kept", number, id, endnote, text: String(node.attrs.text ?? "") }
      : { kind: "footnote", number, id, endnote };
  const footnotes: Row[] = [
    ...notes.filter((note) => !note.endnote).map(rowOf),
    // Only the Citations the Mind's citation style makes footnotes of (#289).
    ...numberedCitations(editor.state)
      .filter((citation) => citation.footnote)
      .map(({ number, key, attributes }): Row => ({ kind: "citation", number, key, attributes })),
  ];
  return {
    footnotes: footnotes.sort((a, b) => a.number - b.number),
    endnotes: notes.filter((note) => note.endnote).map(rowOf),
  };
}

const sameRow = (row: Row, other: Row | undefined) => {
  if (!other || row.kind !== other.kind || row.number !== other.number) return false;
  if (row.kind === "citation") {
    return (
      other.kind === "citation" && row.key === other.key && row.attributes === other.attributes
    );
  }
  return (
    other.kind !== "citation" &&
    row.id === other.id &&
    row.endnote === other.endnote &&
    (row.kind !== "kept" || (other.kind === "kept" && row.text === other.text))
  );
};

const sameRows = (a: Rows, b: Rows | null) =>
  b !== null &&
  a.footnotes.length === b.footnotes.length &&
  a.endnotes.length === b.endnotes.length &&
  a.footnotes.every((row, index) => sameRow(row, b.footnotes[index])) &&
  a.endnotes.every((row, index) => sameRow(row, b.endnotes[index]));

/**
 * The footnote area at the end of the Mind, once the User has written a
 * footnote, under a short rule as Word's separator: every footnote in the
 * Mind's one numbering, as the export will have them, then a Word file's
 * endnotes, in theirs, under their heading (#746); the footnotes are headed
 * only when endnotes follow them. The User's own
 * are edited in place (`FootnoteText`), a Word file's too; a Citation's is
 * its reference and its check, quieter, and a note kept as is its text,
 * read-only. A footnote's number takes the cursor to its marker in the text.
 */
export function FootnoteArea({
  editor,
  citationView,
}: {
  editor: Editor;
  citationView: NodeViewRenderer | null;
}) {
  const t = useT();
  const rows = useEditorState({
    editor,
    selector: ({ editor: current }) => rowsOf(current),
    equalityFn: sameRows,
  });
  const numbers = useRef<Map<string, HTMLButtonElement>>(new Map());
  if (rows.footnotes.length === 0 && rows.endnotes.length === 0) return null;

  const list = (shown: readonly Row[]) => (
    <ol className="footnote-area-list">
      {shown.map((row) => {
        if (row.kind === "citation") return <CitationRow key={row.key} editor={editor} row={row} />;
        const label = noteMarker(editor, row.number, row.endnote);
        const goTo = t(row.endnote ? "editor.endnotes.goTo" : "editor.footnotes.goTo", {
          number: label,
        });
        return (
          <li
            key={row.id}
            className="footnote-area-row"
            data-testid={row.endnote ? "endnote-row" : "footnote-row"}
            data-number={row.number}
            data-footnote-id={row.id}
          >
            <button
              ref={(element) => {
                if (element) numbers.current.set(row.id, element);
                else numbers.current.delete(row.id);
              }}
              type="button"
              className="footnote-area-number"
              data-testid="footnote-row-number"
              aria-label={goTo}
              title={goTo}
              onClick={() => {
                if (row.kind === "footnote") {
                  returnToFootnote(editor, row.id);
                  return;
                }
                const found = numberedFootnotes(editor.state).find((each) => each.id === row.id);
                if (!found) return;
                const after = TextSelection.create(editor.state.doc, found.pos + 1);
                editor.view.dispatch(editor.state.tr.setSelection(after).scrollIntoView());
                focusNow(editor);
              }}
            >
              {label}
            </button>
            {row.kind === "kept" ? (
              <span className="footnote-area-source" title={t("wordAtom.keptAsIs.note")}>
                {row.text}
              </span>
            ) : (
              <FootnoteText
                mind={editor}
                id={row.id}
                label={t(row.endnote ? "editor.endnote.text" : "editor.footnote.text", {
                  number: label,
                })}
                placeholder={t(
                  row.endnote ? "editor.endnote.placeholder" : "editor.footnote.placeholder",
                )}
                variant="area"
                citationView={citationView}
                // Back on its number, from where Tab goes on and Enter goes to its marker.
                onLeave={() => numbers.current.get(row.id)?.focus()}
              />
            )}
          </li>
        );
      })}
    </ol>
  );

  return (
    <section
      className="footnote-area"
      data-testid="footnote-area"
      aria-label={t(rows.footnotes.length > 0 ? "editor.footnotes.title" : "editor.endnotes.title")}
    >
      {rows.footnotes.length > 0 && (
        <>
          {rows.endnotes.length > 0 && (
            <h2 className="footnote-area-title">{t("editor.footnotes.title")}</h2>
          )}
          {list(rows.footnotes)}
        </>
      )}
      {rows.endnotes.length > 0 && (
        <>
          <h2 className="footnote-area-title">{t("editor.endnotes.title")}</h2>
          {list(rows.endnotes)}
        </>
      )}
    </section>
  );
}

/** A Citation's footnote in the area: its number, which goes to its marker, and its reference. */
function CitationRow({ editor, row }: { editor: Editor; row: Extract<Row, { kind: "citation" }> }) {
  const t = useT();
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  const { attributes } = row;
  const state = citationState(attributes, documents, kept);
  const source = citationSource(withShownName(attributes, documents), t).text;
  // In a note style, the note as the style writes it (#289), once it is formatted.
  const formatting = useMindFormatting(useMindId());
  const note = noteOfCitation(editor.state, formatting, row.key);
  return (
    <li
      className="footnote-area-row footnote-area-row--citation"
      data-testid="footnote-row-citation"
      data-number={row.number}
      data-check={state.check}
    >
      <button
        type="button"
        className="footnote-area-number"
        aria-label={t("editor.footnotes.goToCitation", { number: row.number })}
        title={t("editor.footnotes.goToCitation", { number: row.number })}
        onClick={() => {
          // Where it is now: the row may be drawn from before the last keystroke.
          const citation = numberedCitations(editor.state).find((each) => each.key === row.key);
          if (!citation) return;
          const after = TextSelection.create(editor.state.doc, citation.pos + 1);
          editor.view.dispatch(editor.state.tr.setSelection(after).scrollIntoView());
          focusNow(editor);
        }}
      >
        {row.number}
      </button>
      <span className="footnote-area-source">
        <CheckMarkIcon check={state.check} className="footnote-area-check" />
        {note ? <StyledRuns runs={note} /> : source}
      </span>
    </li>
  );
}
