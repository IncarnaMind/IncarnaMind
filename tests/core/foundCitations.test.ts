/**
 * The Passages a look in an Answer's scope found become Citations of their sentences in the
 * Answer's own number series (#3020): where each marker goes, which number it takes, and where
 * the ✓ of the Answer's other sentences stands afterwards.
 */
import { expect, test } from "vitest";
import type { CitationAttributes, MarkedCitation } from "../../src/core";
import { withFoundCitations } from "../../src/core/answers/foundCitations";

const AT = "2026-11-16T00:00:00.000Z";

const passage = (passageId: string, quote: string): CitationAttributes => ({
  passageId,
  documentId: `document-${passageId}`,
  documentName: `Document ${passageId}`,
  contentHash: `hash-${passageId}`,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const cited = (
  marker: number,
  passageId: string,
  quote: string,
  passedAt?: number[],
): MarkedCitation => ({
  passageId,
  documentId: `document-${passageId}`,
  documentName: `Document ${passageId}`,
  contentHash: `hash-${passageId}`,
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote,
  check: "found",
  checkReason: null,
  marker,
  ...(passedAt && { passedAt }),
});

const shown = (citations: readonly MarkedCitation[]) =>
  citations.map(({ marker, quote, foundByCheck, passedAt, judgedAt }) => ({
    marker,
    quote,
    foundByCheck: foundByCheck ?? null,
    passedAt: passedAt ?? null,
    judgedAt: judgedAt ?? null,
  }));

// protects=a found Passage's marker goes right after its sentence's last marker and takes the next free number, and the ✓ places of the sentences after it move by one so each ✓ stays on its own sentence, while a sentence before it keeps its place; fails_when=the marker lands in another sentence, reuses a number in use, or a later sentence's ✓ stays at its old place and so shows on the wrong Citation; no_claim=where in its sentence a marker would best stand, which is after its last Citation here.
test("a found Passage is cited after its sentence's last marker, and later ✓ places move with it", () => {
  const text = "First[^1]. Second[^2]. Third[^3][^1].";
  const citations = [cited(1, "a", "A", [0, 4]), cited(2, "b", "B", [1]), cited(3, "c", "C", [3])];

  const added = withFoundCitations(
    text,
    citations,
    [{ after: 1, passages: [passage("d", "D")] }],
    AT,
  );

  expect(added?.text).toBe("First[^1]. Second[^2][^4]. Third[^3][^1].");
  expect(shown(added?.citations ?? [])).toEqual([
    { marker: 1, quote: "A", foundByCheck: null, passedAt: [0, 5], judgedAt: null },
    { marker: 2, quote: "B", foundByCheck: null, passedAt: [1], judgedAt: null },
    { marker: 4, quote: "D", foundByCheck: true, passedAt: [2], judgedAt: AT },
    { marker: 3, quote: "C", foundByCheck: null, passedAt: [4], judgedAt: null },
  ]);
});

// protects=a Passage the judgement found for a sentence with no marker (#3410) is cited where that sentence's marker goes, takes the next free number, and the ✓ places of the markers after it move by one while those before it stay; fails_when=the marker lands after another sentence's, reuses a number, or a ✓ place points at the wrong Citation; no_claim=where in a sentence its marker goes, which the Answer's judgement reads from the sentence.
test("a found Passage for an uncited sentence is cited where its marker goes", () => {
  const text = "First[^1]. Second. Third[^2].";
  const citations = [cited(1, "a", "A", [0]), cited(2, "b", "B", [1])];

  const added = withFoundCitations(
    text,
    citations,
    [{ at: text.indexOf(". Third"), passages: [passage("c", "C")] }],
    AT,
  );

  expect(added?.text).toBe("First[^1]. Second[^3]. Third[^2].");
  expect(shown(added?.citations ?? [])).toEqual([
    { marker: 1, quote: "A", foundByCheck: null, passedAt: [0], judgedAt: null },
    { marker: 2, quote: "B", foundByCheck: null, passedAt: [2], judgedAt: null },
    { marker: 3, quote: "C", foundByCheck: true, passedAt: [1], judgedAt: AT },
  ]);
});

// protects=several Passages found for one sentence, and for two sentences, are each cited once in order, the numbers running on, and every added marker's ✓ stands where the marker is; fails_when=two found Passages share a number, come out of order, or a ✓ place points at another marker; no_claim=more than a handful of found Passages a sentence.
test("several found Passages, in two sentences, each get their own number and place", () => {
  const text = "One[^1]. Two[^2].";
  const citations = [cited(1, "a", "A"), cited(2, "b", "B")];

  const added = withFoundCitations(
    text,
    citations,
    [
      { after: 1, passages: [passage("e", "E")] },
      { after: 0, passages: [passage("c", "C"), passage("d", "D")] },
    ],
    AT,
  );

  expect(added?.text).toBe("One[^1][^3][^4]. Two[^2][^5].");
  expect(
    shown(added?.citations ?? []).map(({ marker, quote, passedAt }) => [marker, quote, passedAt]),
  ).toEqual([
    [1, "A", null],
    [3, "C", [1]],
    [4, "D", [2]],
    [2, "B", null],
    [5, "E", [4]],
  ]);
});

// protects=a found Passage the Answer already cites elsewhere keeps that Citation's number and its writer's mark: its marker is repeated at the sentence, nothing is added to the list, and it is not relabelled as found by a check; fails_when=the same Passage and quote gets a second number, or the writer's Citation is marked found by a check; no_claim=a Passage cited elsewhere with other words, which is another Citation.
test("a Passage the Answer cites elsewhere keeps its number", () => {
  const text = "One[^1]. Two[^2].";
  const citations = [cited(1, "a", "A", [0]), cited(2, "b", "B")];

  const added = withFoundCitations(
    text,
    citations,
    [{ after: 1, passages: [passage("a", "A")] }],
    AT,
  );

  expect(added?.text).toBe("One[^1]. Two[^2][^1].");
  expect(shown(added?.citations ?? [])).toEqual([
    { marker: 1, quote: "A", foundByCheck: null, passedAt: [0, 2], judgedAt: null },
    { marker: 2, quote: "B", foundByCheck: null, passedAt: null, judgedAt: null },
  ]);
});

// protects=the Answer's own numbers stay below the app's records of a Calculated figure's inputs (9000 on), whatever those are, and a found Passage with no Passage, Document or quote to point at adds nothing; fails_when=a found Citation takes a number from 9000 on, or a Citation with nothing to open is added; no_claim=an Answer with thousands of Citations.
test("numbers stay in the Answer's own series, and a Passage that can't be cited adds nothing", () => {
  const text = "One[^1]. Its figure[^9000].";
  const citations = [cited(1, "a", "A"), cited(9000, "f", "F")];

  const added = withFoundCitations(
    text,
    citations,
    [{ after: 0, passages: [passage("b", "B")] }],
    AT,
  );
  const none = withFoundCitations(
    text,
    citations,
    [
      { after: 0, passages: [{ ...passage("b", "B"), passageId: null }] },
      { after: 7, passages: [passage("c", "C")] },
    ],
    AT,
  );

  expect(added?.text).toBe("One[^1][^2]. Its figure[^9000].");
  expect(added?.citations.map((each) => each.marker)).toEqual([1, 2, 9000]);
  expect(none).toBeNull();
});
