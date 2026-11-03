/**
 * What a Meeting's sections say again of the notes above them (#2306). A model asked to write each
 * fact once still writes one twice now and then: under a line of the User's and again as a
 * decision, an action or an open question. A section's bullet or paragraph goes when every
 * Transcript line it cites is cited above it already (a line's part, or an earlier section in the
 * order the model writes them) and every word of it is there too, so a date, a figure or a name
 * the notes above don't have keeps its bullet. A section itself is never left out: when all of its
 * lines are repeats, its first stays, so the template's sections, and a heading the User typed,
 * are never empty.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { wordsOf } from "../answers/markerPlacement";
import { CITATION_NODE } from "../api";
import { type FillSection, textOf } from "./fillPrompt";

/** The sections checked, in the order the model writes them; Said in the call lists them again on purpose. */
const CHECKED: readonly FillSection[] = ["decisions", "actions", "questions", "summary"];

interface Unit {
  /** The Transcript lines it cites: Document, time and speaker. */
  places: Set<string>;
  words: Set<string>;
}

function placeOf(citation: NodeJSON): string {
  const attrs = citation.attrs ?? {};
  const location = attrs.location as { from?: number; speaker?: string } | null | undefined;
  return [attrs.documentId, location?.from ?? attrs.quote, location?.speaker ?? ""].join("|");
}

function placesIn(node: NodeJSON, found = new Set<string>()): Set<string> {
  if (node.type === CITATION_NODE) found.add(placeOf(node));
  for (const child of node.content ?? []) placesIn(child, found);
  return found;
}

/** "25th" is 25, "booked" is "book": the same fact in other words of the same root. */
const rootOf = (word: string) => {
  if (/^\d+(?:st|nd|rd|th)$/.test(word)) return word.replace(/\D+$/, "");
  return /^[a-z]{5,}$/.test(word) ? word.replace(/(?:ing|ed|es|s)$/, "") : word;
};

const unitOf = (node: NodeJSON): Unit => ({
  places: placesIn(node),
  words: new Set([...wordsOf(textOf(node))].map(rootOf)),
});

const isList = (block: NodeJSON) => block.type === "bulletList" || block.type === "orderedList";

function saidAbove(unit: Unit, above: readonly Unit[]): boolean {
  if (unit.places.size === 0 || unit.words.size === 0) return false;
  const beside = above.filter((each) => [...unit.places].some((place) => each.places.has(place)));
  const cited = new Set(beside.flatMap((each) => [...each.places]));
  if (![...unit.places].every((place) => cited.has(place))) return false;
  const words = new Set(beside.flatMap((each) => [...each.words]));
  return [...unit.words].every((word) => words.has(word));
}

/** The first bullet or paragraph of a section that would otherwise be left with nothing. */
function firstOf(blocks: readonly NodeJSON[]): NodeJSON[] {
  const block = blocks[0];
  if (!block) return [];
  if (!isList(block)) return [block];
  const item = (block.content ?? [])[0];
  return item ? [{ ...block, content: [item] }] : [];
}

/** `sections` without the bullets and paragraphs `lineParts`, or a section written before, say already; a section is never emptied. */
export function withoutRepeats(
  lineParts: readonly NodeJSON[],
  sections: ReadonlyMap<FillSection, NodeJSON[]>,
): Map<FillSection, NodeJSON[]> {
  const above = lineParts.flatMap((block) => (isList(block) ? (block.content ?? []) : [block]));
  const units = above.map(unitOf);
  const kept = new Map(sections);
  for (const section of CHECKED) {
    const blocks = sections.get(section);
    if (!blocks) continue;
    // A section's own bullets aren't weighed against each other: actions often cite one line.
    const written: Unit[] = [];
    const keep = (node: NodeJSON) => {
      const unit = unitOf(node);
      if (saidAbove(unit, units)) return false;
      written.push(unit);
      return true;
    };
    const left = blocks.flatMap((block) => {
      if (!isList(block)) return keep(block) ? [block] : [];
      const items = (block.content ?? []).filter(keep);
      return items.length > 0 ? [{ ...block, content: items }] : [];
    });
    if (left.length > 0) kept.set(section, left);
    else {
      const first = firstOf(blocks);
      if (first.length === 0) kept.delete(section);
      else {
        kept.set(section, first);
        written.push(...first.map(unitOf));
      }
    }
    units.push(...written);
  }
  return kept;
}
