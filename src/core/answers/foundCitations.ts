/**
 * The Passages a check found for a sentence of an Answer, as Citations of that sentence in the
 * Answer's own number series: a look in the Answer's scope for a sentence that passed (#3020,
 * ./checks/answerLook), or the Answer's own judgement for a sentence its model left uncited (#3410,
 * ./checks/answerCheck). Each marker goes after the sentence's last one, or where an uncited
 * sentence's marker would go, and its card says a check found it. Pure.
 */
import { MARKER } from "../../shared/answerSentences";
import type { CitationAttributes, MarkedCitation } from "../api";

/** What a check found for one sentence. */
export type FoundForSentence = (
  | {
      /** The place of the sentence's last marker among the text's Citation markers, from 0. */
      after: number;
    }
  | {
      /** For a sentence with no marker: the offset in the text where its marker goes. */
      at: number;
    }
) & { passages: readonly CitationAttributes[] };

/** Where a found sentence's markers go: see `withFoundCitations`. */
interface Point {
  at: number;
  index: number;
  beside: number | null;
  passages: readonly CitationAttributes[];
}

/** Markers from here on are the app's own records of a Calculated figure's inputs. */
const OWN_SERIES_BELOW = 9000;

const samePassage = (a: MarkedCitation, b: CitationAttributes) =>
  a.passageId === b.passageId && a.quote === b.quote;

/**
 * The Answer with those Citations; null when none could be added. A Passage the Answer cites
 * elsewhere keeps its number there and here. `passedAt` places move with the markers added before
 * them, and each added marker passes where it stands: its sentence did.
 */
export function withFoundCitations(
  text: string,
  citations: readonly MarkedCitation[],
  found: readonly FoundForSentence[],
  judgedAt: string,
): { text: string; citations: MarkedCitation[] } | null {
  const places = [...text.matchAll(MARKER)].map((match) => ({
    marker: Number(match[1]),
    end: match.index + match[0].length,
  }));
  let next =
    Math.max(
      0,
      ...[...places, ...citations]
        .map((each) => each.marker)
        .filter((marker) => marker < OWN_SERIES_BELOW),
    ) + 1;
  const all = [...citations];
  /**
   * Where markers go: an offset in the text, the number of the text's markers before it (so the
   * places from there on move), and the marker the new ones follow among the Citations, if any.
   */
  const points = found.flatMap((each): Point[] => {
    if ("after" in each) {
      const place = places[each.after];
      return place
        ? [{ at: place.end, index: each.after + 1, beside: place.marker, passages: each.passages }]
        : [];
    }
    const index = places.filter((place) => place.end <= each.at).length;
    return [{ at: each.at, index, beside: null, passages: each.passages }];
  });
  /** By the offset they go at: the markers added there, in order, and how many markers are before it. */
  const added = new Map<number, { index: number; markers: number[] }>();
  for (const { at, index, beside, passages } of [...points].sort((a, b) => a.at - b.at)) {
    for (const passage of passages) {
      const { passageId, documentId, documentName, contentHash, quote } = passage;
      if (!passageId || !documentId || documentName === null || !contentHash || !quote) continue;
      const here = added.get(at)?.markers ?? [];
      const cited = all.find((each) => samePassage(each, passage));
      if (cited && here.includes(cited.marker)) continue;
      if (!cited && next >= OWN_SERIES_BELOW) continue;
      const marker = cited?.marker ?? next++;
      if (!cited) {
        const follows = here.at(-1) ?? beside;
        const slot = follows === null ? -1 : all.findIndex((each) => each.marker === follows);
        all.splice(slot === -1 ? all.length : slot + 1, 0, {
          passageId,
          documentId,
          documentName,
          contentHash,
          pageFrom: passage.pageFrom,
          pageTo: passage.pageTo,
          location: passage.location,
          quote,
          check: "found",
          checkReason: null,
          foundByCheck: true,
          marker,
          judgedAt,
        });
      }
      added.set(at, { index, markers: [...here, marker] });
    }
  }
  if (added.size === 0) return null;

  const inOrder = [...added].sort((a, b) => a[0] - b[0]);
  /** How many markers were added where the text's markers from `place` on move. */
  const movedBy = (place: number) =>
    inOrder.reduce((sum, [, point]) => sum + (point.index <= place ? point.markers.length : 0), 0);
  const passed = new Map<number, number[]>();
  let before = 0;
  for (const [, { index, markers }] of inOrder) {
    for (const [offset, marker] of markers.entries()) {
      passed.set(marker, [...(passed.get(marker) ?? []), index + before + offset]);
    }
    before += markers.length;
  }
  let marked = text;
  for (const [at, { markers }] of [...inOrder].reverse()) {
    marked = `${marked.slice(0, at)}${markers.map((marker) => `[^${marker}]`).join("")}${marked.slice(at)}`;
  }
  return {
    text: marked,
    citations: all.map((citation) => {
      const moved = (citation.passedAt ?? []).map((at) => at + movedBy(at));
      const places = [...new Set([...moved, ...(passed.get(citation.marker) ?? [])])];
      if (places.length === 0) return citation;
      return { ...citation, passedAt: places.sort((a, b) => a - b) };
    }),
  };
}
