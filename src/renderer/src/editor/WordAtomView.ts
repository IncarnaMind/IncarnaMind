import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import type { WordAtomAttributes, WordAtomKind } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { BREAK_WORD_ATOMS, INVISIBLE_WORD_ATOMS, readWordAtom } from "../../../shared/wordFiles";
import { languageNow, translateNow } from "../i18n";
import { pageDate } from "../webPages";
import { footnoteNumberOf } from "./citationNumbers";
import { noteMarker } from "./noteLabels";
import { drawBreak } from "./PageBreakView";

/** Atoms drawn as a box on a line of their own, as Word places them. */
const BOXED: ReadonlySet<WordAtomKind> = new Set(["textBox", "shape", "smartArt", "chart"]);

/** The name of a field, by its type: a date field, a page number, a cross-reference… */
function fieldName(field: string | undefined): MessageKey {
  const type = (field ?? "").toUpperCase();
  if (/^(DATE|TIME|CREATEDATE|SAVEDATE|PRINTDATE)$/.test(type)) return "wordAtom.kind.date";
  if (/^(PAGE|NUMPAGES|SECTIONPAGES)$/.test(type)) return "wordAtom.kind.page";
  if (/^(REF|NOTEREF|PAGEREF|STYLEREF)$/.test(type)) return "wordAtom.kind.crossReference";
  if (type === "TOC") return "wordAtom.kind.toc";
  if (/^ADDIN (ZOTERO_ITEM|EN\.CITE|CSL_CITATION)/.test(type)) return "wordAtom.kind.citation";
  return "wordAtom.kind.field";
}

/** What an atom is called: "Date field", "Text box", "Footnote". */
export function wordAtomName(atom: Pick<WordAtomAttributes, "kind" | "info">): string {
  if (atom.kind === "field") return translateNow(fieldName(atom.info?.field));
  if (atom.kind === "control" && atom.info?.field === "TOC") {
    return translateNow("wordAtom.kind.toc");
  }
  return translateNow(`wordAtom.kind.${atom.kind}`);
}

/** What hovering or reaching the atom by keyboard says it is, and that it is kept as is. */
function describe(atom: WordAtomAttributes): string {
  const name = wordAtomName(atom);
  if (atom.kind === "insertion" || atom.kind === "deletion" || atom.kind === "comment") {
    const date = atom.info?.date ? pageDate(atom.info.date, languageNow()) : "";
    const head = [name, atom.info?.author ?? "", date].filter(Boolean).join(" · ");
    const body = atom.kind === "comment" ? atom.text : atom.label;
    return [head, body, translateNow("wordAtom.readOnly")].filter(Boolean).join("\n");
  }
  const note = atom.kind === "footnote" || atom.kind === "endnote";
  const kept = translateNow("wordAtom.keptAsIs", { kind: note ? `${name} ${atom.label}` : name });
  return [kept, note ? atom.text : "", translateNow("wordAtom.keptAsIs.note")]
    .filter(Boolean)
    .join("\n");
}

const LOCK =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>';

const COMMENT =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"></path></svg>';

/** The label a box shows on hover and when reached by keyboard: a lock, and what it is. */
function boxLabel(atom: WordAtomAttributes): HTMLElement {
  const label = document.createElement("span");
  label.className = "word-atom-label";
  label.innerHTML = LOCK;
  label.append(translateNow("wordAtom.keptAsIs", { kind: wordAtomName(atom) }));
  return label;
}

/** The lines of a box's text, the first its label's if it has no text. */
function boxLines(atom: WordAtomAttributes): HTMLElement[] {
  const text = atom.text || atom.label || wordAtomName(atom);
  return text.split("\n").map((line) => {
    const row = document.createElement("span");
    row.className = "word-atom-line";
    row.textContent = line;
    return row;
  });
}

/** Draws an atom in the text, by its kind; a note's mark with the number it has now, if any. */
function drawAtom(dom: HTMLElement, atom: WordAtomAttributes): void {
  dom.replaceChildren();
  dom.className = "word-atom";
  dom.dataset.kind = atom.kind;
  dom.dataset.testid = "word-atom";
  dom.removeAttribute("title");
  dom.removeAttribute("aria-label");
  dom.removeAttribute("role");
  if (BREAK_WORD_ATOMS.has(atom.kind)) {
    drawBreak(dom, atom.kind === "sectionBreak" ? "sectionBreak" : "pageBreak");
    dom.dataset.kind = atom.kind;
    dom.dataset.testid = atom.kind === "sectionBreak" ? "section-break" : "page-break";
    return;
  }
  if (INVISIBLE_WORD_ATOMS.has(atom.kind)) {
    dom.classList.add("word-atom-hidden");
    dom.setAttribute("aria-hidden", "true");
    return;
  }
  dom.removeAttribute("aria-hidden");
  const description = describe(atom);
  dom.setAttribute("role", "group");
  dom.setAttribute("aria-label", description.replaceAll("\n", ". "));
  dom.title = description;
  if (BOXED.has(atom.kind) || atom.info?.display) {
    dom.classList.add("word-atom-box");
    dom.append(boxLabel(atom), ...boxLines(atom));
  } else if (atom.kind === "footnote" || atom.kind === "endnote") {
    dom.classList.add("word-atom-note");
    dom.textContent = atom.label;
  } else if (atom.kind === "comment") {
    dom.classList.add("word-atom-comment");
    dom.innerHTML = COMMENT;
  } else if (atom.kind === "insertion" || atom.kind === "deletion") {
    dom.classList.add(`word-atom-${atom.kind}`);
    dom.textContent = atom.label;
  } else {
    dom.classList.add("word-atom-chip");
    dom.textContent = atom.label || wordAtomName(atom);
  }
}

/**
 * What a Word import kept as it is, in the text (#104, the board
 * Final-30-Word-Import): a field or a control is a quiet chip with its text;
 * a text box, a shape, SmartArt or a chart a box on its own line, its label
 * ("Text box · kept as is") showing on hover or when reached by keyboard; a
 * note the Note's footnote can't hold its mark, raised, numbered with the
 * footnotes; a comment a small mark; someone else's insertion underlined and
 * deletion struck, read-only for now (#108); a section break a line across
 * the text (#746); bookmarks, ranges and column breaks nothing at all.
 * Hovering any of them says what it is.
 *
 * A plain view: there can be thousands (bookmarks), and none has content.
 */
export const wordAtomView: NodeViewRenderer = ({ node: initial, decorations, editor }) => {
  const atomOf = (node: ProseMirrorNode, shown: readonly Decoration[]) => {
    const read = readWordAtom(node.attrs);
    const number = footnoteNumberOf(shown);
    return number > 0 && (read.kind === "footnote" || read.kind === "endnote")
      ? { ...read, label: noteMarker(editor, number, read.kind === "endnote") }
      : read;
  };
  let atom = atomOf(initial, decorations as readonly Decoration[]);
  const display = BOXED.has(atom.kind) || atom.info?.display === true;
  const dom = document.createElement(
    atom.kind === "footnote" || atom.kind === "endnote" ? "sup" : "span",
  );
  dom.contentEditable = "false";
  drawAtom(dom, atom);
  return {
    dom,
    update(next: ProseMirrorNode, nextDecorations: readonly Decoration[]) {
      if (next.type !== initial.type) return false;
      const nextAtom = atomOf(next, nextDecorations);
      if ((BOXED.has(nextAtom.kind) || nextAtom.info?.display === true) !== display) return false;
      atom = nextAtom;
      drawAtom(dom, atom);
      return true;
    },
    ignoreMutation: () => true,
  };
};

/**
 * What a Word import kept as it is, as a Block (#104): a box with its text, a
 * line a paragraph, its label ("Header · kept as is") on hover or when
 * selected. The header comes first in the Mind, the footer last.
 */
export const wordBlockView: NodeViewRenderer = ({ node: initial }) => {
  const dom = document.createElement("div");
  dom.contentEditable = "false";
  const draw = (node: ProseMirrorNode) => {
    const atom = readWordAtom(node.attrs);
    dom.replaceChildren(boxLabel(atom), ...boxLines(atom));
    dom.className = "word-block";
    dom.dataset.kind = atom.kind;
    dom.dataset.testid = "word-block";
    const description = describe(atom);
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", description.replaceAll("\n", ". "));
    dom.title = description;
  };
  draw(initial);
  return {
    dom,
    update(next: ProseMirrorNode) {
      if (next.type !== initial.type) return false;
      draw(next);
      return true;
    },
    ignoreMutation: () => true,
  };
};
