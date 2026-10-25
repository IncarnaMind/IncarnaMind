/**
 * The Minds' Tools, offered on every Answer in the assistant (#202): the
 * model decides whether to answer, change a Mind or make one (#1559), and to
 * change one, it calls these. A change applies in its Mind at once, with one
 * Undo, after a Checkpoint of the Mind (#113); one that would take out most of
 * the User's own text waits there as Proposals for them to apply or discard.
 *
 * - `read_mind` reads a Mind the User names. The one in focus is in the
 *   Question context already.
 * - `edit_mind` changes text already in a Mind, as an instruction says: the
 *   selection, a section (named by its heading) or the whole Mind, rewritten
 *   as Edit with AI rewrites a selection (../../edits), on the Answer's model,
 *   its Citations kept.
 * - `add_to_mind` adds text the model wrote, with the Citations it recorded
 *   with `cite`, at the end of a section or after a paragraph, or at the end.
 * - `create_mind` makes a Mind titled as the model says, in the Folder of the
 *   Question's Search scope when that is one Folder, else in none, holding
 *   the text the model wrote, if any.
 *
 * The sentences with Citations a call writes, new or as `edit_mind`'s
 * content, are checked against them before they land, and what they don't
 * support is taken out or marked (../../answers/checks/written, #1111).
 *
 * A Mind is named by its name; left out, it is the one in focus. A call that
 * changed a Mind says so on its card (`MindChange`), and one that changed
 * nothing says why (`MindProblem`). What the model reads back says what was
 * done, or why nothing was, so its reply can say so.
 *
 * Its own changes still waiting are the assistant's to revise:
 * `edit_mind` over them rewrites that waiting text in place, by its
 * instruction or with new `content`, so "make it longer" leaves one version.
 * Over changes it can't revise, it changes nothing, and says so.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { askedFor, waitsForUser } from "../../../shared/askedChanges";
import { setOrigins } from "../../../shared/blockOrigins";
import {
  type ChartData,
  chartFromTable,
  gridOfTable,
  readChart,
  sameChartData,
} from "../../../shared/charts";
import type { PlacedFigure } from "../../../shared/figureMarkers";
import { translate } from "../../../shared/i18n";
import { holdsNothing } from "../../../shared/madeMind";
import { looksLikeTable } from "../../../shared/markdownTables";
import {
  changedParagraphs,
  readProposalAttribute,
  recordProposalRequest,
  resolveProposals,
  waitingChanges,
} from "../../../shared/proposals";
import { countFor, countText, mostlyCjk } from "../../../shared/wordCount";
import {
  createElement,
  type NodeJSON,
  nodeOf,
  syncContent,
  topLevelBlocks,
} from "../../answers/blocks";
import type { CheckWrittenInput, WrittenCheck } from "../../answers/checks/written";
import type { ParagraphAsked } from "../../answers/paragraphAsked";
import { withoutPointersBack } from "../../answers/pointersBack";
import {
  BLOCK_ID_ATTRIBUTE,
  type BlockOrigin,
  CHART_NODE,
  type ChartProblem,
  CITATION_NODE,
  type EditWithAiResult,
  type Effect,
  type MindChange,
  type MindProblem,
  PROPOSAL_ATTRIBUTE,
  type RequestedChange,
  type TextPlace,
  type ThirdPartySource,
  type WritingPlace,
} from "../../api";
import type { Language } from "../../language";
import { plainText } from "../../mindText";
import { insertBlocks } from "../../noteAdding";
import {
  citationsDropped,
  type OwnApplied,
  type OwnWaiting,
  ownAppliedIn,
  ownAppliedTexts,
  ownAsked,
  ownWaitingTexts,
  replaceApplied,
  replaceOwn,
  waitingIn,
  writtenByAnswer,
} from "../../proposals/ownWaiting";
import { layout, textBlocks } from "../../proposals/write";
import type { PreparedChatModel } from "../../providers/chat";
import { MIND_TOOLS, type Tool, type ToolProviderInfo } from "..";
import { partialFields } from "../partialInput";
import {
  type ChartAsked,
  calculatedCells,
  chartAsked,
  chartOfTable,
  chartProperty,
} from "./charts";

const PROVIDER: ToolProviderInfo = { kind: "minds", id: "minds", name: "Minds" };

/** About how much of a named Mind `read_mind` gives, in tokens; a window cuts it further. */
const READ_TOKENS = 12_000;

/** A Mind the Tools can read and change. */
export interface ChangeableMind {
  id: string;
  /** Its name as the User sees it: its title, else the name taken from its text. */
  name: string;
}

/** What the Minds' Tools need of the core. */
export interface MindsForTools {
  /** The Minds the User can read and change now, the most recently changed first. */
  list(): ChangeableMind[];
  /** A Mind's Yjs content, read without changing it. */
  read<T>(mindId: string, look: (blocks: Y.XmlFragment) => T): T;
  /** Changes a Mind's Yjs content in one transaction. */
  edit<T>(mindId: string, change: (blocks: Y.XmlFragment) => T): T;
  /**
   * The Mind as the model reads the one in focus, within about `tokens`
   * tokens, and where the third-party text in what it gives came from (#78).
   */
  text(
    mindId: string,
    name: string,
    tokens: number,
  ): { text: string; origins: readonly ThirdPartySource[] };
  /** Saves a Checkpoint of the Mind as it is, before the AI changes it (#113). */
  checkpoint(mindId: string): void;
  /** Makes a Mind, in the Folder `folderId` or in none; `headed`, its text starts with its title (`makeMind`). */
  create(title: string, folderId: string | null, headed: boolean): ChangeableMind;
  /** Removes a Mind a call made, when it holds nothing but its title. */
  discard(mindId: string): void;
  /** The name of a Folder, or null when there is none by that id. */
  folderName(folderId: string): string | null;
  /** Says where a call is writing a Mind's new Blocks as they come (#202); `place` null once it has stopped. */
  writing(mindId: string, place: WritingPlace | null): void;
  /**
   * Edit with AI over a stretch of a Mind (../../edits, `proposeInMind`); over
   * the assistant's own changes still waiting, a revision of them (`revised`).
   */
  proposeInMind(input: {
    mindId: string;
    from: TextPlace;
    to: TextPlace;
    instruction: string;
    prepared: PreparedChatModel;
    signal: AbortSignal;
    /** Runs just before the change's first Proposals are written. */
    beforeWriting(): void;
    /** More of its Proposals are in the Mind, as they come. */
    written(request: string, count: number): void;
    requested: RequestedChange | null;
  }): Promise<{
    result: EditWithAiResult;
    length: { before: string; after: string } | null;
    reason: string | null;
    revised: { blockIds: string[] } | null;
  }>;
  /** Checks the cited sentences a call wrote before they land (../../answers/checks/written). */
  checkWritten(input: CheckWrittenInput): Promise<WrittenCheck | null>;
}

export interface MindToolsOptions {
  minds: MindsForTools;
  /** The model the Answer is written with: edits are made on it too. */
  prepared: PreparedChatModel;
  /**
   * The same model asked to skip thinking, for edit_mind's rewrites: one thinks for a minute
   * before rewriting a paragraph as asked (Kimi K2.6, #1635). Without it, `prepared`.
   */
  rewriting?(): Promise<PreparedChatModel>;
  /** The Mind the Question was asked from, and the Blocks the User selected in it; null: none. */
  focused: { mindId: string; blockIds: readonly string[] } | null;
  /** Where a new Mind goes: the Folder of the Question's Search scope when that is one Folder. */
  folderId: string | null;
  /** The Answer, and its Question, that Blocks it adds link back to. */
  origin: BlockOrigin;
  /**
   * The conversation's last Answer before this one, as Add to note puts it
   * in a Mind, with its Citations, the Answer its Blocks link back to, and
   * the Folder of its Question's Search scope, where a Mind made of it goes:
   * what `answer: true` writes. Null: there is none.
   */
  lastAnswer: { blocks: NodeJSON[]; origin: BlockOrigin; folderId: string | null } | null;
  /** The language the Answer is written in, which the model is told to ask the User in. */
  language: Language;
  /** The figure calculate recorded for a marker of this Answer ("[=2]"); null for none. */
  figure(marker: number): PlacedFigure | null;
  /**
   * The Mind this Answer wrote when first written, written again from every Document (#1149):
   * create_mind or add_to_mind puts its new text in place of what it wrote there, as one change,
   * rather than writing it a second time.
   */
  remake?: string | null;
  /**
   * Markdown as a Mind holds it: each Citation marker the Answer recorded a
   * Citation for, checked, each source written as a name in brackets the
   * Citation recorded for it, and its figures as their shown text, without
   * its sentences about the Answer's searching. Says how many of its
   * Citations weren't found, how many markers had no Citation, which sources
   * were written as text, and how many sentences it left out.
   */
  blocksOf(markdown: string): {
    blocks: NodeJSON[];
    cited: number;
    notFound: number;
    unrecorded: number;
    /** The first of `blocks` with a marker no Citation is recorded for yet; -1 for none. */
    firstUnrecorded: number;
    /** The sources written as a name in brackets, as written, before any was made a Citation. */
    sourcesAsText: string[];
    /** Sources written as a name in brackets that matched no recorded Citation, so left out. */
    droppedSources: number;
    /** Sources in its tables' cells written as a name in brackets that matched no recorded Citation. */
    unlinkedSources: number;
    /** Cells beyond its tables' columns, their text kept in the row's last cell. */
    extraCells: number;
    searchTalk: number;
  };
  /** The one paragraph the User's words name by its place (../../answers/paragraphAsked). */
  paragraph: ParagraphAsked;
  /** A call changed a Mind: its card says so, as soon as it does, also while it writes. */
  changed(toolCallId: string, change: MindChange): void;
  /** A call changed nothing, and whatever it wrote as its input came was taken back. */
  failed(toolCallId: string, problem: MindProblem): void;
  /** The Answer's: once it aborts, calls still writing stop. */
  signal: AbortSignal;
  now(): Date;
}

/**
 * A name as the User or the model may write it: no quotes or "@" around it,
 * nor the Markdown mark a heading or list item has in <mind> ("## Risks"),
 * spaces made alike.
 */
function bareName(name: string): string {
  return (
    name
      .trim()
      .replace(/^(?:@|#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s+)/, "")
      // Copied from <mind>: "[waiting change, adds: Results]".
      .replace(/^\[waiting change, (?:adds|removes): (.*?)\]?$/u, "$1")
      .replace(/\*\*|__/g, "")
      .replace(/^["'“‘「『《](.*)["'”’」』》]$/u, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const nameKey = (name: string): string => bareName(name).toLocaleLowerCase();

const SHOWN = 6;

const someOf = (items: readonly string[]) =>
  items.length > SHOWN
    ? `${items.slice(0, SHOWN).join(", ")} and ${items.length - SHOWN} more`
    : items.join(", ");

const citationNodesIn = (node: NodeJSON): NodeJSON[] =>
  node.type === CITATION_NODE ? [node] : (node.content ?? []).flatMap(citationNodesIn);

const listed = (minds: readonly ChangeableMind[]) =>
  minds
    .slice(0, 10)
    .map((mind) => `“${mind.name}”`)
    .join(", ");

/** Why a call changes nothing: what its card says (`problem`), and what the model reads (`message`). */
class Refusal extends Error {
  constructor(
    readonly problem: MindProblem,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The Mind a name means: the one so named, else the only one whose name
 * holds it; or why there is none, or several.
 */
function findMind(minds: readonly ChangeableMind[], name: string): ChangeableMind | Refusal {
  const key = nameKey(name);
  const exact = minds.find((mind) => nameKey(mind.name) === key);
  if (exact) return exact;
  const near = key === "" ? [] : minds.filter((mind) => nameKey(mind.name).includes(key));
  if (near.length === 1 && near[0]) return near[0];
  if (near.length > 1) {
    return new Refusal(
      { kind: "several", name },
      `Several Minds have “${name}” in their name: ${listed(near)}. Ask the User which one, and change nothing yet.`,
    );
  }
  return new Refusal(
    { kind: "not-found", name },
    minds.length === 0
      ? `The User has no Mind called “${name}”, nor any other. Nothing was changed.`
      : `The User has no Mind called “${name}”. Their most recent Minds: ${listed(minds)}. If none is meant, say so and change nothing.`,
  );
}

/** A Mind found, or the call fails, and the model reads why. */
function found(mind: ChangeableMind | Refusal): ChangeableMind {
  if (mind instanceof Refusal) throw mind;
  return mind;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} must be text.`);
  return value.trim();
};

const optional = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const idOf = (element: Y.XmlElement): string => {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof id === "string" ? id : "";
};

const levelOf = (element: Y.XmlElement): number => {
  const level = Number(element.getAttribute("level"));
  return Number.isInteger(level) && level > 0 ? level : 1;
};

const pathOf = (wanted: string): string[] =>
  wanted
    .split(/\s*[>›]\s*/)
    .map((part) => bareName(part.replace(/^["'“‘「『《]|["'”’」』》]$/gu, "")))
    .filter((part) => part !== "");

/** The headings a block is under, the nearest first, each higher than the last. */
function headingsAbove(order: readonly Y.XmlElement[], element: Y.XmlElement): Y.XmlElement[] {
  const above: Y.XmlElement[] = [];
  let level = isHeading(element) ? levelOf(element) : Number.POSITIVE_INFINITY;
  for (const each of order.slice(0, order.indexOf(element)).reverse()) {
    if (isHeading(each) && levelOf(each) < level) {
      above.push(each);
      level = levelOf(each);
    }
  }
  return above;
}

function isUnder(
  order: readonly Y.XmlElement[],
  element: Y.XmlElement,
  parents: readonly Set<Y.XmlElement>[],
) {
  const above = headingsAbove(order, element).reverse();
  let from = 0;
  for (const wanted of parents) {
    const at = above.findIndex((heading, index) => index >= from && wanted.has(heading));
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

/**
 * The blocks `wanted` names among `elements`, which are among `order`, the
 * Mind's blocks as they follow each other. A name that fits none whole may
 * say the headings its block is under, as in "Part 2 > Summary", to pick one
 * of several.
 */
function namedBlocks(
  elements: readonly Y.XmlElement[],
  order: readonly Y.XmlElement[],
  wanted: string,
): Y.XmlElement[] {
  const direct = named(elements, wanted);
  const path = pathOf(wanted);
  const name = path.pop() ?? "";
  if (direct.length > 0 || path.length === 0) return direct;
  const headings = order.filter((element) => isHeading(element));
  const parents = path.map((part) => new Set(named(headings, part)));
  return named(
    elements.filter((element) => isUnder(order, element, parents)),
    name,
  );
}

/**
 * What the model is told when a name fits several blocks: nothing was done,
 * and the User is asked which, in the words the dictionary gives for the
 * language the Answer is written in. Places are named by the heading each
 * is under, else by their number.
 */
function severalNamed(
  order: readonly Y.XmlElement[],
  matches: readonly Y.XmlElement[],
  wanted: string,
  field: "part" | "after",
  language: Language,
): string {
  const parents = matches.map((element) => {
    const parent = headingsAbove(order, element)[0];
    return parent ? plainText(parent).trim() : "";
  });
  const apart = !parents.includes("") && new Set(parents.map(nameKey)).size === parents.length;
  const places = matches
    .slice(0, 10)
    .map((_, index) =>
      apart
        ? translate(language, "assistant.place.under", { heading: parents[index] ?? "" })
        : translate(language, "assistant.place.number", { n: index + 1 }),
    );
  const headings = matches.every((element) => isHeading(element));
  const [first] = matches;
  const own = first ? plainText(first).trim() : "";
  const wholly = matches.every((element) => nameKey(plainText(element)) === nameKey(own));
  const name = headings && wholly ? own : (pathOf(wanted).pop() ?? "");
  const ask = translate(
    language,
    headings ? "assistant.several.headings" : "assistant.several.paragraphs",
    {
      count: matches.length,
      name,
      places: new Intl.ListFormat(language, { type: "conjunction" }).format(places),
    },
  );
  const then = apart
    ? `Once they say, name the block with the heading it is under, as in ${field}: "${parents[0]} > ${name}"`
    : `Only their places tell them apart, so ${field === "part" ? "have the User select the one they mean in the Mind" : "have the User name a paragraph in the one they mean"}`;
  return `“${name}” is the name of ${matches.length} ${headings ? "headings" : "paragraphs"}, and the User didn't say which. Ask them, in their language: "${ask}" ${then}`;
}

function named(elements: readonly Y.XmlElement[], wanted: string): Y.XmlElement[] {
  const key = nameKey(wanted);
  const keyed = elements.map((element) => ({ element, text: nameKey(plainText(element)) }));
  const whole = keyed.filter((each) => each.text === key);
  if (key === "") return whole.slice(0, 1).map((each) => each.element);
  return (whole.length > 0 ? whole : keyed.filter((each) => each.text.startsWith(key))).map(
    (each) => each.element,
  );
}

const isHeading = (element: Y.XmlElement | undefined) => element?.nodeName === "heading";

// Fewer than this could start several paragraphs.
const MIN_FIRST_WORDS = 3;
const MIN_FIRST_CJK = 6;

function paragraphNamed(
  elements: readonly Y.XmlElement[],
  wanted: string,
): Y.XmlElement | undefined {
  const key = nameKey(wanted);
  const count = countText(key);
  if (count.words < MIN_FIRST_WORDS && count.cjk < MIN_FIRST_CJK) return undefined;
  const found = elements.filter(
    (element) => !isHeading(element) && nameKey(plainText(element)).startsWith(key),
  );
  return found.length === 1 ? found[0] : undefined;
}

function paragraphAt(
  elements: readonly Y.XmlElement[],
  asked: ParagraphAsked,
): Y.XmlElement | undefined {
  if (asked === null) return undefined;
  const paragraphs = elements.filter(
    (element) => element.nodeName === "paragraph" && plainText(element).trim() !== "",
  );
  return asked === "last" ? paragraphs.at(-1) : paragraphs[asked];
}

/** The stretch of a Mind `edit_mind` changes, from one paragraph or heading to another. */
interface Stretch {
  from: TextPlace;
  to: TextPlace;
}

/**
 * The stretch of a Mind `edit_mind` changes, whole: the section under the
 * heading `part` (to the next heading as high or higher), else the Blocks the
 * User selected, else all of it; of that, only the paragraph the User named
 * by its place (`asked`, counted in the selection or the whole Mind). Why
 * not, when there is nothing there to change.
 */
function stretchOf(
  blocks: Y.XmlFragment,
  part: string | null,
  language: Language,
  selected: readonly string[],
  asked: ParagraphAsked,
): Stretch | { why: string; kind: "no-heading" | "no-text" | "several-places" } {
  const all = textBlocks(blocks).map((each) => each.element);
  let chosen = all;
  if (part !== null) {
    const headings = all.filter((element) => isHeading(element));
    const matches = namedBlocks(headings, all, part);
    if (matches.length > 1) {
      return { why: severalNamed(all, matches, part, "part", language), kind: "several-places" };
    }
    const heading = matches[0];
    if (heading) {
      const start = all.indexOf(heading);
      const level = levelOf(heading);
      const end = all.findIndex(
        (element, index) =>
          index > start && element.nodeName === "heading" && levelOf(element) <= level,
      );
      chosen = all.slice(start, end < 0 ? all.length : end);
    } else {
      // A start the model got wrong falls back to the paragraph the User named by its place.
      const paragraph = paragraphNamed(all, part) ?? paragraphAt(all, asked);
      if (!paragraph) {
        const count = countText(nameKey(part));
        const short = count.words < MIN_FIRST_WORDS && count.cjk < MIN_FIRST_CJK;
        return {
          why: short
            ? `there is no heading “${part}” in it, and to name a paragraph, give more of its first words: at least ${MIN_FIRST_WORDS} words or ${MIN_FIRST_CJK} Chinese characters`
            : `there is no heading or paragraph “${part}” in it`,
          kind: "no-heading",
        };
      }
      chosen = [paragraph];
    }
  } else if (selected.length > 0) {
    const ids = new Set(selected);
    const inSelection = (element: Y.XmlElement) => {
      for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
        if (ids.has(idOf(at))) return true;
      }
      return false;
    };
    const picked = all.filter(inSelection);
    if (picked.length > 0) chosen = picked;
  }
  if (chosen.length > 1) {
    // Rewritten with the paragraphs around it, the others would come back reworded.
    const paragraph = paragraphAt(part === null ? chosen : all, asked);
    if (paragraph && chosen.includes(paragraph)) chosen = [paragraph];
  }
  const first = chosen[0];
  const last = chosen.at(-1);
  if (!first || !last || chosen.every((element) => plainText(element).trim() === "")) {
    return { why: "there is no text in it to change", kind: "no-text" };
  }
  const size = layout(last).reduce((sum, child) => sum + child.size, 0);
  return { from: { blockId: idOf(first), offset: 0 }, to: { blockId: idOf(last), offset: size } };
}

/**
 * Where `add_to_mind` puts its Blocks: after the last top-level Block of the
 * section under the heading `after` names, or after the paragraph it names;
 * by that Block's id, or null for the end of the Mind. Why not, when it
 * names none or several.
 */
function placeAfter(
  blocks: Y.XmlFragment,
  after: string | null,
  language: Language,
): { after: string | null } | { why: string; kind: "no-place" | "several-places" } {
  if (after === null) return { after: null };
  const top = blocks.toArray().filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
  const headings = top.filter((element) => isHeading(element));
  const texts = top.filter((element) => isHeading(element) || element.nodeName === "paragraph");
  const byHeading = namedBlocks(headings, top, after);
  const matches = byHeading.length > 0 ? byHeading : namedBlocks(texts, top, after);
  if (matches.length > 1) {
    return { why: severalNamed(top, matches, after, "after", language), kind: "several-places" };
  }
  const found = matches[0];
  if (!found) {
    const names = headings.slice(0, 10).map((element) => `“${plainText(element)}”`);
    return {
      why: `there is no heading or paragraph “${after}” in it${names.length > 0 ? `; its headings are ${names.join(", ")}` : ""}`,
      kind: "no-place",
    };
  }
  if (!isHeading(found)) return { after: idOf(found) };
  const level = levelOf(found);
  let last = found;
  for (const element of top.slice(top.indexOf(found) + 1)) {
    if (isHeading(element) && levelOf(element) <= level) break;
    // A section's trailing empty lines stay after what is added.
    if (!(element.nodeName === "paragraph" && element.length === 0)) last = element;
  }
  return { after: idOf(last) };
}

/** How a text's length went, as the model is told: in words, or characters for Chinese and Japanese. */
function lengths(before: string, after: string): string {
  const was = countText(before);
  const now = countText(after);
  const unit = (count: ReturnType<typeof countText>) => (mostlyCjk(count) ? "characters" : "words");
  const from = countFor(was, "words");
  const to = countFor(now, "words");
  return unit(was) === unit(now)
    ? `from ${from} to ${to} ${unit(now)}`
    : `from ${from} ${unit(was)} to ${to} ${unit(now)}`;
}

const changes = (count: number) => (count === 1 ? "1 change" : `${count} changes`);

function tableNotes(change: MindChange, unmatchedMarkers = 0): string[] {
  const { tables = 0, unlinkedSources = 0, droppedSources = 0, extraCells = 0 } = change;
  return [
    ...(tables > 0
      ? [tables === 1 ? "One of them adds a table." : `${tables} of them add tables.`]
      : []),
    ...(unlinkedSources > 0
      ? [
          `${unlinkedSources === 1 ? "1 source in its table cells was" : `${unlinkedSources} sources in its table cells were`} written as a name in brackets that matched no Citation, so it stays as text, as the User sees under your reply. In a cell, cite with markers.`,
        ]
      : []),
    ...(droppedSources > 0
      ? [
          `${droppedSources === 1 ? "1 source was" : `${droppedSources} sources were`} written as a name in brackets that matched no Citation you recorded, so ${droppedSources === 1 ? "it was" : "they were"} left out, as the User sees under your reply.`,
        ]
      : []),
    ...(extraCells > 0
      ? [
          extraCells === 1
            ? "1 row had a cell beyond the table's columns: its text was kept in the row's last cell."
            : `Rows had ${extraCells} cells beyond the table's columns: their text was kept in each row's last cell.`,
        ]
      : []),
    ...(unmatchedMarkers > 0
      ? [
          `${unmatchedMarkers === 1 ? "1 marker" : `${unmatchedMarkers} markers`} matched none of the text's Citations and ${unmatchedMarkers === 1 ? "was" : "were"} left out: say so.`,
        ]
      : []),
  ];
}

const someTableNotes = ({
  unlinkedSources = 0,
  droppedSources = 0,
  extraCells,
}: {
  unlinkedSources?: number;
  droppedSources?: number;
  extraCells: number;
}) => ({
  ...(unlinkedSources > 0 && { unlinkedSources }),
  ...(droppedSources > 0 && { droppedSources }),
  ...(extraCells > 0 && { extraCells }),
});

function noTableMessage(name: string, said: string, text: string | null): string {
  // A rewrite's markers are the passage's Citations, which the reply can't give.
  const given =
    text === null
      ? "the text you wrote"
      : `this text, written again as you would an Answer: <text>${text.replace(/\s*\[\^?\d+\]/g, "")}</text>`;
  return [
    `Nothing was added to “${name}”: its table couldn't be made, as a table needs a heading row, a row of ---, and then each row on a line of its own.`,
    `Say so first, in these words: “${said}”`,
    `Then, below it, give ${given}, so the User still has it. Don't add it to a Mind another way.`,
  ].join(" ");
}

function unmadeTable(node: NodeJSON): boolean {
  if (node.type === "codeBlock") return false;
  if (node.type === "paragraph" || node.type === "heading") {
    const lines = (node.content ?? [])
      .map((child) => (child.type === "hardBreak" ? "\n" : (child.text ?? "")))
      .join("")
      .split("\n");
    return lines.some(looksLikeTable);
  }
  return (node.content ?? []).some(unmadeTable);
}

const WAITING =
  "They wait in the Mind for the User to accept or reject them; until then nothing of the User's text has changed.";
// The window that asked applies the change (#880, #1559), so the reply mustn't say it waits.
const APPLIES =
  "It applies in the Mind at once, with Undo. Reply in one short sentence saying what you did and where: don't repeat the new text, nor say that anything waits.";

const held = (name: string) =>
  `It would take out most of the User's own text in “${name}”, so it waits there for them to apply or discard; nothing of their text has changed yet. Say that it waits for them, not that it changed.`;

function waitingMessage(name: string, count: number, mixed: boolean): string {
  const how =
    "Make no other change for this request: don't add the text elsewhere or make a new Mind.";
  return mixed
    ? `Nothing was changed in “${name}”: the text you named holds the User's text and your own changes still waiting. To revise only your waiting text, call edit_mind again naming its section's heading in part. To change the User's text, the User needs to accept or reject the ${changes(count)} waiting first: if that is what they asked, say so first, in one sentence. ${how}`
    : `Nothing was changed in “${name}”: ${changes(count)} wait there for the User, and the text you asked to change holds some that you can't revise (the User's own requests, or someone's from a Word file). Say so first, in one sentence: the User needs to accept or reject them first, and Review under your reply shows them. ${how}`;
}

/** What `edit_mind`'s model reads of a result that proposed nothing, and what its card says. */
function notProposed(
  result: EditWithAiResult,
  mind: ChangeableMind,
  noTableSaid: string,
): Refusal | string {
  const { id: mindId, name } = mind;
  switch (result.kind) {
    case "unchanged":
      return `No change was needed in “${name}”: the text already does what was asked. Nothing was proposed.`;
    case "has-proposals":
      return new Refusal(
        { kind: "waiting", mindId, count: 0, mixed: false },
        `“${name}” has changes waiting there for the User. Nothing was proposed: they need to accept or reject those first.`,
      );
    case "too-long":
      return new Refusal(
        { kind: "too-long", mindId },
        `That is too much of “${name}” to change at once. Nothing was proposed: change one section at a time, naming its heading in part.`,
      );
    case "changed":
      return new Refusal(
        { kind: "changed", mindId },
        `That text of “${name}” changed while it was being read. Nothing was proposed.`,
      );
    case "local-mode":
      return new Refusal(
        { kind: "local-mode" },
        "“Keep everything on this computer” is on, and the model isn't on this computer. Nothing was proposed.",
      );
    case "not-ready":
      return new Refusal(
        { kind: "not-ready" },
        "The model can't be used now. Nothing was proposed.",
      );
    case "failed":
      return new Refusal(
        { kind: "model", mindId, message: result.error.message },
        `The change couldn't be made: ${result.error.message} Nothing was proposed.`,
      );
    case "cancelled":
      return new Refusal(
        { kind: "stopped", mindId },
        "The change was stopped. Nothing was proposed.",
      );
    case "no-table":
      return new Refusal(
        { kind: "no-table", mindId },
        noTableMessage(name, noTableSaid, result.text),
      );
    case "proposed":
      return "";
  }
}

const citedIn = ({ cited, unrecorded }: { cited: number; unrecorded: number }) => ({
  ...(cited > 0 && { cited }),
  ...(unrecorded > 0 && { unrecorded }),
});

const droppedSaid = (dropped: number) =>
  dropped > 0
    ? [
        `${dropped === 1 ? "1 Citation" : `${dropped} Citations`} would be removed with the words they belong to; the User sees that on the change: say so.`,
      ]
    : [];

interface Written {
  notFound: number;
  unrecorded: number;
  searchTalk: number;
  pointersBack: number;
  /** `ids` in the order of `blocks`. */
  blocks: { mindId: string; ids: readonly string[]; blocks: readonly NodeJSON[] };
}

const sentencesWord = (count: number) => (count === 1 ? "1 sentence" : `${count} sentences`);

function checkedNotes(checked: WrittenCheck | null): string[] {
  if (!checked) return [];
  const { cited, sent, checked: judged, failed, cut, unsupported, contradicted } = checked;
  const are = (count: number) => (count === 1 ? "is" : "are");
  return [
    ...(judged > 0
      ? [
          `Before it went in, ${sentencesWord(judged)} with Citations ${judged === 1 ? "was" : "were"} checked against them.`,
        ]
      : []),
    ...(cut.length > 0
      ? [
          `What their Citations don't support was taken out: ${cut.map((part) => `“${part}”`).join(", ")}. Don't state it in your reply.`,
        ]
      : []),
    ...(unsupported > 0
      ? [
          `${sentencesWord(unsupported)} ${are(unsupported)} still not supported by ${unsupported === 1 ? "its" : "their"} Citations, and marked so in the Mind: say so.`,
        ]
      : []),
    ...(contradicted > 0
      ? [
          `${sentencesWord(contradicted)} ${contradicted === 1 ? "contradicts" : "contradict"} a Document, and ${are(contradicted)} marked so in the Mind: say so.`,
        ]
      : []),
    ...(failed > 0
      ? [
          `${sentencesWord(failed)} couldn't be checked, and ${are(failed)} marked so in the Mind: say so.`,
        ]
      : []),
    ...(sent < cited
      ? [
          `Only the first ${sent} of its ${cited} sentences with Citations were checked; the rest are marked not checked in the Mind: say so.`,
        ]
      : []),
  ];
}

function writtenNotes({ notFound, unrecorded, searchTalk, pointersBack }: Written) {
  return [
    ...(notFound > 0
      ? [
          `${notFound === 1 ? "1 of their Citations" : `${notFound} of their Citations`} wasn't found in its source: say so.`,
        ]
      : []),
    ...(unrecorded > 0
      ? [
          `${unrecorded === 1 ? "1 marker has" : `${unrecorded} markers have`} no Citation recorded yet: record ${unrecorded === 1 ? "it" : "them"} with cite.`,
        ]
      : []),
    ...(searchTalk > 0
      ? [
          `${searchTalk === 1 ? "1 sentence" : `${searchTalk} sentences`} about your searching ${searchTalk === 1 ? "was" : "were"} left out of the Mind: say in your reply what isn't covered.`,
        ]
      : []),
    ...(pointersBack > 0
      ? [
          `${pointersBack === 1 ? "1 sentence that only pointed" : `${pointersBack} sentences that only pointed`} to an earlier Answer ${pointersBack === 1 ? "was" : "were"} left out: the Mind is read without this conversation, so if it needs what was pointed to, write that into it.`,
        ]
      : []),
  ];
}

function stretchText(blocks: Y.XmlFragment, { from, to }: Stretch): string {
  const all = textBlocks(blocks).map((each) => each.element);
  const first = all.findIndex((element) => idOf(element) === from.blockId);
  const last = all.findIndex((element) => idOf(element) === to.blockId);
  return all
    .slice(first, last + 1)
    .map((element) => plainText(element))
    .join("\n\n");
}

const textKey = (text: string) =>
  text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
// Two summaries may share a short line ("Not reported.", "The Passages found don't describe the
// methods."), or a long one under another heading: only long paragraphs in a row, already there
// under the same heading, are a second copy.
const COPY_WORDS = 8;
const COPY_CJK = 30;
const COPY_RUN = 2;

// Its words, and the pairs of Chinese characters in it: a summary rewritten longer keeps most of them.
const tokensOf = (text: string): Set<string> => {
  const key = textKey(text);
  const words = key.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words.flatMap((word) =>
      /\p{Script=Han}/u.test(word)
        ? [...word].slice(1).map((char, index) => `${word[index]}${char}`)
        : [word],
    ),
  );
};
const REPEATS = 0.6;

function repeats(earlier: string, next: string): boolean {
  const before = tokensOf(earlier);
  if (before.size === 0) return false;
  const after = tokensOf(next);
  let shared = 0;
  for (const token of before) if (after.has(token)) shared++;
  return shared / before.size >= REPEATS;
}

function longEnough(text: string): boolean {
  const count = countText(text);
  return count.words >= COPY_WORDS || count.cjk >= COPY_CJK;
}

function nodeText(node: NodeJSON): string {
  return node.text ?? (node.content ?? []).map(nodeText).join(" ");
}

function writtenBy(
  note: Y.XmlFragment,
  requests: ReadonlySet<string>,
  within?: readonly string[],
): { paragraphs: number; tables: number; charts: number } {
  const counts = { paragraphs: 0, tables: 0, charts: 0 };
  const visit = (element: Y.XmlElement, written: boolean) => {
    const proposal = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
    const ours = written || (proposal?.kind === "insert" && requests.has(proposal.request));
    if (ours && element.nodeName === "table") counts.tables++;
    else if (ours && element.nodeName === CHART_NODE) counts.charts++;
    else if (ours && element.nodeName === "paragraph") counts.paragraphs++;
    else {
      for (const child of element.toArray()) if (child instanceof Y.XmlElement) visit(child, ours);
    }
  };
  for (const block of note.toArray()) {
    if (block instanceof Y.XmlElement && (!within || within.includes(idOf(block)))) {
      visit(block, false);
    }
  }
  return counts;
}

/**
 * The Minds' Tools for one Answer in the assistant (see the module's
 * comment), and `settle`, to call once its Run is done: what they wrote
 * before `cite` gave their markers' records gets its Citations then.
 */
export function mindTools(options: MindToolsOptions): { tools: Tool[]; settle(): void } {
  const { minds, focused } = options;
  const ownRequests = new Set<string>();
  // A revision of text this Answer wrote takes its place: the Answer's card counts it once.
  const replacedOwn = (mindId: string, blockIds: readonly string[]) => {
    const counts = minds.read(mindId, (note) => writtenBy(note, ownRequests, blockIds));
    return counts.paragraphs + counts.tables + counts.charts > 0 ? { replacedOwn: counts } : {};
  };

  const askedIn = new Map<string, Set<string>>();
  /** What became of a call's change, for the model to say: applied, or waiting for the User and why. */
  const outcomeOf = (mind: ChangeableMind, request: string): string => {
    const doc = minds.read(mind.id, (note) => note.doc);
    if (!doc || !askedFor(doc, request)) return WAITING;
    const asked = askedIn.get(mind.id) ?? new Set<string>();
    asked.add(request);
    askedIn.set(mind.id, asked);
    return waitsForUser(doc, asked) ? held(mind.name) : APPLIES;
  };

  /** The Mind a call means: the one it names, else the one in focus; or why there is none. */
  const targetOf = (input: Record<string, unknown>): ChangeableMind | Refusal => {
    const all = minds.list();
    const inFocus = focused && all.find((mind) => mind.id === focused.mindId);
    const wanted = optional(input.mind);
    if (wanted !== null) {
      // Every Mind with no name reads "Untitled" to the model: that name means the one in focus.
      return inFocus && nameKey(inFocus.name) === nameKey(wanted) ? inFocus : findMind(all, wanted);
    }
    return (
      inFocus ??
      new Refusal(
        { kind: "no-mind" },
        "No Mind is open beside the assistant, and the User named none. Nothing was changed: say so, and that they can open a Mind, name one, or ask for a new Mind.",
      )
    );
  };

  /** What a call reads or writes: the Mind it means, or "" when it means none there is. */
  const effectOn =
    (action: "read" | "write") =>
    (input: Record<string, unknown>): Effect[] => {
      const mind = targetOf(input);
      return [{ action, scope: { kind: "mind", mindId: mind instanceof Refusal ? "" : mind.id } }];
    };

  const logPointersLeft = (left: number, mindId: string, toolCallId: string) => {
    if (left > 0) {
      console.info(
        `${left} Blocks pointing to an earlier Answer were written as they were into Mind ${mindId} (call ${toolCallId}): only a paragraph that is nothing but a pointer is left out.`,
      );
    }
  };

  /** A Tool whose refusals say on its card why nothing changed. */
  const reporting = (tool: Tool): Tool => ({
    ...tool,
    async call(input, context) {
      try {
        return await tool.call(input, context);
      } catch (error) {
        if (error instanceof Refusal) options.failed(context.toolCallId, error.problem);
        throw error;
      }
    },
  });

  /**
   * Where a call's Blocks go in a Mind: Proposals of one request, linked back
   * to the Answer, each written after the last (`writeMore`), from the place
   * the call named; a Checkpoint first, unless the call made the Mind.
   */
  interface Writer {
    mind: ChangeableMind;
    /** The `after` the call named, for telling a different place. */
    named: string | null;
    request: string;
    /** The top-level Block the next ones go after; null: the Mind's end. */
    anchor: string | null;
    /** How many of the call's Blocks are in. */
    written: number;
    /** The ids of those in, in order. */
    ids: string[];
    made: boolean;
    /** The Mind held nothing before it wrote: the empty Mind in front (#1559). */
    filled: boolean;
    origin: BlockOrigin;
  }

  const writerFor = (mind: ChangeableMind, after: string | null, made: boolean): Writer => {
    const place = minds.read(mind.id, (note) => placeAfter(note, after, options.language));
    if ("why" in place) {
      throw new Refusal(
        place.kind === "several-places"
          ? { kind: "several-places", mindId: mind.id, name: after ?? "", adding: true }
          : { kind: "no-place", mindId: mind.id, place: after ?? "" },
        `Nothing was added: ${place.why}. Don't add it to another Mind instead.`,
      );
    }
    const request = randomUUID();
    ownRequests.add(request);
    return {
      mind,
      named: after,
      request,
      anchor: place.after,
      written: 0,
      ids: [],
      made,
      filled: !made && minds.read(mind.id, holdsNothing),
      origin: options.origin,
    };
  };

  /** Writes those of `blocks` the writer hasn't yet, after the ones it has. */
  const writeMore = (writer: Writer, blocks: readonly NodeJSON[]): void => {
    const fresh = blocks.slice(writer.written);
    if (fresh.length === 0) return;
    const first = writer.written === 0;
    if (first && !writer.made) minds.checkpoint(writer.mind.id);
    minds.edit(writer.mind.id, (note) => {
      const anchor = note
        .toArray()
        .find(
          (each): each is Y.XmlElement =>
            each instanceof Y.XmlElement && writer.anchor !== null && idOf(each) === writer.anchor,
        );
      const ids = insertBlocks(note, fresh, { after: anchor ?? null, request: writer.request });
      writer.anchor = ids.at(-1) ?? writer.anchor;
      writer.ids.push(...ids);
      const doc = note.doc;
      if (!doc) return;
      setOrigins(doc, ids, writer.origin);
      if (first) {
        recordProposalRequest(doc, writer.request, {
          source: "answer-added",
          providerId: options.prepared.provider.id,
          modelId: options.prepared.modelId,
          createdAt: options.now().toISOString(),
          requested: "write",
        });
      }
    });
    writer.written = blocks.length;
  };

  /** What a request did in a Mind: how many of its changes wait there now. */
  const changeIn = (mindId: string, request: string, created: boolean): MindChange => {
    const { proposals, paragraphs, tables, charts } = minds.read(mindId, (note) => ({
      proposals: waitingChanges(note, (each) => each.request === request),
      ...writtenBy(note, new Set([request])),
    }));
    return {
      mindId,
      created,
      request,
      proposals,
      ...(paragraphs > 0 && { paragraphs }),
      ...(tables > 0 && { tables }),
      ...(charts > 0 && { charts }),
    };
  };

  const changeOf = (writer: Writer, created: boolean): MindChange => ({
    ...changeIn(writer.mind.id, writer.request, created),
    ...(writer.filled && { filled: true }),
  });

  const copyIn = (writer: Writer, blocks: readonly NodeJSON[]): string | null => {
    const there = minds.read(writer.mind.id, (note) => ownWaitingTexts(note, writer.request));
    // Before its first heading, new text goes into a section of the Mind's: any heading matches.
    const isThere = (section: string | null, text: string) =>
      there.some(
        (each) =>
          textKey(each.text) === textKey(text) &&
          (section === null || textKey(each.heading ?? "") === textKey(section)),
      );
    let section: string | null = null;
    let first: string | null = null;
    let run = 0;
    for (const block of blocks) {
      const text = nodeText(block);
      if (block.type === "heading") {
        section = text;
        run = 0;
      } else if (longEnough(text)) {
        run = isThere(section, text) ? run + 1 : 0;
        if (run === 1) first = section ?? text;
        if (run >= COPY_RUN) return first;
      }
    }
    return null;
  };

  // A new version of the assistant's own text goes in its place, not beside it (#1061).
  const besideIn = (writer: Writer, blocks: readonly NodeJSON[]): string | null => {
    const there = minds.read(writer.mind.id, (note) => ownAppliedTexts(note)).filter(longEnough);
    // A longer version is often split into paragraphs: the words of all of them count.
    const text = blocks
      .filter((block) => block.type !== "heading")
      .map(nodeText)
      .join(" ");
    return there.find((each) => repeats(each, text)) ?? null;
  };

  interface Repeat {
    text: string;
    kind: "waiting" | "applied";
  }

  const repeatIn = (writer: Writer, blocks: readonly NodeJSON[]): Repeat | null => {
    if (writer.made) return null;
    const copy = copyIn(writer, blocks);
    if (copy !== null) return { text: copy, kind: "waiting" };
    const beside = besideIn(writer, blocks);
    return beside === null ? null : { text: beside, kind: "applied" };
  };

  const repeatRefusal = (mind: ChangeableMind, repeat: Repeat) => {
    const shown = repeat.text.length > 80 ? `${repeat.text.slice(0, 80)}…` : repeat.text;
    return new Refusal(
      { kind: repeat.kind === "waiting" ? "copy" : "new-version", mindId: mind.id, text: shown },
      repeat.kind === "waiting"
        ? `Nothing was added to “${mind.name}”: “${shown}” is there already, as your own text still waiting. Revise it with edit_mind, naming its heading in part and giving its whole new text as content, instead of adding a second copy.`
        : `Nothing was added to “${mind.name}”: it is a new version of your own text there, “${shown}”. Change that text in place with edit_mind, naming its first words in part and giving its whole new text as content, instead of adding it again beside it.`,
    );
  };

  /** Takes back what a writer wrote: the call ended up meaning another Mind, or another place. */
  const withdraw = (writer: Writer): void => {
    if (writer.written === 0) return;
    minds.edit(writer.mind.id, (note) => {
      resolveProposals(note, (each) => each.request === writer.request, "reject");
    });
  };

  /**
   * Calls of `add_to_mind` and `create_mind` whose content is coming in as the
   * model writes it (`streamInput`), by id: each finished Block is written at
   * once, and "Writing…" stands where the next one goes. Null: the call can't
   * be written yet, or its input says nothing that streams.
   */
  const streams = new Map<
    string,
    {
      writer: Writer | null;
      created: boolean;
      breaks: number;
      copy: Repeat | null;
      /** It writes sources as text: nothing more goes in until all of it is in, as it may be refused. */
      uncited: boolean;
    }
  >();
  /**
   * Calls already made: input the engine still hands over after the call ran
   * (it reads the stream behind the call) writes nothing more.
   */
  const ended = new Set<string>();

  options.signal.addEventListener("abort", () => {
    for (const stream of streams.values()) {
      if (stream.writer) minds.writing(stream.writer.mind.id, null);
    }
    streams.clear();
  });

  /**
   * More of a call's content: the Blocks it has finished (all but the one
   * being written) go in. `open` gives the writer once the fields before the
   * content say where; null while they don't yet.
   */
  const streamContent = (
    toolCallId: string,
    text: string,
    open: (fields: ReturnType<typeof partialFields>) => { writer: Writer; created: boolean } | null,
  ): void => {
    if (options.signal.aborted || ended.has(toolCallId)) return;
    const fields = partialFields(text);
    const content = fields.get("content");
    if (!content) return;
    let stream = streams.get(toolCallId);
    if (!stream) {
      stream = { writer: null, created: false, breaks: 0, copy: null, uncited: false };
      streams.set(toolCallId, stream);
    }
    // Only once a paragraph has ended is there a Block more to write.
    const breaks = content.value.split("\n\n").length - 1;
    if (breaks === stream.breaks) return;
    stream.breaks = breaks;
    if (!stream.writer) {
      const opened = open(fields);
      if (!opened) return;
      stream.writer = opened.writer;
      stream.created = opened.created;
    }
    const { writer } = stream;
    if (stream.copy !== null || stream.uncited) return;
    const { blocks, firstUnrecorded, sourcesAsText } = options.blocksOf(content.value);
    if (!uncitedRefused && sourcesAsText.length > 0) {
      stream.uncited = true;
      return;
    }
    // `cite` may run after this call's input starts: a Block waits for its markers' records.
    const ready = blocks.slice(
      0,
      firstUnrecorded < 0 ? -1 : Math.min(firstUnrecorded, blocks.length - 1),
    );
    stream.copy = repeatIn(writer, ready);
    if (stream.copy !== null) {
      withdraw(writer);
      minds.writing(writer.mind.id, null);
      return;
    }
    const unmade = ready.findIndex(unmadeTable);
    writeMore(writer, unmade < 0 ? ready : ready.slice(0, unmade));
    minds.writing(writer.mind.id, { after: writer.anchor });
    if (writer.written > 0) options.changed(toolCallId, changeOf(writer, stream.created));
  };

  type Content = ReturnType<MindToolsOptions["blocksOf"]>;

  const answerContent = (blocks: NodeJSON[]): Content => {
    const citations = blocks.flatMap(citationNodesIn);
    const notFound = citations.filter((node) => node.attrs?.check === "not-found").length;
    return {
      blocks,
      cited: citations.length,
      notFound,
      unrecorded: 0,
      firstUnrecorded: -1,
      sourcesAsText: [],
      droppedSources: 0,
      unlinkedSources: 0,
      extraCells: 0,
      searchTalk: 0,
    };
  };

  // Refused once a Run, and only with a step left to try again: otherwise the text goes in, each
  // source made its Citation or left out. A marker with no Citation yet isn't refused: `cite` may
  // record it later in the same step.
  let uncitedRefused = false;

  const uncitedIn = (
    mind: ChangeableMind,
    { sourcesAsText }: Content,
    again: string,
    { answer, retry, made = false }: { answer: boolean; retry: boolean; made?: boolean },
  ): Refusal | null => {
    if (uncitedRefused || !retry || sourcesAsText.length === 0) return null;
    uncitedRefused = true;
    return new Refusal(
      { kind: "uncited", mindId: mind.id },
      [
        `${made ? `“${mind.name}” wasn't made` : `Nothing was written in “${mind.name}”`}: each source in content must be a marker like [^3], for a Citation you recorded with cite.`,
        `These sources are written as text instead: ${someOf(sourcesAsText.map((each) => `“${each}”`))}. A source in brackets is how IncarnaMind shows you a Citation, never a way to write one.`,
        `Record each source with cite, its Passage and exact words, searching first for one that isn't in this Answer's results. Then ${again} with the same text, each source replaced by its marker, as in “Rent is due on the 1st [^3].”`,
        ...(answer && options.lastAnswer
          ? [
              "To put your last Answer in as it is, with its Citations, give answer: true instead of content.",
            ]
          : []),
      ].join(" "),
    );
  };

  /**
   * A call of `add_to_mind` or `create_mind` with all its input: the rest of
   * its Blocks, after any written as it came, into `mind` after `after`; or
   * the last Answer's Blocks. Null: a table in it couldn't be made, and none
   * of it stays in the Mind.
   */
  const finishContent = (
    toolCallId: string,
    mind: ChangeableMind,
    after: string | null,
    given: string | NonNullable<MindToolsOptions["lastAnswer"]>,
    made: boolean,
    retry: boolean,
    chart: ChartAsked | null = null,
  ): (Written & { change: MindChange; charted: string | null }) | null => {
    const stream = streams.get(toolCallId);
    streams.delete(toolCallId);
    ended.add(toolCallId);
    const alone = withoutPointersBack(typeof given === "string" ? given : "");
    const markdown = typeof given === "string" ? alone.markdown : null;
    const content =
      typeof given === "string" ? options.blocksOf(alone.markdown) : answerContent(given.blocks);
    const { blocks, cited, notFound, unrecorded, searchTalk, ...notes } = content;
    let writer = stream?.writer ?? null;
    const unmade = blocks.some(unmadeTable);
    const again = made ? "call create_mind again" : "call add_to_mind again";
    const uncited = unmade ? null : uncitedIn(mind, content, again, { answer: true, retry, made });
    // What streamed in holds the pointers taken out of the whole text: it is written again.
    const streamedPointers = alone.removed > 0;
    if (
      writer &&
      (unmade ||
        uncited ||
        streamedPointers ||
        writer.mind.id !== mind.id ||
        writer.named !== after)
    ) {
      withdraw(writer);
      minds.writing(writer.mind.id, null);
      writer = null;
    }
    if (unmade) return null;
    if (uncited) throw uncited;
    writer ??= writerFor(mind, after, made);
    if (typeof given !== "string") writer.origin = given.origin;
    const copy = stream?.copy ?? repeatIn(writer, blocks);
    if (copy !== null) {
      withdraw(writer);
      minds.writing(writer.mind.id, null);
      throw repeatRefusal(mind, copy);
    }
    writeMore(writer, blocks);
    minds.writing(writer.mind.id, null);
    logPointersLeft(alone.left, writer.mind.id, toolCallId);
    // A chart drawn before `cite` records its table's markers would draw values with no Citation.
    const later = chart !== null && unrecorded > 0 && markdown !== null;
    const drawn = chart && !later ? drawChart(writer, blocks, chart, markdown) : null;
    // Markers `cite` may still record in this step count as left out only once the Run is done.
    const change = {
      ...changeOf(writer, made),
      ...citedIn({ cited, unrecorded: 0 }),
      ...someTableNotes(notes),
      ...(drawn?.problem && { chartNotDrawn: drawn.problem }),
    };
    options.changed(toolCallId, change);
    if (unrecorded > 0 && markdown !== null) {
      unsettled.set(toolCallId, {
        mindId: writer.mind.id,
        ids: writer.ids,
        markdown,
        change: () => changeOf(writer, made),
        sent: change,
        chart: later && chart ? (settled) => drawChart(writer, settled, chart, markdown) : null,
      });
    }
    const charted = later
      ? "IncarnaMind draws the chart from the table, right after it, once cite has recorded its Citations."
      : (drawn?.said ?? null);
    return {
      change,
      notFound,
      unrecorded,
      searchTalk,
      pointersBack: alone.removed,
      charted,
      blocks: { mindId: writer.mind.id, ids: writer.ids, blocks },
    };
  };

  const drawChart = (
    writer: Pick<Writer, "mind" | "request" | "origin" | "made"> & { ids: readonly string[] },
    blocks: readonly NodeJSON[],
    asked: ChartAsked,
    markdown: string | null,
  ): { said: string; problem?: ChartProblem } => {
    const at = blocks.findLastIndex((block) => block.type === "table");
    const table = blocks[at];
    const tableId = writer.ids[at];
    // A later call of the Answer may have revised the table away before `cite` recorded its markers.
    const there =
      tableId !== undefined &&
      minds.read(writer.mind.id, (note) =>
        topLevelBlocks(note).some((each) => idOf(each) === tableId),
      );
    if (!table || !tableId || !there) {
      return {
        problem: "noTable",
        said: "No chart was drawn: content holds no table. Say so in your reply; to chart figures, write them as a cited table with chart.",
      };
    }
    const calculated =
      markdown === null
        ? () => false
        : calculatedCells(markdown, (marker) => options.figure(marker));
    const drawn = chartOfTable(table, tableId, asked, options.language, calculated);
    if ("problem" in drawn) return { problem: drawn.problem, said: drawn.why };
    minds.edit(writer.mind.id, (note) => {
      const after = topLevelBlocks(note).find((each) => idOf(each) === tableId) ?? null;
      const ids = insertBlocks(note, [drawn.chart], { after, request: writer.request });
      const doc = note.doc;
      if (doc) setOrigins(doc, ids, writer.origin);
    });
    return { said: "IncarnaMind drew the chart from the table, right after it." };
  };

  const chartExisting = (toolCallId: string, mind: ChangeableMind, asked: ChartAsked): string => {
    const table = minds.read(mind.id, (note) => {
      const tables = topLevelBlocks(note).filter((each) => each.nodeName === "table");
      const selected = new Set(focused?.mindId === mind.id ? focused.blockIds : []);
      const picked =
        tables.find((each) => selected.has(idOf(each))) ??
        (tables.length === 1 ? tables[0] : undefined);
      return { picked: picked ? { id: idOf(picked), node: nodeOf(picked) } : null, tables };
    });
    if (!table.picked) {
      const several = table.tables.length > 1;
      throw new Refusal(
        { kind: "no-chart", mindId: mind.id, problem: several ? "several" : "noTable" },
        `No chart was drawn: “${mind.name}” has ${several ? "more than one table, and the User's cursor is in none" : "no table"}. Say so, and ask them to put the cursor in the table to chart.`,
      );
    }
    const drawn = chartOfTable(table.picked.node, table.picked.id, asked, options.language, null);
    if ("problem" in drawn) {
      throw new Refusal({ kind: "no-chart", mindId: mind.id, problem: drawn.problem }, drawn.why);
    }
    const writer = writerFor(mind, null, false);
    writer.anchor = table.picked.id;
    writeMore(writer, [drawn.chart]);
    const change = changeOf(writer, false);
    options.changed(toolCallId, change);
    const outcome = outcomeOf(mind, change.request);
    return `${outcome === APPLIES ? "Drew" : "Proposed"} a chart of the table in “${mind.name}”, right after it. ${outcome}`;
  };

  // The check marks the Citations of the tables it read: their charts, drawn before, would read
  // as made from another table.
  const redrawCharts = (mindId: string, tableIds: readonly string[]) =>
    minds.edit(mindId, (note) => {
      const blocks = topLevelBlocks(note);
      for (const element of blocks) {
        if (element.nodeName !== CHART_NODE) continue;
        const chart = readChart(element.getAttributes());
        const { source } = chart;
        if (source.kind !== "table" || !source.blockId || !tableIds.includes(source.blockId)) {
          continue;
        }
        const table = blocks.find((each) => idOf(each) === source.blockId);
        const fresh =
          table &&
          chartFromTable(gridOfTable(nodeOf(table)), {
            blockId: source.blockId,
            title: chart.title,
            language: options.language,
          });
        if (fresh && !sameChartData(fresh.data, chart.data)) {
          (element as unknown as Y.XmlElement<{ data: ChartData }>).setAttribute(
            "data",
            fresh.data,
          );
        }
      }
    });

  // Not while markers `cite` hadn't recorded are still to get their Citations: `settle` writes the Blocks again.
  const checkWritten = async (
    toolCallId: string,
    written: Written & { change: MindChange },
    signal: AbortSignal,
  ): Promise<WrittenCheck | null> => {
    const { mindId, ids, blocks } = written.blocks;
    if (written.unrecorded > 0 || ids.length !== blocks.length) return null;
    let reported = false;
    let checked: WrittenCheck | null = null;
    try {
      checked = await minds.checkWritten({
        mindId,
        blocks,
        ids,
        prepared: options.prepared,
        signal,
        checking: (count) => {
          reported = true;
          options.changed(toolCallId, { ...written.change, checking: count });
        },
        edit: (change) => minds.edit(mindId, change),
      });
    } catch (error) {
      // A check that fails never takes back what the call wrote: it stands, unchecked.
      console.error(
        `What the assistant wrote in Mind ${mindId} couldn't be checked before it landed:`,
        error,
      );
    }
    if (checked) {
      redrawCharts(mindId, ids);
      const { request, cited, sent, failed, stop, blocked } = checked;
      written.change = {
        ...written.change,
        selfCheck: {
          request,
          cited,
          sent,
          checked: checked.checked,
          failed,
          ...(stop && { stop }),
          ...(blocked && { blocked }),
        },
      };
    }
    if (reported || checked) options.changed(toolCallId, written.change);
    return checked;
  };

  /** By call: text written with markers `cite` hadn't recorded yet. */
  const unsettled = new Map<
    string,
    {
      mindId: string;
      ids: readonly string[];
      markdown: string;
      change(): MindChange;
      /** What the call's card said as it was written, its notes among it. */
      sent: MindChange;
      chart?: ((settled: readonly NodeJSON[]) => { problem?: ChartProblem }) | null;
    }
  >();

  const settle = (): void => {
    for (const [toolCallId, each] of unsettled) {
      const { blocks, cited, unrecorded, ...notes } = options.blocksOf(each.markdown);
      if (blocks.length !== each.ids.length) {
        console.warn(
          `Citations recorded after a Mind was written couldn't go in: the text reads as ${blocks.length} Blocks, ${each.ids.length} were written (Mind ${each.mindId}, call ${toolCallId}).`,
        );
        // Its chart would draw figures whose Citations never went in.
        if (each.chart) options.changed(toolCallId, { ...each.sent, chartNotDrawn: "uncited" });
        continue;
      }
      const there = minds.edit(each.mindId, (note) => {
        let found = 0;
        for (const element of topLevelBlocks(note)) {
          const at = each.ids.indexOf(idOf(element));
          const block = blocks[at];
          if (at < 0 || !block) continue;
          syncContent(element, block.content ?? []);
          found++;
        }
        return found;
      });
      const drawn = each.chart?.(blocks) ?? null;
      const charted = drawn !== null && !drawn.problem;
      // A later call revised some of what this one wrote: counted now, it would read as having
      // written less, or nothing. Its card keeps what it wrote, and the chart drawn now.
      const counts =
        there < each.ids.length
          ? {
              ...each.sent,
              ...(charted && {
                proposals: each.sent.proposals + 1,
                charts: (each.sent.charts ?? 0) + 1,
              }),
            }
          : each.change();
      options.changed(toolCallId, {
        ...counts,
        ...citedIn({ cited, unrecorded }),
        ...someTableNotes(notes),
        ...(drawn?.problem && { chartNotDrawn: drawn.problem }),
      });
    }
    unsettled.clear();
  };

  /** What the model reads of Blocks it added: how many, and what of their Citations didn't hold. */
  const added = (
    mind: ChangeableMind,
    written: NonNullable<ReturnType<typeof finishContent>>,
    where: string,
    checked: WrittenCheck | null,
  ): string => {
    const outcome = outcomeOf(mind, written.change.request);
    const blocks =
      written.change.proposals === 1 ? "1 new Block" : `${written.change.proposals} new Blocks`;
    return [
      `${outcome === APPLIES ? "Wrote" : "Proposed"} ${blocks} ${where}.`,
      ...tableNotes(written.change),
      outcome,
      ...writtenNotes(written),
      ...(written.charted ? [written.charted] : []),
      ...checkedNotes(checked),
    ].join(" ");
  };

  const mindProperty = {
    type: "string",
    description:
      "The Mind's name, as the User calls it. Leave it out for the Mind the User is in, the one in <mind>.",
  };

  const read: Tool = {
    name: MIND_TOOLS.read,
    description:
      "Read one of the User's Minds (their notes) by its name, to see what it holds before changing it or adding to it. The Mind the User is in is already in <mind>: don't read it again.",
    inputSchema: {
      type: "object",
      properties: { mind: { ...mindProperty, description: "The Mind's name." } },
      required: ["mind"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: MIND_TOOLS.read,
    effects: effectOn("read"),
    untrustedResult: false,
    async call(input, { readThirdParty }) {
      const mind = found(findMind(minds.list(), text(input.mind, "mind")));
      const read = minds.text(mind.id, mind.name, READ_TOKENS);
      for (const source of read.origins) readThirdParty?.(source);
      return read.text;
    },
  };

  const contentProperty = {
    type: "string",
    description:
      'The text, in Markdown, cited as an Answer is: each source a marker like [^1], for a Citation you recorded with cite before this call, right after the words it backs, in a table\'s cells too. Never write a source as text: "[Tides, p. 3]" is how IncarnaMind shows you a Citation, and content with one is refused. A new section starts with its heading. A table has a heading row, a row of ---, then each row on a line of its own. Write it last, after the other fields.',
  };

  // Offered only when there is one: a model may otherwise reach for it with none.
  const answerProperty = options.lastAnswer
    ? {
        answer: {
          type: "boolean",
          description:
            'true to put your last Answer in this conversation in as it is, with its Citations, instead of content: when the User asks to put that Answer ("it", "this") in a Mind, as "add this to my notes" does after a Question.',
        },
      }
    : {};

  const givenIn = (
    input: Record<string, unknown>,
  ): string | NonNullable<MindToolsOptions["lastAnswer"]> | null =>
    input.answer === true && options.lastAnswer ? options.lastAnswer : optional(input.content);

  const replacedOwnText = (mind: ChangeableMind, request: string, went: string): string => {
    const outcome = outcomeOf(mind, request);
    return `${outcome === APPLIES ? "Wrote" : "Proposed"} your new text in place of your own in “${mind.name}”${went}. ${outcome}`;
  };

  const editedText = (
    mind: ChangeableMind,
    request: string,
    proposals: number,
    went: string,
  ): string => {
    const outcome = outcomeOf(mind, request);
    // "Changed", never "Made": a reply that copies it would read as making a Mind (./claimedChanges).
    return `${outcome === APPLIES ? `Changed ${proposals === 1 ? "1 place" : `${proposals} places`}` : `Proposed ${changes(proposals)}`} in “${mind.name}”${went}. ${outcome}`;
  };

  const revisedText = (mind: ChangeableMind, change: MindChange, went: string): string => {
    const outcome = outcomeOf(mind, change.request);
    return outcome === WAITING
      ? `Revised your own waiting text in “${mind.name}”${went}: the old version of it is gone, and ${changes(change.proposals)} wait there in its place for the User to accept or reject. Nothing of the User's text changed.`
      : `Revised your own text in “${mind.name}”${went}: the old version of it is gone. ${outcome}`;
  };

  /**
   * `edit_mind` with new text: it takes the place of the assistant's own text over the
   * stretch, cited as an Answer is: its changes still waiting (`own`), revised in place, or
   * its text already in the Mind (`applied`), proposed to be replaced (#1061).
   */
  const writeOver = (
    toolCallId: string,
    mind: ChangeableMind,
    over: OwnWaiting | OwnApplied,
    markdown: string,
    retry: boolean,
    {
      again = "call edit_mind again",
      remade,
    }: {
      again?: string;
      // Written again from every Document (#1149): over words the User typed in since, it waits.
      remade?: { typedSince: boolean };
    } = {},
  ): Written & { change: MindChange; dropped: number } => {
    const alone = withoutPointersBack(markdown);
    const content = options.blocksOf(alone.markdown);
    const { blocks, cited, notFound, unrecorded, searchTalk, ...notes } = content;
    if (blocks.some(unmadeTable)) throw noTable(mind);
    logPointersLeft(alone.left, mind.id, toolCallId);
    const uncited = uncitedIn(mind, content, again, { answer: false, retry });
    if (uncited) throw uncited;
    const dropped = minds.read(mind.id, (note) => citationsDropped(note, over, blocks));
    const replaced = over.kind === "own" ? replacedOwn(mind.id, over.blockIds) : {};
    const request = randomUUID();
    ownRequests.add(request);
    minds.checkpoint(mind.id);
    const ids = minds.edit(mind.id, (note) => {
      const asked =
        over.kind === "own" ? ownAsked(note, over) : remade === undefined || !remade.typedSince;
      const revised = blocks.map(createElement);
      const written =
        over.kind === "own"
          ? replaceOwn(note, over, revised, request)
          : replaceApplied(note, over, revised, request);
      const doc = note.doc;
      if (!written || !doc) return written;
      setOrigins(doc, written, options.origin);
      recordProposalRequest(doc, request, {
        source: "answer-added",
        providerId: options.prepared.provider.id,
        modelId: options.prepared.modelId,
        createdAt: options.now().toISOString(),
        ...(asked && { requested: remade ? ("write" as const) : ("edit" as const) }),
      });
      return written;
    });
    if (!ids) {
      throw new Refusal(
        { kind: "changed", mindId: mind.id },
        `That text of “${mind.name}” changed while it was being read. Nothing was changed.`,
      );
    }
    const revision = (): MindChange => {
      const changed =
        over.kind === "applied"
          ? minds.read(mind.id, (note) => changedParagraphs(note, (ref) => ref.request === request))
          : 0;
      return {
        ...changeIn(mind.id, request, false),
        ...(over.kind === "own" && { revised: true, ...replaced }),
        ...(changed > 0 && { changed }),
      };
    };
    const change: MindChange = {
      ...revision(),
      ...citedIn({ cited, unrecorded: 0 }),
      ...someTableNotes(notes),
    };
    options.changed(toolCallId, change);
    if (unrecorded > 0) {
      unsettled.set(toolCallId, {
        mindId: mind.id,
        ids,
        markdown: alone.markdown,
        change: revision,
        sent: change,
      });
    }
    return {
      change,
      notFound,
      unrecorded,
      searchTalk,
      pointersBack: alone.removed,
      dropped,
      blocks: { mindId: mind.id, ids, blocks },
    };
  };

  const unmadeSaid = (name: string) =>
    translate(options.language, "assistant.table.unmade", { mind: name });

  const noTable = (mind: ChangeableMind) =>
    new Refusal(
      { kind: "no-table", mindId: mind.id },
      noTableMessage(mind.name, unmadeSaid(mind.name), null),
    );

  const refuseWaiting = (mind: ChangeableMind, waiting: { count: number; mixed: boolean }) =>
    new Refusal(
      { kind: "waiting", mindId: mind.id, ...waiting },
      waitingMessage(mind.name, waiting.count, waiting.mixed),
    );

  const edit: Tool = {
    name: MIND_TOOLS.edit,
    description:
      "Change text that is already in a Mind, as the User asks: shorten, lengthen, rewrite, restructure, correct, translate or reword it, or remove part of it. Say what to change in instruction, and the text is rewritten for you, its Citations kept. To change one paragraph and leave the others as they are, name its first words in part. The rewrite reads only that text: it can't search the Documents or cite anything new, so new facts from the Documents, a table of them too, go in with add_to_mind, cited. Text you proposed that still waits ([waiting change, adds: …]) is revised in place. For your own text, still waiting or in the Mind as you wrote it (an Answer added with Add to note), you may give its whole new text as content instead, cited as add_to_mind's, e.g. to make it longer with more from the Documents: it replaces that text, never adding a second copy. It applies in the Mind at once, with Undo, unless it would take out most of the User's own text, which then waits for them: the result says which.",
    inputSchema: {
      type: "object",
      properties: {
        mind: mindProperty,
        part: {
          type: "string",
          description:
            'The heading of the section to change, as written in the Mind, or the first words of the one paragraph to change. Whenever the User names a section, give its name here alone, also when the Mind has that heading more than once: you are then told how to ask the User which. Only when the User names the heading it is under ("the Summary under Part 2"), put that first: "Part 2 > Summary". Leave it out to change what the User selected, or else the whole Mind.',
        },
        instruction: {
          type: "string",
          description:
            'What to change, in the User\'s language, with anything from the conversation it needs, e.g. "Shorten to about 150 words, keeping every figure".',
        },
        content: {
          ...contentProperty,
          description:
            "Only for your own text, still waiting or in the Mind as you wrote it: its whole new text, in Markdown, from the section's heading on (it replaces the heading too), with markers like [^1] for Citations recorded with cite. Give it instead of instruction.",
        },
      },
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: MIND_TOOLS.edit,
    effects: effectOn("write"),
    untrustedResult: false,
    async call(input, { toolCallId, signal, canCallAgain }) {
      const markdown = optional(input.content);
      const instruction = markdown === null ? text(input.instruction, "instruction") : "";
      const mind = found(targetOf(input));
      const part = optional(input.part);
      // The selection counts only in the Mind it is in, and only when no section is named.
      const selected = focused?.mindId === mind.id && part === null ? focused.blockIds : [];
      // Text the assistant still waits on is revised as a whole, from its heading.
      const asked = markdown === null ? options.paragraph : null;
      const stretch = minds.read(mind.id, (blocks) =>
        stretchOf(blocks, part, options.language, selected, asked),
      );
      if ("why" in stretch) {
        throw new Refusal(
          stretch.kind === "no-heading"
            ? { kind: "no-heading", mindId: mind.id, heading: part ?? "" }
            : stretch.kind === "several-places"
              ? { kind: "several-places", mindId: mind.id, name: part ?? "", adding: false }
              : { kind: "no-text", mindId: mind.id },
          `Nothing was changed in “${mind.name}”: ${stretch.why}.`,
        );
      }
      const waiting = minds.read(mind.id, (blocks) => waitingIn(blocks, stretch.from, stretch.to));
      if (waiting.kind === "mixed" || waiting.kind === "other") {
        throw refuseWaiting(mind, { count: waiting.count, mixed: waiting.kind === "mixed" });
      }
      if (markdown !== null) {
        const over =
          waiting.kind === "own"
            ? waiting
            : minds.read(mind.id, (blocks) => ownAppliedIn(blocks, stretch.from, stretch.to));
        if (!over) {
          throw new Refusal(
            { kind: "content-not-own", mindId: mind.id },
            `Nothing was changed in “${mind.name}”: content only replaces your own text there, still waiting or as you wrote it. To change the User's text, give instruction instead.`,
          );
        }
        const before = minds.read(mind.id, (blocks) => stretchText(blocks, stretch));
        const written = writeOver(toolCallId, mind, over, markdown, canCallAgain?.() ?? true);
        const checked = await checkWritten(toolCallId, written, signal);
        const went = ` (${lengths(before, markdown)})`;
        return [
          over.kind === "own"
            ? revisedText(mind, written.change, went)
            : replacedOwnText(mind, written.change.request, went),
          ...tableNotes(written.change),
          ...writtenNotes(written),
          ...droppedSaid(written.dropped),
          ...checkedNotes(checked),
        ].join(" ");
      }
      const replaced = waiting.kind === "own" ? replacedOwn(mind.id, waiting.blockIds) : {};
      const { result, length, reason, revised } = await minds.proposeInMind({
        mindId: mind.id,
        ...stretch,
        instruction,
        prepared: (await options.rewriting?.()) ?? options.prepared,
        signal,
        beforeWriting: () => minds.checkpoint(mind.id),
        written: (request, proposals) =>
          options.changed(toolCallId, { mindId: mind.id, created: false, request, proposals }),
        requested: "edit",
      });
      if (result.kind !== "proposed") {
        const why = notProposed(result, mind, unmadeSaid(mind.name));
        if (typeof why === "string") return why;
        if (why.problem.kind === "waiting") {
          const now = minds.read(mind.id, (blocks) => waitingIn(blocks, stretch.from, stretch.to));
          throw refuseWaiting(mind, {
            count: now.kind === "none" || now.kind === "own" ? 0 : now.count,
            mixed: now.kind === "mixed",
          });
        }
        throw why;
      }
      ownRequests.add(result.request);
      const { tables, changed } = minds.read(mind.id, (note) => ({
        tables: writtenBy(note, new Set([result.request])).tables,
        changed: changedParagraphs(note, (ref) => ref.request === result.request),
      }));
      const notes = someTableNotes({
        unlinkedSources: result.unlinkedSources ?? 0,
        extraCells: result.extraCells ?? 0,
      });
      const change: MindChange = revised
        ? { ...changeIn(mind.id, result.request, false), revised: true, ...replaced, ...notes }
        : {
            mindId: mind.id,
            created: false,
            request: result.request,
            proposals: result.proposals,
            ...(changed > 0 && { changed }),
            ...(tables > 0 && { tables }),
            ...notes,
          };
      if (revised) {
        minds.edit(mind.id, (note) => {
          if (note.doc) setOrigins(note.doc, revised.blockIds, options.origin);
        });
      }
      options.changed(toolCallId, change);
      const went = length ? ` (${lengths(length.before, length.after)})` : "";
      return [
        revised
          ? revisedText(mind, change, went)
          : editedText(mind, result.request, result.proposals, went),
        ...tableNotes(change, result.unmatchedMarkers),
        ...(reason ? [`Why, as the rewrite says: ${reason}`] : []),
        ...droppedSaid(result.droppedCitations),
        ...(result.outOfDate > 0
          ? [
              `${result.outOfDate === 1 ? "1 change is" : `${result.outOfDate} changes are`} already out of date: the User changed that text meanwhile.`,
            ]
          : []),
      ].join(" ");
    },
  };

  const add: Tool = {
    name: MIND_TOOLS.add,
    description:
      "Add new text to a Mind: a section, a paragraph, a list or a table you write from the Documents or this conversation, or the piece of writing the User asked for, into the empty Mind in front. Cite it as an Answer: call cite first, then put its markers in content, in each table cell as in a paragraph. It applies in the Mind at once, with Undo. To change text already there, your own included, use edit_mind: never add a longer version of it beside it.",
    inputSchema: {
      type: "object",
      properties: {
        mind: mindProperty,
        after: {
          type: "string",
          description:
            'The heading of the section to add it at the end of, or the first words of the paragraph to add it after, as written in the Mind. Whenever the User names a place, give its name here alone, also when the Mind has it more than once: you are then told how to ask the User which. Only when the User names the heading it is under ("the Summary under Part 2"), put that first: "Part 2 > Summary". Leave it out to add it at the Mind\'s end.',
        },
        ...chartProperty,
        content: contentProperty,
        ...answerProperty,
      },
      required: options.lastAnswer ? [] : ["content"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: MIND_TOOLS.add,
    effects: effectOn("write"),
    untrustedResult: false,
    streamInput(toolCallId, input) {
      streamContent(toolCallId, input, (fields) => {
        // Only once the Mind and the place it names are whole: a name cut short could mean another.
        const named = fields.get("mind");
        const place = fields.get("after");
        if ((named && !named.done) || (place && !place.done)) return null;
        const mind = targetOf({ mind: named?.value });
        if (mind instanceof Refusal || remake === mind.id) return null;
        const after = optional(place?.value);
        // A place that can't be written to is the call's to report, once it has all of its input.
        const there = minds.read(mind.id, (note) => placeAfter(note, after, options.language));
        if ("why" in there) return null;
        return { writer: writerFor(mind, after, false), created: false };
      });
    },
    async call(input, { toolCallId, signal, canCallAgain }) {
      const asked = chartAsked(input.chart);
      if (asked && (input.content === undefined || input.content === "") && input.answer !== true) {
        return chartExisting(toolCallId, found(targetOf(input)), asked);
      }
      const given = givenIn(input) ?? text(input.content, "content");
      const mind = found(targetOf(input));
      if (remake === mind.id && typeof given === "string") {
        streams.delete(toolCallId);
        ended.add(toolCallId);
        const said = remade(
          toolCallId,
          mind,
          given,
          canCallAgain?.() ?? true,
          "call add_to_mind again",
          asked,
        );
        if (said !== null) return said;
      }
      const after = optional(input.after);
      const written = finishContent(
        toolCallId,
        mind,
        after,
        given,
        false,
        canCallAgain?.() ?? true,
        asked,
      );
      if (!written) throw noTable(mind);
      const checked = await checkWritten(toolCallId, written, signal);
      return added(
        mind,
        written,
        `in “${mind.name}”, ${after ? `after “${after}”` : "at its end"}`,
        checked,
      );
    },
  };

  // A model that began with a heading of its own keeps that one alone.
  const headed = (content: string) => /^\s*#{1,6}\s/.test(content);

  const make = (
    title: string,
    startsWithHeading: boolean,
    folderId = options.folderId,
  ): ChangeableMind => minds.create(title, folderId, !startsWithHeading);

  let remake = options.remake ?? null;
  const remade = (
    toolCallId: string,
    mind: ChangeableMind,
    markdown: string,
    retry: boolean,
    again: string,
    chart: ChartAsked | null,
  ): string | null => {
    const { anchor } = options.origin.from;
    if (anchor.kind !== "message") return null;
    // Its title heading stays unless the new text brings one of its own.
    const over = minds.read(mind.id, (blocks) =>
      writtenByAnswer(blocks, anchor.messageId, { heading: headed(markdown) }),
    );
    if (!over) return null;
    // Typed in since, the User's words aren't taken away at once: the new text waits, as #880 holds.
    const written = writeOver(toolCallId, mind, over.applied, markdown, retry, {
      again,
      remade: { typedSince: over.edited },
    });
    remake = null;
    const target = {
      mind,
      request: written.change.request,
      ids: written.blocks.ids,
      origin: options.origin,
      // Over text the User typed in, the request keeps the rule `writeOver` gave it.
      made: true,
    };
    const later = chart !== null && written.unrecorded > 0;
    const drawn =
      chart && !later ? drawChart(target, written.blocks.blocks, chart, markdown) : null;
    const settling = unsettled.get(toolCallId);
    if (later && chart && settling) {
      settling.chart = (settled) => drawChart(target, settled, chart, markdown);
    }
    if (drawn) {
      options.changed(toolCallId, {
        ...written.change,
        ...changeIn(mind.id, written.change.request, false),
        ...(drawn.problem && { chartNotDrawn: drawn.problem }),
      });
    }
    return [
      `Wrote the new text in place of the text you wrote for this request before, in “${mind.name}”.`,
      ...(drawn ? [drawn.said] : []),
      outcomeOf(mind, written.change.request),
      ...tableNotes(written.change),
      ...writtenNotes(written),
    ].join(" ");
  };

  const create: Tool = {
    name: MIND_TOOLS.create,
    description:
      "Make a new Mind (a note) for a piece of writing the User asked for (a summary, report, memo, notes, plan or letter) when no empty Mind is in front, or when they ask for a new note, page or document. Write its content as you would an Answer: call cite first, then put its markers in content. Leave content out for an empty Mind. It opens beside the User's Mind, its text applied at once, with Undo.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short title, from the User's words, in their language.",
        },
        ...chartProperty,
        content: contentProperty,
        ...answerProperty,
      },
      required: ["title"],
      additionalProperties: false,
    },
    provider: PROVIDER,
    providerTool: MIND_TOOLS.create,
    // The Mind it writes to isn't made yet.
    effects: () => [{ action: "write", scope: { kind: "mind", mindId: "" } }],
    untrustedResult: false,
    streamInput(toolCallId, input) {
      streamContent(toolCallId, input, (fields) => {
        const title = fields.get("title");
        if (remake !== null || !title?.done || title.value.trim() === "") return null;
        // Its first paragraph is whole by now, so whether the model began with a heading is known.
        const mind = make(title.value.trim(), headed(fields.get("content")?.value ?? ""));
        return { writer: writerFor(mind, null, true), created: true };
      });
    },
    async call(input, { toolCallId, signal, canCallAgain }) {
      const title = text(input.title, "title");
      const given = givenIn(input);
      const again = remake === null ? null : minds.list().find((mind) => mind.id === remake);
      if (again && typeof given === "string") {
        streams.delete(toolCallId);
        ended.add(toolCallId);
        const said = remade(
          toolCallId,
          again,
          given,
          canCallAgain?.() ?? true,
          "call create_mind again",
          chartAsked(input.chart),
        );
        if (said !== null) return said;
      }
      remake = null;
      // Made already, as its content came in.
      const streamed = streams.get(toolCallId)?.writer?.mind;
      // A Mind made of the last Answer goes where that Answer searched, not where this Question does.
      const folderId =
        given !== null && typeof given !== "string" ? given.folderId : options.folderId;
      const mind =
        streamed ??
        make(
          title,
          typeof given === "string" ? headed(given) : given?.blocks[0]?.type === "heading",
          folderId,
        );
      const folder = folderId === null ? null : minds.folderName(folderId);
      const made = `Made the Mind “${mind.name}”${folder ? ` in the Folder “${folder}”` : ""}, open beside the User's Mind`;
      const empty = () =>
        options.changed(toolCallId, { mindId: mind.id, created: true, request: "", proposals: 0 });
      if (given === null) {
        empty();
        return `${made}. It is empty.`;
      }
      let written: ReturnType<typeof finishContent>;
      try {
        written = finishContent(
          toolCallId,
          mind,
          null,
          given,
          true,
          canCallAgain?.() ?? true,
          chartAsked(input.chart),
        );
      } catch (error) {
        if (error instanceof Refusal && error.problem.kind === "uncited") minds.discard(mind.id);
        throw error;
      }
      if (!written) {
        empty();
        return `${made}. It is empty. ${noTable(mind).message}`;
      }
      const checked = await checkWritten(toolCallId, written, signal);
      return `${made}. ${added(mind, written, "in it", checked)}`;
    },
  };

  return { tools: [read, edit, add, create].map(reporting), settle };
}
