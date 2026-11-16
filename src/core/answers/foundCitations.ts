/**
 * The Passages a look in an Answer's scope found for a sentence that passed (./checks/answerLook),
 * as Citations of that sentence in the Answer's own number series (#3020): each marker goes after
 * the sentence's last one, and its card says a check found it. Pure.
 */
import { MARKER } from "../../shared/answerSentences";
import type { CitationAttributes, MarkedCitation } from "../api";

/** What a look found for one sentence. */
export interface FoundForSentence {
  /** The place of the sentence's last marker among the text's Citation markers, from 0. */
  after: number;
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
  /** By the place they go after: the markers added there, in order. */
  const added = new Map<number, number[]>();
  for (const { after, passages } of [...found].sort((a, b) => a.after - b.after)) {
    const place = places[after];
    if (!place) continue;
    for (const passage of passages) {
      const { passageId, documentId, documentName, contentHash, quote } = passage;
      if (!passageId || !documentId || documentName === null || !contentHash || !quote) continue;
      const here = added.get(after) ?? [];
      const cited = all.find((each) => samePassage(each, passage));
      if (cited && here.includes(cited.marker)) continue;
      if (!cited && next >= OWN_SERIES_BELOW) continue;
      const marker = cited?.marker ?? next++;
      if (!cited) {
        const beside = all.findIndex((each) => each.marker === (here.at(-1) ?? place.marker));
        all.splice(beside === -1 ? all.length : beside + 1, 0, {
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
      added.set(after, [...here, marker]);
    }
  }
  if (added.size === 0) return null;

  /** How many markers were added before the place `at` held. */
  const movedBy = (at: number) =>
    [...added].reduce((sum, [after, markers]) => sum + (after < at ? markers.length : 0), 0);
  const passed = new Map<number, number[]>();
  for (const [after, markers] of added) {
    for (const [index, marker] of markers.entries()) {
      passed.set(marker, [...(passed.get(marker) ?? []), after + movedBy(after) + 1 + index]);
    }
  }
  let marked = text;
  for (const [after, markers] of [...added].sort((a, b) => b[0] - a[0])) {
    const end = places[after]?.end ?? marked.length;
    marked = `${marked.slice(0, end)}${markers.map((marker) => `[^${marker}]`).join("")}${marked.slice(end)}`;
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
