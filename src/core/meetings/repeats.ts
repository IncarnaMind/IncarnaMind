/**
 * What a Meeting's sections say again of the notes above them (#2306). A model asked to write each
 * fact once still writes one twice now and then: under a line of the User's and again as a
 * decision, an action or an open question. A section's bullet or paragraph goes when every
 * Transcript line it cites is cited by a retained unit holding the same complete wording. A
 * section with nothing but repeats is an invalid draft, not a reason to restore a duplicate.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { comparableSentence, sentenceSpans } from "../../shared/sentences";
import { CITATION_NODE } from "../api";
import { type FillSection, textOf } from "./fillPrompt";

/** The sections checked, in the order the model writes them; Said in the call lists them again on purpose. */
const CHECKED: readonly FillSection[] = ["decisions", "actions", "questions", "summary"];

interface Unit {
  /** The Transcript lines it cites: Document, time and speaker. */
  places: Set<string>;
  text: string;
  sentences: Set<string>;
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

const unitOf = (node: NodeJSON): Unit => {
  const text = comparableSentence(textOf(node));
  return {
    places: placesIn(node),
    text,
    sentences: new Set(
      sentenceSpans(text).map(({ from, to }) => comparableSentence(text.slice(from, to))),
    ),
  };
};

const isList = (block: NodeJSON) => block.type === "bulletList" || block.type === "orderedList";

function saidAbove(unit: Unit, above: readonly Unit[]): boolean {
  if (unit.places.size === 0 || unit.text === "") return false;
  return above.some(
    (each) =>
      (each.text === unit.text || each.sentences.has(unit.text)) &&
      [...unit.places].every((place) => each.places.has(place)),
  );
}

/** Literal repeats removed; null when a section would otherwise be empty. */
export function withoutRepeats(
  lineParts: readonly NodeJSON[],
  sections: ReadonlyMap<FillSection, NodeJSON[]>,
): Map<FillSection, NodeJSON[]> | null {
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
    if (left.length === 0) return null;
    kept.set(section, left);
    units.push(...written);
  }
  return kept;
}
