/**
 * A text shape's paragraphs as the person left them in its editable box
 * (SlideCanvas): each piece of text with the run it was typed into, read
 * from the `data-run` mark of the span it sits in. The browser splits and
 * copies those spans as text is typed, joined and deleted, so the mark goes
 * with the text; text typed where no span is has no run.
 */
import type { TextBody } from "../../../../core/documents/formats/pptxDrawing";
import type {
  EditedParagraph,
  EditedRun,
  RunSource,
} from "../../../../core/exports/pptxPatch/shapeEdit";
import type { MeasuredFit } from "./textFit";

export interface TextEditing {
  /** The shape's path on its slide, or its table cell's. */
  path: string;
  /** The editable box is in the page: it takes the focus and the caret. */
  opened: (element: HTMLElement) => void;
  /**
   * The box lost the focus: its paragraphs, or null when nothing changed, and how it follows its
   * text now, or null when that needs nothing written.
   */
  done: (paragraphs: EditedParagraph[] | null, fit: MeasuredFit | null) => void;
}

const sourceOf = (mark: string | undefined): RunSource | null => {
  const [paragraph, run] = (mark ?? "").split(".").map(Number);
  return paragraph === undefined || run === undefined || Number.isNaN(paragraph + run)
    ? null
    : { paragraph, run };
};

function collect(
  node: Node,
  source: RunSource | null,
  into: EditedRun[],
  unmarked: Set<EditedRun>,
) {
  if (node.nodeType === Node.TEXT_NODE) {
    into.push({ source, text: node.textContent ?? "" });
    return;
  }
  if (!(node instanceof HTMLElement) || node.dataset.quoteSkip !== undefined) return;
  if (node.tagName === "BR") {
    const run = { source: sourceOf(node.dataset.run), text: "\n" };
    if (node.dataset.run === undefined) unmarked.add(run);
    into.push(run);
    return;
  }
  const own = node.dataset.run !== undefined ? sourceOf(node.dataset.run) : source;
  for (const each of node.childNodes) collect(each, own, into, unmarked);
}

const sameSource = (a: RunSource | null, b: RunSource | null) =>
  a?.paragraph === b?.paragraph && a?.run === b?.run;

/** Without empty text, and text the browser split into several nodes of one run joined again. */
function tidied(runs: readonly EditedRun[]): EditedRun[] {
  const out: EditedRun[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = out.at(-1);
    if (last && last.text !== "\n" && run.text !== "\n" && sameSource(last.source, run.source)) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

const isParagraph = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement && (node.tagName === "P" || node.tagName === "DIV");

/** The box's paragraphs, or null when they are the body's own, unchanged. */
export function editedParagraphs(root: HTMLElement, body: TextBody): EditedParagraph[] | null {
  const paragraphs: EditedParagraph[] = [];
  let loose: EditedParagraph | null = null;
  const unmarked = new Set<EditedRun>();
  const holder = root.querySelector<HTMLElement>(":scope > [data-paragraphs]") ?? root;
  for (const node of holder.childNodes) {
    if (isParagraph(node)) {
      const source = node.dataset.paragraph === undefined ? null : Number(node.dataset.paragraph);
      const paragraph: EditedParagraph = { source, runs: [] };
      for (const each of node.childNodes) collect(each, null, paragraph.runs, unmarked);
      // The browser's own line break at a paragraph's end only holds the empty line open.
      const last = paragraph.runs.at(-1);
      if (last && unmarked.has(last)) paragraph.runs.pop();
      paragraph.runs = tidied(paragraph.runs);
      paragraphs.push(paragraph);
      loose = null;
    } else {
      // Text left straight in the box, when every paragraph was deleted and typed again.
      if (!loose) {
        loose = { source: paragraphs.length === 0 ? 0 : null, runs: [] };
        paragraphs.push(loose);
      }
      collect(node, null, loose.runs, unmarked);
      loose.runs = tidied(loose.runs);
    }
  }
  return same(paragraphs, body) ? null : paragraphs;
}

function same(paragraphs: readonly EditedParagraph[], body: TextBody): boolean {
  if (paragraphs.length !== body.paragraphs.length) return false;
  return paragraphs.every((paragraph, index) => {
    if (paragraph.source !== index) return false;
    const was = body.paragraphs[index]?.runs ?? [];
    const original = tidied(
      was.map((run, at) => ({
        source: { paragraph: index, run: at },
        text: run.lineBreak ? "\n" : run.text,
      })),
    );
    const now = paragraph.runs;
    return (
      original.length === now.length &&
      original.every(
        (run, at) => run.text === now[at]?.text && sameSource(run.source, now[at]?.source ?? null),
      )
    );
  });
}
