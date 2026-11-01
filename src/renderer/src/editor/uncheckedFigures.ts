/**
 * The figures an Answer read from a word a scan may have misread (#535). A
 * figure whose characters are in the text a scan gave, but lie in a word the
 * reading wasn't sure of, isn't a quoted figure: it shows quietly, with a
 * "?" that says where it came from and opens the page.
 */
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ANSWER_BLOCK, CITATION_NODE, type CitationAttributes } from "../../../core/api";
import { citationState } from "../../../shared/citations";
import { readFigures } from "../../../shared/figures";
import { memoized } from "../../../shared/memo";
import { misreadDigits, numberDigits } from "../../../shared/misreadWords";
import { INLINE_NODE, sentenceSpans } from "../../../shared/sentences";
import { translateNow } from "../i18n";
import { openCited } from "../openCited";

interface FigureSource {
  word: string;
  citation: CitationAttributes;
}

/** Whether `numeral` is written whole in the quote from `from` to `to`, not as part of a longer number. */
function wholeIn(quote: string, from: number, to: number, numeral: string): boolean {
  for (
    let at = quote.indexOf(numeral, from);
    at >= 0 && at + numeral.length <= to;
    at = quote.indexOf(numeral, at + 1)
  ) {
    const before = quote[at - 1] ?? "";
    const after = quote[at + numeral.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/**
 * The unsure word a figure was read from, by the Citation in its sentence:
 * the word holds the figure's numeral whole, or its digits read as the
 * figure's do ("7a;45o" and "7,450" both read 7450, while "2" doesn't read as
 * "2o25").
 */
export function sourceOf(
  figure: string,
  citations: readonly CitationAttributes[],
): FigureSource | null {
  const numeral = /[\d.,]+/u.exec(figure)?.[0] ?? "";
  const digits = numberDigits(numeral);
  if (digits === "") return null;
  for (const citation of citations) {
    // The Citation's state settles a page the User confirmed: the figure is then no longer unchecked.
    const state = citationState(citation, null);
    if (state.check !== "cant-check" || state.reason !== "unsure-word") continue;
    const quote = citation.quote ?? "";
    for (const word of citation.unsure ?? []) {
      if (!word) continue;
      for (let at = quote.indexOf(word); at >= 0; at = quote.indexOf(word, at + 1)) {
        if (wholeIn(quote, at, at + word.length, numeral)) return { word, citation };
      }
      if (misreadDigits(word) === digits) return { word, citation };
    }
  }
  return null;
}

/** A paragraph's text (an inline node as one character) and where its Citations are in it. */
function textOf(node: ProseMirrorNode): {
  text: string;
  citations: { at: number; attributes: CitationAttributes }[];
} {
  let text = "";
  const citations: { at: number; attributes: CitationAttributes }[] = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      text += child.text ?? "";
      return;
    }
    if (child.type.name === CITATION_NODE) {
      citations.push({ at: offset, attributes: child.attrs as CitationAttributes });
    }
    text += child.type.name === "hardBreak" ? "\n" : INLINE_NODE;
  });
  return { text, citations };
}

let shownCard: { element: HTMLDivElement; dismiss: (event: Event) => void } | null = null;

function hideCard(): void {
  if (!shownCard) return;
  document.removeEventListener("pointerdown", shownCard.dismiss, true);
  document.removeEventListener("keydown", shownCard.dismiss, true);
  shownCard.element.remove();
  shownCard = null;
}

/**
 * The card a figure's "?" opens: where the figure came from, in the word the scan may have
 * misread, and the page to look at.
 */
function showCard(anchor: HTMLElement | null, source: FigureSource): void {
  hideCard();
  if (!anchor) return;
  const card = document.createElement("div");
  card.className = "citation-card citation-card--cant-check unchecked-figure-card";
  card.dataset.testid = "unchecked-figure-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", translateNow("uncheckedFigure.heading"));
  const head = document.createElement("p");
  head.className = "unchecked-figure-heading";
  head.textContent = translateNow("uncheckedFigure.heading");
  const why = document.createElement("p");
  why.className = "citation-card-note";
  why.textContent = translateNow("uncheckedFigure.why", { word: source.word });
  const actions = document.createElement("div");
  actions.className = "citation-card-actions";
  const documentId = source.citation.documentId;
  if (documentId) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "citation-card-action citation-card-action--primary";
    open.dataset.testid = "unchecked-figure-open";
    open.textContent = translateNow("citation.open.page");
    open.addEventListener("click", () => {
      hideCard();
      openCited({ ...source.citation, documentId }, { check: "cant-check", withQuote: true });
    });
    actions.append(open);
  }
  card.append(head, why, actions);
  document.body.append(card);
  const box = anchor.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, box.left))}px`;
  card.style.top = `${Math.min(window.innerHeight - card.offsetHeight - 8, box.bottom + 6)}px`;
  const dismiss = (event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (event.key !== "Escape") return;
    } else if (event.target instanceof Node && card.contains(event.target)) return;
    hideCard();
  };
  document.addEventListener("pointerdown", dismiss, true);
  document.addEventListener("keydown", dismiss, true);
  shownCard = { element: card, dismiss };
  // The keyboard reaches what it opened: Tab from the "?" lands on the card's action.
  actions.querySelector("button")?.focus();
}

/** The "?" after a figure, which says where the figure came from and opens the page. */
function markFor(source: FigureSource): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "unchecked-figure-mark";
  button.dataset.testid = "unchecked-figure-mark";
  button.dataset.word = source.word;
  button.textContent = "?";
  const why = translateNow("uncheckedFigure.why", { word: source.word });
  button.setAttribute("aria-label", `${translateNow("uncheckedFigure.mark")}. ${why}`);
  button.title = why;
  button.contentEditable = "false";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showCard(button, source);
  });
  return button;
}

/** A figure in an Answer's paragraph that came from an unsure word, where it is in the paragraph. */
interface UncheckedFigure {
  from: number;
  to: number;
  source: FigureSource;
}

/** A Citation in a paragraph's text, and where it is in it. */
interface Cited {
  at: number;
  attributes: CitationAttributes;
}

/**
 * The figures of a paragraph's text that come from an unsure word of its Citation, read once for
 * each paragraph text and its Citations: a change elsewhere in the Note reads the rest as before.
 */
const figuresOf = memoized(
  2000,
  (text: string, citations: readonly Cited[]) =>
    `${text}\u0000${JSON.stringify(
      citations.map((each) => [
        each.at,
        each.attributes.check,
        each.attributes.checkReason,
        each.attributes.pageChecked ?? false,
        each.attributes.unsure ?? [],
      ]),
    )}`,
  (text: string, citations: readonly Cited[]): UncheckedFigure[] => {
    const found: UncheckedFigure[] = [];
    for (const span of sentenceSpans(text)) {
      const inSentence = citations.filter((each) => each.at >= span.from && each.at < span.to);
      if (inSentence.length === 0) continue;
      for (const figure of readFigures(text.slice(span.from, span.to))) {
        const source = sourceOf(
          figure.chars,
          inSentence.map((each) => each.attributes),
        );
        if (!source) continue;
        found.push({
          from: span.from + figure.start,
          to: span.from + figure.end,
          source,
        });
      }
    }
    return found;
  },
);

/** The decorations for one paragraph of an Answer, its text starting at `base`. */
function decorationsIn(node: ProseMirrorNode, base: number): Decoration[] {
  const { text, citations } = textOf(node);
  if (citations.length === 0) return [];
  return figuresOf(text, citations).flatMap(({ from, to, source }): Decoration[] => [
    Decoration.inline(base + from, base + to, {
      class: "unchecked-figure-wash",
      "data-testid": "unchecked-figure",
    }),
    Decoration.widget(base + to, () => markFor(source), {
      side: 1,
      key: `unchecked-figure:${base + from}:${source.word}`,
    }),
  ]);
}

/** Every unchecked figure in an Answer's paragraphs, a Note's Blocks' or the assistant's own. */
export function uncheckedFigureDecorations(doc: ProseMirrorNode): Decoration[] {
  let answers = false;
  doc.descendants((node) => {
    if (node.type.name === ANSWER_BLOCK) answers = true;
    return !answers;
  });
  const decorations: Decoration[] = [];
  if (!answers) {
    doc.descendants((node, pos) => {
      if (node.type.name !== "paragraph") return true;
      decorations.push(...decorationsIn(node, pos + 1));
      return false;
    });
    return decorations;
  }
  doc.forEach((block, offset) => {
    if (block.type.name !== ANSWER_BLOCK) return;
    block.descendants((node, at) => {
      if (node.type.name !== "paragraph") return true;
      decorations.push(...decorationsIn(node, offset + 1 + at + 1));
      return false;
    });
  });
  return decorations;
}

/** The quiet wash and "?" of a figure an Answer read from a scan's unsure word (#535). */
export const UncheckedFigures = Extension.create({
  name: "uncheckedFigures",

  onDestroy() {
    hideCard();
  },

  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>("uncheckedFigures");
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) =>
            DecorationSet.create(state.doc, uncheckedFigureDecorations(state.doc)),
          // A moved cursor changes no figure: only an edit reads them again.
          apply: (transaction, decorations) =>
            transaction.docChanged
              ? DecorationSet.create(transaction.doc, uncheckedFigureDecorations(transaction.doc))
              : decorations,
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});
