import { Extension, getChangedRanges } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  ANALYSIS_TABLE_NODE,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigureAttributes,
  CITATION_NODE,
  type CitationAttributes,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  WORD_ATOM_NODE,
} from "../../../core/api";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";
import type { CitationForm } from "../../../shared/citationStyles";
import { type CitationLive, citationSubject, footnoteSubjectKey } from "../../../shared/citations";
import { MOST_QUOTES_AT_ONCE } from "../../../shared/documentViewer";
import { FootnoteNumbering } from "../../../shared/footnoteNumbers";
import { citationLocation } from "../../../shared/locations";
import { readProposalAttribute } from "../../../shared/proposals";
import { asOneStep } from "./editorUndo";

/**
 * A Citation in the Mind, with its number: its place among the Mind's
 * footnotes (see `numberFootnotes`), from 1.
 */
export interface NumberedCitation {
  /** Where the Citation node is. */
  pos: number;
  number: number;
  /** Names the Citation across edits: its Block's ID (or index) and its order within the Block. */
  key: string;
  attributes: CitationAttributes;
  /**
   * Whether it is a footnote of its own in an export: the first Citation of a
   * source and place in Numbered, the first of Citations side by side in a
   * note style, none in a style that cites in the text (#289).
   */
  footnote: boolean;
  /**
   * The place, among the Mind's Citations, of the one whose chip shows this one: the first of
   * the Citations side by side with it that has its number, which may be itself. Citations of
   * one source and place side by side read as one chip (see `CitationGroup`).
   */
  shownBy: number;
}

/**
 * A footnote the User wrote, with its number among the Mind's footnotes, from
 * 1; an endnote (#746) is numbered among the endnotes. A Word file's note the
 * import kept as is (`kept`) counts too, as the file counts it.
 */
export interface NumberedFootnote {
  /** Where the footnote node is. */
  pos: number;
  number: number;
  /** Its stable ID (`BLOCK_ID_ATTRIBUTE`). */
  id: string;
  node: ProseMirrorNode;
  endnote: boolean;
  kept: boolean;
}

/** A Word file's note kept as is, read-only, which numbers with the footnotes or the endnotes. */
const keptNote = (node: ProseMirrorNode): "footnote" | "endnote" | null => {
  if (node.type.name !== WORD_ATOM_NODE) return null;
  const kind: unknown = node.attrs.kind;
  return kind === "footnote" || kind === "endnote" ? kind : null;
};

export interface NumberedFigure {
  pos: number;
  /** The note number, or the shared cited ordinal in an in-text style. */
  number: number;
  attributes: CalculatedFigureAttributes;
}

/** The marker on an Analysis table's caption (#2378), with its number in the one series. */
export interface NumberedTable {
  pos: number;
  number: number;
}

/** The Mind's Citations, calculated figures and the User's footnotes, numbered in one traversal. */
export interface NumberedFootnotes {
  citations: NumberedCitation[];
  footnotes: NumberedFootnote[];
  figures: NumberedFigure[];
  tables: NumberedTable[];
}

/** Whether nothing but spaces stands between two Citations, at these positions, of one text block. */
export function sideBySide(doc: ProseMirrorNode, before: number, after: number): boolean {
  if (doc.resolve(before).parent !== doc.resolve(after).parent) return false;
  let only = true;
  doc.nodesBetween(before + 1, after, (node) => {
    if (node.isText ? (node.text ?? "").trim() !== "" : node.isInline) only = false;
    return only;
  });
  return only;
}

/**
 * Every Citation and every footnote the User wrote, top to bottom, numbered
 * together through the Mind, as Word, the PDF and a copy number them
 * (`FootnoteNumbering`). How a Citation counts depends on the Mind's citation
 * style (#289): in Numbered, one footnote for each source and place, and a
 * later Citation of the same one repeats its number (#1381); in a note style,
 * Citations side by side are one note, one number; in a style that cites in
 * the text, none is a footnote, and Citations use a cited ordinal for their
 * margin marks, the User's footnotes on their own. Calculated figures join the
 * footnote numbers, or the cited ordinal in an in-text style; the latter
 * identifies their input clusters and doesn't make a footnote. A Citation
 * inside a footnote is part of that footnote's text and has no number of its
 * own. `live` settles each Citation's check as the app shows it, so a removed
 * Document's found and not-found Citations are one unverified footnote.
 */
export function numberFootnotes(
  doc: ProseMirrorNode,
  form: CitationForm = "numbered",
  live: CitationLive = { documents: null },
): NumberedFootnotes {
  const citations: NumberedCitation[] = [];
  const footnotes: NumberedFootnote[] = [];
  const figures: NumberedFigure[] = [];
  const tables: NumberedTable[] = [];
  const numbering = new FootnoteNumbering();
  let endnotes = 0;
  let cited = 0;
  /**
   * The chips of the Citations side by side with the last one: for each number and its source
   * and place, the Citation that shows it and how many it stands for.
   */
  let shown = new Map<string, { at: number; count: number }>();
  doc.forEach((block, offset, index) => {
    const id = block.attrs[BLOCK_ID_ATTRIBUTE];
    const blockKey = typeof id === "string" ? id : `#${index}`;
    // A Citation a change still waiting adds or removes is a footnote of its own (#107).
    const blockInChange = readProposalAttribute(block.attrs[PROPOSAL_ATTRIBUTE]) !== null;
    let inBlock = 0;
    block.descendants((node, pos) => {
      const name = node.type.name;
      const kept = keptNote(node);
      if (name === FOOTNOTE_NODE || kept) {
        const endnote = kept ? kept === "endnote" : node.attrs.endnote === true;
        const at = endnote ? ++endnotes : numbering.footnote();
        const footnoteId: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
        footnotes.push({
          pos: offset + 1 + pos,
          number: at,
          id:
            typeof footnoteId === "string"
              ? footnoteId
              : `${blockKey}:${endnote ? "endnote" : "footnote"}:${at}`,
          node,
          endnote,
          kept: kept !== null,
        });
        return false;
      }
      if (name === CALCULATED_FIGURE_NODE) {
        const attributes = readCalculatedFigureAttributes(node.attrs);
        if (!attributes) return false;
        if (form === "in-text") cited += 1;
        figures.push({
          pos: offset + 1 + pos,
          number: form === "in-text" ? cited : numbering.footnote(),
          attributes,
        });
        return false;
      }
      if (name === ANALYSIS_TABLE_NODE) {
        if (form === "in-text") cited += 1;
        tables.push({
          pos: offset + 1 + pos,
          number: form === "in-text" ? cited : numbering.footnote(),
        });
        return false;
      }
      if (name !== CITATION_NODE) return true;
      const at = offset + 1 + pos;
      const attributes = node.attrs as CitationAttributes;
      const previous = citations.at(-1);
      const beside = previous !== undefined && sideBySide(doc, previous.pos, at);
      const joined = form === "note" && beside;
      let number: number;
      let footnote: boolean;
      if (form === "numbered") {
        if (blockInChange || readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]) !== null) {
          number = numbering.footnote();
          footnote = true;
        } else {
          const numbered = numbering.citation(citationSubject(attributes, live));
          number = numbered.number;
          footnote = numbered.first;
        }
      } else if (form === "in-text") {
        cited += 1;
        number = cited;
        footnote = false;
      } else if (joined) {
        number = previous?.number ?? numbering.footnote();
        footnote = false;
      } else {
        number = numbering.footnote();
        footnote = true;
      }
      inBlock += 1;
      if (!beside) shown = new Map();
      // One number is one source and place in Numbered, but one note of several in a note style:
      // a chip stands only for Citations of one place, so one opening shows all its quotes.
      // A screen's Citation keeps its own chip: its card shows the screen it quotes.
      const ownChip = citationLocation(attributes)?.kind === "screen";
      const chip = `${number}\u0000${footnoteSubjectKey(citationSubject(attributes, live))}`;
      const joins = ownChip ? undefined : shown.get(chip);
      const shownBy = joins && joins.count < MOST_QUOTES_AT_ONCE ? joins.at : citations.length;
      if (joins && shownBy === joins.at) joins.count += 1;
      else if (!ownChip) shown.set(chip, { at: citations.length, count: 1 });
      citations.push({
        pos: at,
        number,
        key: `${blockKey}:${inBlock}`,
        attributes,
        footnote,
        shownBy,
      });
      return false;
    });
  });
  return { citations, footnotes, figures, tables };
}

/** Every Citation, top to bottom, numbered among the Mind's footnotes (see `numberFootnotes`). */
export function numberCitations(
  doc: ProseMirrorNode,
  form: CitationForm = "numbered",
): NumberedCitation[] {
  return numberFootnotes(doc, form).citations;
}

const numberedIn = (textBlock: ProseMirrorNode) => {
  const found: ProseMirrorNode[] = [];
  textBlock.forEach((child) => {
    const name = child.type.name;
    if (
      name === CITATION_NODE ||
      name === FOOTNOTE_NODE ||
      name === CALCULATED_FIGURE_NODE ||
      name === ANALYSIS_TABLE_NODE ||
      keptNote(child)
    )
      found.push(child);
  });
  return found;
};

/**
 * Where the text block is (its position before it, after the change) when a
 * change edits only inside one text block and leaves its Citations, figures
 * and footnotes as they were, as typing does; null for any other change. Such a
 * change renumbers nothing, and moves their markers outside the
 * block only along the document: on screen too, unless the block grows or shrinks.
 */
export function textBlockEdited(tr: Transaction): number | null {
  if (!tr.docChanged) return null;
  const changes = getChangedRanges(tr);
  const [change] = changes;
  if (!change || changes.length > 1) return null;
  const within = (doc: ProseMirrorNode, { from, to }: { from: number; to: number }) => {
    const $from = doc.resolve(from);
    return $from.depth > 0 && $from.parent.isTextblock && to <= $from.end() ? $from : null;
  };
  const before = within(tr.before, change.oldRange);
  const after = within(tr.doc, change.newRange);
  if (!before || !after) return null;
  // An edit beside a Citation keeps the very node; one added, removed or replaced doesn't.
  const were = numberedIn(before.parent);
  const are = numberedIn(after.parent);
  return were.length === are.length && were.every((node, index) => node === are[index])
    ? after.before()
    : null;
}

/**
 * The attribute a numbered marker is drawn in. It is part of
 * the decoration's attributes, not just its spec, so renumbering counts as a
 * change and the node's view is updated.
 */
const NUMBER_ATTRIBUTE = "data-citation-number";
const GROUP_ATTRIBUTE = "data-citation-group";
const FOOTNOTE_NUMBER_ATTRIBUTE = "data-footnote-number";
const FIGURE_NUMBER_ATTRIBUTE = "data-figure-number";
const TABLE_NUMBER_ATTRIBUTE = "data-table-number";

function decoratedNumber(
  decorations: readonly Decoration[],
  key: "citationNumber" | "footnoteNumber" | "figureNumber" | "tableNumber",
): number {
  for (const decoration of decorations) {
    const number: unknown = decoration.spec[key];
    if (typeof number === "number") return number;
  }
  return 0;
}

/** A Citation's number, from the decorations its node view is given; 0 if it has none. */
export function citationNumberOf(decorations: readonly Decoration[]): number {
  return decoratedNumber(decorations, "citationNumber");
}

/**
 * Citations of one source and place side by side, which show as one chip: the first draws it
 * for all of them, and the rest show nothing of their own (`NumberedCitation.shownBy`).
 */
export interface CitationGroup {
  /** The Citation's own `NumberedCitation.key`. */
  key: string;
  /** Whether its chip shows: it is the first of its group. */
  shows: boolean;
  /** The group's Citations' keys, in reading order: given to the one that shows them. */
  members: readonly string[];
}

/** The group a Citation's decorations give it; alone, a group of its own, without the plugin. */
export function citationGroupOf(decorations: readonly Decoration[]): CitationGroup | null {
  for (const decoration of decorations) {
    const group: unknown = decoration.spec.citationGroup;
    if (group) return group as CitationGroup;
  }
  return null;
}

/** A footnote's number, from the decorations its node view is given; 0 if it has none. */
export function footnoteNumberOf(decorations: readonly Decoration[]): number {
  return decoratedNumber(decorations, "footnoteNumber");
}

/** A calculated figure's number from its node-view decorations; 0 if it has none. */
export function figureNumberOf(decorations: readonly Decoration[]): number {
  return decoratedNumber(decorations, "figureNumber");
}

/** An Analysis table's marker's number from its node-view decorations; 0 if it has none. */
export function tableNumberOf(decorations: readonly Decoration[]): number {
  return decoratedNumber(decorations, "tableNumber");
}

/** The document's numbered markers and their decorations. */
interface Numbers extends Readonly<NumberedFootnotes> {
  decorations: DecorationSet;
  /** Raised to redraw footnote and figure markers, e.g. in the interface's new language. */
  generation: number;
  /** How the Mind's citation style counts Citations (see `numberFootnotes`). */
  form: CitationForm;
  /** The live Documents, and the text kept of those unlinked, its checks were settled with. */
  live: CitationLive;
}

const numbersKey = new PluginKey<Numbers>("citationNumbers");

/** A transaction with this meta redraws every footnote's marker (see `redrawFootnotes`). */
const REDRAW = "redrawFootnotes";

/** A transaction with this meta numbers again for another citation style (`setCitationForm`). */
const FORM = "citationForm";

function numbersOf(
  doc: ProseMirrorNode,
  generation: number,
  form: CitationForm,
  live: CitationLive,
): Numbers {
  const { citations, footnotes, figures, tables } = numberFootnotes(doc, form, live);
  const node = (pos: number, attrs: Record<string, string>, spec: Record<string, number>) =>
    Decoration.node(pos, pos + (doc.nodeAt(pos)?.nodeSize ?? 1), attrs, spec);
  const keysByLead = new Map<number, string[]>();
  for (const { shownBy, key } of citations) {
    keysByLead.set(shownBy, [...(keysByLead.get(shownBy) ?? []), key]);
  }
  const decorations = DecorationSet.create(doc, [
    ...citations.map(({ pos, number, key, shownBy }, place) => {
      const shows = shownBy === place;
      const members = shows ? (keysByLead.get(place) ?? [key]) : [];
      const citationGroup: CitationGroup = { key, shows, members };
      return Decoration.node(
        pos,
        pos + (doc.nodeAt(pos)?.nodeSize ?? 1),
        {
          [NUMBER_ATTRIBUTE]: String(number),
          // In the attributes, so a Citation that joins or leaves a group is drawn again.
          [GROUP_ATTRIBUTE]: shows ? members.join(" ") : "",
        },
        { citationNumber: number, citationGroup },
      );
    }),
    ...footnotes.map(({ pos, number }) =>
      node(
        pos,
        { [FOOTNOTE_NUMBER_ATTRIBUTE]: String(number) },
        { footnoteNumber: number, generation },
      ),
    ),
    ...figures.map(({ pos, number }) =>
      node(
        pos,
        { [FIGURE_NUMBER_ATTRIBUTE]: String(number) },
        { figureNumber: number, generation },
      ),
    ),
    ...tables.map(({ pos, number }) =>
      node(pos, { [TABLE_NUMBER_ATTRIBUTE]: String(number) }, { tableNumber: number, generation }),
    ),
  ]);
  return { citations, footnotes, figures, tables, decorations, generation, form, live };
}

/**
 * The editor's Citations, numbered (see `numberFootnotes`), as of its last
 * change: worked out once per change, for every view of them. Empty without
 * `CitationNumbers`.
 */
export function numberedCitations(state: EditorState): readonly NumberedCitation[] {
  return numbersKey.getState(state)?.citations ?? [];
}

/** How the editor numbers Citations, as of its last change: Numbered when it doesn't say (#289). */
export function citationFormOf(state: EditorState): CitationForm {
  return numbersKey.getState(state)?.form ?? "numbered";
}

/** The live Documents its numbers were settled with, or none without `CitationNumbers`. */
export function citationLiveOf(state: EditorState): CitationLive {
  return numbersKey.getState(state)?.live ?? { documents: null };
}

/** The editor's footnotes, numbered (see `numberFootnotes`), as of its last change. */
export function numberedFootnotes(state: EditorState): readonly NumberedFootnote[] {
  return numbersKey.getState(state)?.footnotes ?? [];
}

/** The editor's calculated figures, numbered by the canonical Citation/Footnote traversal. */
export function numberedFigures(state: EditorState): readonly NumberedFigure[] {
  return numbersKey.getState(state)?.figures ?? [];
}

/** Redraws footnote and figure markers, e.g. once the interface's language or the live Documents changed. */
export function redrawFootnotes(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(REDRAW, true));
}

/** Numbers the Citations and footnotes again for the Mind's citation style, when it changes. */
export function setCitationForm(view: EditorView, form: CitationForm): void {
  if (numbersKey.getState(view.state)?.form === form) return;
  view.dispatch(view.state.tr.setMeta(FORM, form));
}

/** How many Citations a text block holds. */
const citationsIn = (block: ProseMirrorNode | null) => {
  let count = 0;
  block?.forEach((child) => {
    if (child.type.name === CITATION_NODE) count++;
  });
  return count;
};

const isCitationForm = (value: unknown): value is CitationForm =>
  value === "numbered" || value === "note" || value === "in-text";

/**
 * The plugin behind `CitationNumbers`, which keeps the numbers in the editor's state, for
 * the citation style's form as it starts (`form`) and as `setCitationForm` changes it, and
 * for the Citations' checks as `live` settles them.
 */
export function citationNumbersPlugin(
  form: () => CitationForm = () => "numbered",
  live: () => CitationLive = () => ({ documents: null }),
): Plugin<Numbers> {
  return new Plugin<Numbers>({
    key: numbersKey,
    state: {
      init: (_config, state) => numbersOf(state.doc, 0, form(), live()),
      apply: (tr, numbers) => {
        const changedForm: unknown = tr.getMeta(FORM);
        if (isCitationForm(changedForm)) {
          return numbersOf(tr.doc, numbers.generation + 1, changedForm, live());
        }
        if (tr.getMeta(REDRAW))
          return numbersOf(tr.doc, numbers.generation + 1, numbers.form, live());
        if (!tr.docChanged) return numbers;
        const typedIn = textBlockEdited(tr);
        // Typing between two Citations can join or part their chip, or a note style's note.
        if (typedIn === null || citationsIn(tr.doc.nodeAt(typedIn)) > 1) {
          return numbersOf(tr.doc, numbers.generation, numbers.form, live());
        }
        // Typing: the Citations and footnotes move along, numbered as they were.
        return {
          citations: numbers.citations.map((each) => ({ ...each, pos: tr.mapping.map(each.pos) })),
          footnotes: numbers.footnotes.map((each) => ({ ...each, pos: tr.mapping.map(each.pos) })),
          figures: numbers.figures.map((each) => ({ ...each, pos: tr.mapping.map(each.pos) })),
          tables: numbers.tables.map((each) => ({ ...each, pos: tr.mapping.map(each.pos) })),
          decorations: numbers.decorations.map(tr.mapping, tr.doc),
          generation: numbers.generation,
          form: numbers.form,
          live: numbers.live,
        };
      },
    },
    props: {
      decorations: (state) => numbersKey.getState(state)?.decorations,
    },
  });
}

/**
 * What a key does beside a chip that stands for several Citations (#3654). The Citations it hides
 * take no room, so the caret steps over them with the chip, as one; Backspace or Delete removes the
 * chip with every Citation it stands for, wherever in its run they are; beside a hidden one that
 * another chip stands for, they act on the chip beyond it and leave that one to its own. Null where
 * the key does what it always does, as beside a chip of one Citation.
 */
export function groupKeyStep(state: EditorState, key: string): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const citations = numbersKey.getState(state)?.citations ?? [];
  const placeAt = new Map(citations.map((each, place) => [each.pos, place]));
  const hidden = (pos: number) => {
    const place = placeAt.get(pos);
    return place !== undefined && citations[place]?.shownBy !== place;
  };
  const shownAt = (pos: number) => {
    const place = placeAt.get(pos);
    return place !== undefined && citations[place]?.shownBy === place ? place : null;
  };
  const step = key === "ArrowRight" || key === "Delete" ? 1 : -1;
  const ahead = (pos: number) => (step === 1 ? pos : pos - 1);
  let at = selection.from;
  let skipped = false;
  // The spaces a run of Citations side by side may hold are passed with the hidden ones they lead to.
  const spaceAt = (pos: number) =>
    pos >= 0 && pos < state.doc.content.size && state.doc.textBetween(pos, pos + 1) === " ";
  const skipHidden = () => {
    for (;;) {
      let past = at;
      while (spaceAt(ahead(past))) past += step;
      if (!hidden(ahead(past))) return;
      at = past + step;
      skipped = true;
    }
  };
  skipHidden();
  if (skipped) {
    let past = at;
    while (spaceAt(ahead(past))) past += step;
    if (shownAt(ahead(past)) !== null) at = past;
  }
  const chip = shownAt(ahead(at));
  if (key === "ArrowRight" || key === "ArrowLeft") {
    if (chip !== null) {
      at += step;
      skipHidden();
    }
    return skipped ? state.tr.setSelection(TextSelection.create(state.doc, at)) : null;
  }
  if (key !== "Backspace" && key !== "Delete") return null;
  if (chip === null) return null;
  const stood = citations.filter((each) => each.shownBy === chip).map((each) => each.pos);
  if (stood.length === 1 && !skipped) return null;
  const tr = state.tr;
  for (const pos of stood.sort((a, b) => b - a)) tr.delete(pos, pos + 1);
  return tr.scrollIntoView();
}

/**
 * A space written before a Citation, as an outside agent writes "claim [cite:…]", kept on the
 * line with the chip: a chip never starts a line (DESIGN.md, Citation marker). The text keeps it.
 */
function leadSpace(doc: ProseMirrorNode, pos: number): Decoration[] {
  if (pos < 1 || doc.resolve(pos).parentOffset < 1) return [];
  return doc.textBetween(pos - 1, pos) === " "
    ? [Decoration.inline(pos - 1, pos, { class: "citation-lead-space" })]
    : [];
}

const leadSpacesKey = new PluginKey<{ numbers: Numbers | undefined; set: DecorationSet }>(
  "citationLeadSpaces",
);

/** The spaces before the Citations (`leadSpace`), drawn again as the numbers are worked out. */
function leadSpacesPlugin(): Plugin {
  const of = (state: EditorState) => {
    const numbers = numbersKey.getState(state);
    const spaces = (numbers?.citations ?? []).flatMap(({ pos }) => leadSpace(state.doc, pos));
    return { numbers, set: DecorationSet.create(state.doc, spaces) };
  };
  return new Plugin({
    key: leadSpacesKey,
    state: {
      init: (_config, state) => of(state),
      apply: (_tr, kept, _old, state) =>
        numbersKey.getState(state) === kept.numbers ? kept : of(state),
    },
    props: { decorations: (state) => leadSpacesKey.getState(state)?.set },
  });
}

/**
 * Numbers Citations, figures and footnotes (see `numberFootnotes`) with a node
 * decoration each, which reaches the node's view: it shows the number, and
 * redraws when an edit renumbers it. `form` says how the Mind's citation style
 * counts Citations when the editor opens, and `live` gives the Documents a
 * Citation's check is settled with.
 */
export const CitationNumbers = Extension.create<{
  form: () => CitationForm;
  live: () => CitationLive;
}>({
  name: "citationNumbers",
  // Ahead of the editor's own arrows and Backspace, which would take the hidden Citations one by one.
  priority: 1000,

  addKeyboardShortcuts() {
    const press = (key: string) => () => {
      const step = groupKeyStep(this.editor.state, key);
      if (!step) return false;
      if (step.docChanged) asOneStep(this.editor, () => this.editor.view.dispatch(step));
      else this.editor.view.dispatch(step);
      return true;
    };
    return {
      ArrowLeft: press("ArrowLeft"),
      ArrowRight: press("ArrowRight"),
      Backspace: press("Backspace"),
      Delete: press("Delete"),
    };
  },

  addOptions() {
    return { form: () => "numbered", live: () => ({ documents: null }) };
  },

  addProseMirrorPlugins() {
    return [citationNumbersPlugin(this.options.form, this.options.live), leadSpacesPlugin()];
  },
});
