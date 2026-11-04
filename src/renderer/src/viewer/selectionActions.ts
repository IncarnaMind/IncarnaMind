/**
 * What the viewer's selection menu does with what the User picked (#101,
 * #118), each time with a Citation checked where they picked it
 * (`citeSelection`): Ask about this puts it in the composer as a chip, Add to
 * note puts it in a Mind as a quote or a table, and Copy with citation puts it
 * on the clipboard as copying from a Mind would.
 */
import { getSchema } from "@tiptap/core";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  type AskedQuote,
  type AskedTable,
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheckReason,
  type CitedSelection,
  type Document,
  MOST_ASKED_QUOTES,
  type SelectedPart,
} from "../../../core/api";
import type { NodeJSON } from "../../../shared/blockJson";
import type { MessageKey } from "../../../shared/i18n";
import { mindName } from "../../../shared/naming";
import { readableQuoteText } from "../../../shared/readableQuote";
import { sourceText } from "../../../shared/sources";
import { setTextOrigin } from "../../../shared/textOrigins";
import { type AddTarget, addInEditor } from "../addToNote";
import { citationAttributesOf } from "../citedSelection";
import { focusComposer } from "../commands/assistant";
import { readMindHandle } from "../commands/handles";
import { holdsQuote, NO_MIND, useComposer } from "../composer";
import { core } from "../core";
import { flashBlocks } from "../editor/blockOrigins";
import { sourceContext } from "../editor/copyCitations";
import { addFootnotes, citationsIn, copiedText, wordFootnoteHtml } from "../editor/copyNotes";
import { offerEditorUndo } from "../editor/editorUndo";
import { noteExtensions } from "../editor/noteSchema";
import { whenMindEditor } from "../editor/openEditors";
import { translateNow } from "../i18n";
import { useNotices } from "../notices";
import { exampleMindIds, useAppStore } from "../store";
import { rangeTsv, type SheetRange } from "./sheetSelection";

/** Words selected in a Document's viewer, part by part (see `ReadSelection`). */
export interface ViewerSelection {
  document: Document;
  parts: SelectedPart[];
  shown?: string;
}

const MIND_OPEN_WAIT_MS = 5000;

const REFUSED: Partial<Record<CitationCheckReason, MessageKey>> = {
  "too-many-pages": "viewer.selection.refused.pages",
  "in-several-places": "viewer.selection.refused.places",
  "no-text": "viewer.selection.refused.noText",
};

export async function citedSelection(
  { document, parts }: ViewerSelection,
  mindId?: string,
): Promise<CitedSelection> {
  const cited = await core.citeSelection({
    documentId: document.id,
    parts,
    ...(mindId !== undefined && { mindId }),
  });
  // Words a scan's reading may have misread are still where the User selected them: their Citation
  // asks for a look at the page, and goes in the note as it is (#535). Any other refused Citation
  // is not: its next check could find the same words somewhere else and move it there.
  const unsure = cited.check === "cant-check" && cited.checkReason === "unsure-word";
  if (cited.check !== "found" && !unsure) {
    const reason = cited.checkReason && REFUSED[cited.checkReason];
    throw new Error(translateNow(reason ?? "viewer.selection.refused"));
  }
  return cited;
}

async function quoteOf(selection: ViewerSelection): Promise<NodeJSON> {
  const { document, shown } = selection;
  const cited = await citedSelection(selection);
  return {
    type: "blockquote",
    content: [
      {
        type: "paragraph",
        content: [
          // A Markdown file's quote keeps its markup ("**"); the note has the words as shown.
          { type: "text", text: shown ? readableQuoteText(shown) : cited.quote },
          { type: CITATION_NODE, attrs: { ...citationAttributesOf(cited, document) } },
        ],
      },
    ],
  };
}

const nameOf = (mindId: string) => {
  const mind = useAppStore.getState().minds.find((each) => each.id === mindId);
  return mind ? mindName(mind) : "";
};

function putIn(
  editor: Parameters<typeof addInEditor>[0],
  mindId: string,
  blocks: readonly NodeJSON[],
  atCursor: boolean,
  from: Document,
  made = false,
  kind: "quote" | "table" = "quote",
) {
  const ids = addInEditor(editor, blocks, atCursor, () => undefined);
  if (!ids) return;
  // A web page's words are someone else's: a Run that reads them asks before it writes (#78).
  const doc = ySyncPluginKey.getState(editor.state)?.doc;
  if (from.kind === "web" && doc) setTextOrigin(doc, ids, "web-page");
  flashBlocks(editor, ids);
  const name = nameOf(mindId);
  offerEditorUndo(editor, (t) =>
    kind === "table"
      ? made
        ? t("viewer.selection.addedTableNew")
        : t("viewer.selection.addedTable", { mind: name || t("mind.untitled") })
      : made
        ? t("viewer.selection.addedNew")
        : t("viewer.selection.added", { mind: name || t("mind.untitled") }),
  );
}

/** Whether Add to note has a Mind to add to without asking which: one of the User's own, never the example (#1940). */
export const addsWithoutAsking = (): boolean => {
  const read = readMindHandle.current;
  return read !== null && !exampleMindIds(useAppStore.getState()).includes(read.mindId);
};

/**
 * Adds Blocks with their Citations to `target`: by default the Mind the assistant reads, at its
 * cursor (or end), as one step of its Undo; a Mind chosen from the list at its end; a new Mind in
 * the Document's Folder. Those two are shown beside the Document.
 */
async function addBlocksToNote(
  blocks: readonly NodeJSON[],
  document: Document,
  target: AddTarget | undefined,
  copy: () => void,
  kind: "quote" | "table",
): Promise<void> {
  try {
    const read = readMindHandle.current;
    if (!target && !read) return;
    if (!target || (target.kind === "mind" && read?.mindId === target.mindId)) {
      if (read && !read.editor.isDestroyed) {
        putIn(
          read.editor,
          read.mindId,
          blocks,
          read.cursorInMind() || read.cursorPlaced(),
          document,
          false,
          kind,
        );
      }
      return;
    }
    const made = target.kind === "new";
    const mindId = made
      ? (await core.createMind({ title: "", folderId: document.folderId })).id
      : target.mindId;
    // Beside the Document, which stays in view.
    await useAppStore.getState().changeLayout({
      type: "open",
      item: { kind: "mind", mindId },
      where: { in: "side" },
    });
    const editor = await whenMindEditor(mindId, MIND_OPEN_WAIT_MS);
    if (editor) {
      putIn(editor, mindId, blocks, false, document, made, kind);
      return;
    }
    // A Mind a newer version wrote opens read-only, with no editor to take the quote.
    const name = nameOf(mindId);
    if (made) await core.deleteMind(mindId);
    useNotices.getState().showError(
      new Error(
        made
          ? translateNow("viewer.selection.notOpenedNew")
          : translateNow("viewer.selection.notOpened", {
              mind: name || translateNow("mind.untitled"),
            }),
      ),
      { label: (t) => t("viewer.selection.copy"), run: copy },
    );
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/**
 * Adds the selection to `target` as a quote with its Citation: by default the
 * Mind the assistant reads, at its cursor (or end), as one step of its Undo;
 * a Mind chosen from the list at its end; a new Mind in the Document's Folder.
 * Those two are shown beside the Document.
 */
export async function addSelectionToNote(
  selection: ViewerSelection,
  target?: AddTarget,
): Promise<void> {
  try {
    const quote = await quoteOf(selection);
    await addBlocksToNote(
      [quote],
      selection.document,
      target,
      () => void copySelectionWithCitation(selection),
      "quote",
    );
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/**
 * Puts a pick in the composer as a chip, after any already there, and the cursor in the composer,
 * unfolding the assistant: the Question asked next is about it.
 */
export function putQuoteInComposer(asked: AskedQuote): AskedQuote {
  const composer = useComposer.getState();
  const key = composer.seat?.mindId ?? NO_MIND;
  const quotes = composer.draft(key).quotes ?? [];
  if (!holdsQuote(quotes, asked)) {
    if (quotes.length >= MOST_ASKED_QUOTES) {
      throw new Error(translateNow("composer.quote.tooMany", { count: MOST_ASKED_QUOTES }));
    }
    composer.update(key, { quotes: [...quotes, asked] });
  }
  focusComposer();
  return asked;
}

/**
 * Puts the selection in the composer as a quote chip, after any already there, and the cursor
 * in the composer, unfolding the assistant: the Question asked next is about it. Resolves with
 * the quote in the composer, or null when it couldn't go there.
 */
export async function askAboutSelection(selection: ViewerSelection): Promise<AskedQuote | null> {
  try {
    const { quote, pageFrom, pageTo, location } = await citedSelection(selection);
    const { document } = selection;
    return putQuoteInComposer({
      documentId: document.id,
      documentName: document.name,
      quote,
      pageFrom,
      pageTo,
      location,
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
    return null;
  }
}

let schema: ReturnType<typeof getSchema> | null = null;

/**
 * Copies the selection as copying its quote from a Mind does (#102): HTML
 * with the Citation as a footnote, which pastes back into a Mind as a
 * Citation, and text with "[1]" and its Source.
 */
export async function copySelectionWithCitation(selection: ViewerSelection): Promise<void> {
  try {
    schema ??= getSchema(noteExtensions());
    const fragment = Fragment.from(schema.nodeFromJSON(await quoteOf(selection)));
    const context = sourceContext();
    const holder = document.createElement("div");
    holder.append(DOMSerializer.fromSchema(schema).serializeFragment(fragment));
    addFootnotes(holder, citationsIn(fragment), context);
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([wordFootnoteHtml(holder.innerHTML)], { type: "text/html" }),
        "text/plain": new Blob([copiedText(fragment, schema, context)], { type: "text/plain" }),
      }),
    ]);
    useNotices.getState().confirm("viewer.selection.copied");
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/** A range of cells selected in a sheet (#118), with its cells and its rows as the Document has them. */
export interface RangeSelection {
  document: Document;
  range: SheetRange;
  table: AskedTable;
  parts: SelectedPart[];
}

/** The range's Citation, checked against its rows: found where the User selected them. */
export async function citeRange(
  selection: RangeSelection,
  mindId?: string,
): Promise<CitedSelection> {
  if (selection.parts.length === 0) {
    throw new Error(translateNow("viewer.selection.emptyRange"));
  }
  const cited = await core.citeSelection({
    documentId: selection.document.id,
    parts: selection.parts,
    ...(mindId !== undefined && { mindId }),
  });
  // The Citation rule's two Units are two blocks of a sheet's rows: the words for it are the cells', not pages'.
  if (cited.checkReason === "too-many-pages") {
    throw new Error(translateNow("viewer.selection.refused.blocks"));
  }
  if (cited.check !== "found") throw new Error(translateNow("viewer.selection.refused"));
  return cited;
}

/** Puts the range in the composer as a table chip, with its Citation: the Question asked next is about it. */
export async function askAboutRange(selection: RangeSelection): Promise<AskedQuote | null> {
  try {
    const cited = await citeRange(selection);
    return putQuoteInComposer({
      documentId: selection.document.id,
      documentName: selection.document.name,
      quote: cited.quote,
      pageFrom: cited.pageFrom,
      pageTo: cited.pageTo,
      location: cited.location,
      pick: "rows",
      table: selection.table,
      check: cited.check,
      checkReason: cited.checkReason,
    });
  } catch (error) {
    useAppStore.getState().reportError(error);
    return null;
  }
}

const tableCell = (text: string, header: boolean): NodeJSON => ({
  type: header ? "tableHeader" : "tableCell",
  attrs: { colspan: 1, rowspan: 1 },
  content: [
    {
      type: "paragraph",
      content: text === "" ? [] : [{ type: "text", text }],
    },
  ],
});

/** The range as a table with its Citation under it: the header row first, the sheet's own or the range's first. */
function rangeBlocks(table: AskedTable, citation: CitationAttributes): NodeJSON[] {
  const header = table.header ?? table.rows[0] ?? [];
  const body = table.header ? table.rows : table.rows.slice(1);
  const rows: NodeJSON[] = [
    { type: "tableRow", content: header.map((text) => tableCell(text, true)) },
    ...body.map((cells) => ({
      type: "tableRow",
      content: cells.map((text) => tableCell(text, false)),
    })),
  ];
  return [
    { type: "table", content: rows },
    { type: "paragraph", content: [{ type: CITATION_NODE, attrs: { ...citation } }] },
  ];
}

/** Adds the range to a note as a table whose Citation is checked against its rows. */
export async function addRangeToNote(selection: RangeSelection, target?: AddTarget): Promise<void> {
  try {
    const cited = await citeRange(selection);
    await addBlocksToNote(
      rangeBlocks(selection.table, citationAttributesOf(cited, selection.document)),
      selection.document,
      target,
      () => void copyRange(selection),
      "table",
    );
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/** The range's cells as TSV, with its citation under them, as copying cells from a spreadsheet gives them. */
export async function copyRange(selection: RangeSelection): Promise<void> {
  try {
    const cited = await citeRange(selection);
    const citation = citationAttributesOf(cited, selection.document);
    const context = sourceContext();
    const source = sourceText(citation, context).text;
    const tsv = rangeTsv(selection.table);
    // The table and its Citation through the schema, as Copy with citation does for words: pasted
    // into a Note it comes back a Citation, and every cell is escaped by the serializer.
    if (schema === null) schema = getSchema(noteExtensions());
    const noteSchema = schema;
    const fragment = Fragment.fromArray(
      rangeBlocks(selection.table, citation).map((node) => noteSchema.nodeFromJSON(node)),
    );
    const holder = document.createElement("div");
    holder.append(DOMSerializer.fromSchema(noteSchema).serializeFragment(fragment));
    addFootnotes(holder, citationsIn(fragment), context);
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([`${tsv}\n\n${translateNow("citedSource.title")}\n[1] ${source}`], {
          type: "text/plain",
        }),
        "text/html": new Blob([wordFootnoteHtml(holder.innerHTML)], { type: "text/html" }),
      }),
    ]);
    useNotices.getState().confirm("viewer.selection.copiedTsv");
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
