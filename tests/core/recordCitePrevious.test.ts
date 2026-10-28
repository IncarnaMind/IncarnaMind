import { describe, expect, test } from "vitest";
import { scanRecordCites } from "../../src/core/recordCites/parser";
import { deriveRecordCiteHistory } from "../../src/core/recordCites/previous";
import type { RecordCiteDocument } from "../../src/core/recordCites/resolver";
import { resolveRecordCites } from "../../src/core/recordCites/resolver";
import type { RecordCiteSentence } from "../../src/shared/recordCiteChoices";

const sentence = (blockId: string, text: string): RecordCiteSentence => ({
  place: { blockId, from: 0 },
  text,
});

const source = (id: string, name: string, page: number): RecordCiteDocument => ({
  id,
  name,
  contentHash: `${id}-hash`,
  units: [{ page, kind: "page", label: { printed: String(page) }, text: `${name} passage` }],
});

const ecf = source("ecf", "ECF No. 41.pdf", 3);
const exhibit = source("exhibit", "Exhibit 7.pdf", 3);
const docket = source("docket", "Dkt. 41.pdf", 2);
const documents = [ecf, exhibit];
const current = { blockId: "next", from: 0 };
const currentClaim = "Id. at 4 states more.";

const previousOf = (sentences: RecordCiteSentence[], claim = currentClaim) =>
  deriveRecordCiteHistory(sentences, current, claim, documents, {}).previous?.documentId;

describe("the immediately preceding record item derived from Note text", () => {
  test("is the last resolved cite within its own sentence", () => {
    const sentences = [
      sentence("before", "ECF No. 41 at 3 and Ex. 7 at 3 state the record."),
      sentence("next", currentClaim),
    ];
    expect(previousOf(sentences)).toBe("exhibit");
  });

  test("an appended unresolved or ambiguous cite clears it without a recheck", () => {
    const sentences = [
      sentence("before", "Ex. 7 at 3 states it, and Dkt. 41 at 2 adds more."),
      sentence("next", currentClaim),
    ];
    expect(previousOf(sentences)).toBeUndefined();
    expect(
      deriveRecordCiteHistory(
        [sentence("ambiguous", "Dkt. 41 at 2 is ambiguous."), sentence("next", currentClaim)],
        current,
        currentClaim,
        [source("ecf-copy", "ECF No. 41.pdf", 2), docket],
        {},
      ).previous,
    ).toBeNull();
  });

  test("a proposed write supplies reading order even before the first check succeeds", () => {
    const sentences = [
      sentence("new-a", "ECF No. 41 at 3 states the deadline."),
      sentence("new-b", currentClaim),
    ];
    expect(previousOf(sentences)).toBe("ecf");
  });

  test("a newly assigned proposed Block id falls back to the exact current claim", () => {
    const sentences = [
      sentence("assigned-a", "ECF No. 41 at 3 states the deadline."),
      sentence("assigned-b", currentClaim),
    ];
    expect(previousOf(sentences)).toBe("ecf");
  });

  test("duplicate proposed claims never borrow an occurrence's position", () => {
    const repeated = "Id. at 2 states another deadline.";
    const sentences = [
      sentence("source", "ECF No. 41 at 3 states the deadline."),
      sentence("repeat-a", repeated),
      sentence("repeat-b", repeated),
    ];
    expect(
      deriveRecordCiteHistory(
        sentences,
        { blockId: "proposed-container", from: 0 },
        repeated,
        documents,
        {},
      ).previous,
    ).toBeNull();
  });

  test("an item cannot refer to itself or a later source", () => {
    const sentences = [
      sentence("first", "Id. at 2 has no source."),
      sentence("next", "Ex. 7 at 3 states it."),
    ];
    expect(previousOf(sentences, "Id. at 2 has no source.")).toBeUndefined();
  });

  test("named supra keeps its source across intervening cite-bearing sentences", () => {
    const raw = "ECF No. 41, supra";
    const derived = deriveRecordCiteHistory(
      [
        sentence("smith", "ECF No. 41 at 3 states it."),
        sentence("exhibit", "Ex. 7 at 3 states something else."),
        sentence("next", raw),
      ],
      current,
      raw,
      documents,
      {},
    );
    const result = resolveRecordCites({
      cites: scanRecordCites(raw, { hasPrevious: true }).map((occurrence) => ({
        ...occurrence.result,
        raw: occurrence.raw,
        from: occurrence.from,
        to: occurrence.to,
      })),
      documents,
      choices: { previous: derived.previous, choices: {} },
      history: derived.history,
    });
    expect(result[0]).toMatchObject({ outcome: "found", documentId: "ecf" });
  });

  test("an unresolved item clears Id. but not named supra history", () => {
    const raw = "ECF No. 41, supra";
    const derived = deriveRecordCiteHistory(
      [
        sentence("source", "ECF No. 41 at 3 states it."),
        sentence("unresolved", "Dkt. 99 at 2 cannot be placed."),
        sentence("next", raw),
      ],
      current,
      raw,
      documents,
      {},
    );
    expect(derived.previous).toBeNull();
    expect(derived.history.map((item) => item.document.id)).toEqual(["ecf"]);
    const resolve = (text: string) =>
      resolveRecordCites({
        cites: scanRecordCites(text, { hasPrevious: true }).map((occurrence) => ({
          ...occurrence.result,
          raw: occurrence.raw,
          from: occurrence.from,
          to: occurrence.to,
        })),
        documents,
        choices: { previous: derived.previous, choices: {} },
        history: derived.history,
      });
    expect(resolve(raw)[0]).toMatchObject({ outcome: "found", documentId: "ecf" });
    expect(resolve("Id. at 3")[0]).toMatchObject({ outcome: "not-found" });
  });

  test("a case citation ends the record chain", () => {
    const sentences = [
      sentence("source", "ECF No. 41 at 3 states the deadline."),
      sentence("case", "Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."),
      sentence("next", currentClaim),
    ];
    expect(previousOf(sentences)).toBeUndefined();
  });
});
