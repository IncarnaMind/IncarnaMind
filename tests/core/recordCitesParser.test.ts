import { describe, expect, test } from "vitest";
import type { CitationLocation } from "../../src/core/api";
import { parseRecordCite, scanRecordCites } from "../../src/core/recordCites/parser";
import { ACCEPTED_RECORD_CITE_FIXTURES as ACCEPTED_FIXTURES } from "../helpers/recordCites";

const previous = { hasPrevious: true } as const;
const page = (from: number, to = from): CitationLocation => ({ kind: "page", from, to });
const depositionLocation = (
  from: number,
  to: number,
  lineFrom: number,
  lineTo: number,
): CitationLocation => ({
  kind: "page",
  from,
  to,
  printed: { from: String(from), to: String(to) },
  lines: { from: lineFrom, to: lineTo },
});
const paragraphLocation = (from: number, to = from): CitationLocation => ({
  kind: "section",
  heading: null,
  paragraphs: { from, to },
});
describe("record-cite fixtures", () => {
  test("has ten examples of every required shape", () => {
    const shapes = new Set(ACCEPTED_FIXTURES.map((fixture) => fixture.shape));
    expect(shapes.size).toBe(16);
    for (const shape of shapes) {
      expect(ACCEPTED_FIXTURES.filter((fixture) => fixture.shape === shape)).toHaveLength(10);
    }
  });

  test.each(ACCEPTED_FIXTURES)("$shape: $raw", (fixture) => {
    const result = parseRecordCite(fixture.raw, fixture.options);
    expect(result).toEqual({
      status: "parsed",
      raw: fixture.raw,
      kind: fixture.kind,
      sourceAlias: fixture.sourceAlias,
      location: fixture.location,
      bates: fixture.bates,
      reference: fixture.reference,
    });
    expect(structuredClone(result)).toEqual(result);
  });
});

describe("record-cite variants", () => {
  test.each(["Smith Dep. 45:3-12", "Smith Dep. 45:3–12"])(
    "reads deposition dashes in %s",
    (raw) => {
      expect(parseRecordCite(raw)).toMatchObject({
        status: "parsed",
        location: depositionLocation(45, 45, 3, 12),
      });
    },
  );

  test.each(["DEF 0045-0049", "DEF 0045–0049"])("reads Bates dashes in %s", (raw) => {
    expect(parseRecordCite(raw)).toMatchObject({
      status: "parsed",
      bates: { prefix: "DEF", from: "0045", to: "0049" },
    });
  });

  test.each([
    ["  sMiTh   dEp.   45 : 3 – 12  ", "smith dep", depositionLocation(45, 45, 3, 12)],
    ["  pL.’s   eX. 7, P. 3  ", "pl's ex 7", page(3)],
    ["  EcF nO. 41 At 5  ", "ecf no 41", page(5)],
    ["  cOmPl. ¶ 14  ", "compl", paragraphLocation(14)],
  ])("normalizes whitespace and case in %s", (raw, sourceAlias, location) => {
    const result = parseRecordCite(raw);
    expect(result).toMatchObject({ status: "parsed", raw, sourceAlias, location });
  });

  test("keeps exact first and last printed lines across a page break", () => {
    expect(parseRecordCite("Dep. Tr. 45:24–46:2")).toMatchObject({
      status: "parsed",
      kind: "deposition",
      location: {
        kind: "page",
        from: 45,
        to: 46,
        printed: { from: "45", to: "46" },
        lines: { from: 24, to: 2 },
      },
    });
  });

  test("preserves printed page labels separately from physical Unit numbers", () => {
    expect(parseRecordCite("Dep. Tr. 0045:3–0046:2")).toMatchObject({
      status: "parsed",
      location: {
        kind: "page",
        from: 45,
        to: 46,
        printed: { from: "0045", to: "0046" },
        lines: { from: 3, to: 2 },
      },
    });
  });

  test("uses section paragraphs rather than text lines", () => {
    const result = parseRecordCite("Smith Decl. ¶¶ 3–5");
    expect(result).toMatchObject({
      status: "parsed",
      location: { kind: "section", heading: null, paragraphs: { from: 3, to: 5 } },
    });
    expect(result.status === "parsed" && result.location).not.toHaveProperty("lines");
  });

  test("keeps the existing transcript-time range normalization", () => {
    expect(parseRecordCite("14:26–12:20")).toMatchObject({
      status: "parsed",
      location: { kind: "time", from: 740_000, to: 866_000 },
    });
  });

  test.each(["Id.", "Id. at 7", "supra"])("reports no earlier referent for %s", (raw) => {
    expect(parseRecordCite(raw)).toEqual({ status: "error", raw, reason: "no-earlier-referent" });
    expect(parseRecordCite(raw, { hasPrevious: false })).toEqual({
      status: "error",
      raw,
      reason: "no-earlier-referent",
    });
  });
});

describe("invalid record cites", () => {
  test.each([
    "",
    "   ",
    "not a cite",
    "Smith Dep.",
    "Smith Dep. 45",
    "Smith Dep. 45:",
    "Ex. 7",
    "ECF No. 41",
    "PL-",
    "DEF 0045–",
    "Compl. ¶",
    "Id. at",
    "supra at 7",
    "12:3",
  ])("returns malformed for %s", (raw) => {
    expect(parseRecordCite(raw, previous)).toEqual({ status: "error", raw, reason: "malformed" });
  });

  test.each([
    "Smith Dep. 0:3–12",
    "Smith Dep. 45:0–12",
    "Smith Dep. 45:12–3",
    "Smith Dep. 46:3–45:2",
    "Smith Dep. 99999999999999999999:3–12",
    "Ex. 7 at 0",
    "Dkt. 41 at 0",
    "Compl. ¶ 0",
    "Smith Decl. ¶¶ 5–3",
    "DEF 0049–0045",
    "14:60",
    "1:60:00",
  ])("returns out-of-range for %s", (raw) => {
    expect(parseRecordCite(raw, previous)).toEqual({
      status: "error",
      raw,
      reason: "out-of-range",
    });
  });

  test("returns out-of-range for Id. at page zero even with a referent", () => {
    expect(parseRecordCite("Id. at 0", previous)).toEqual({
      status: "error",
      raw: "Id. at 0",
      reason: "out-of-range",
    });
  });
});

describe("record-cite scanning", () => {
  test("keeps repeated raw cites as separate occurrences with their own ranges", () => {
    const raw = "Smith Dep. 45:3–12";
    const text = `${raw}, then ${raw}.`;
    const occurrences = scanRecordCites(text);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((occurrence) => occurrence.raw)).toEqual([raw, raw]);
    expect(occurrences[0]).not.toBe(occurrences[1]);
    expect(occurrences[0]).toMatchObject({ from: 0, to: raw.length, referent: null });
    const secondFrom = text.indexOf(raw, raw.length);
    expect(occurrences[1]).toMatchObject({
      from: secondFrom,
      to: secondFrom + raw.length,
      referent: null,
    });
    for (const occurrence of occurrences) {
      expect(text.slice(occurrence.from, occurrence.to)).toBe(occurrence.raw);
      expect(occurrence.result.raw).toBe(occurrence.raw);
    }
  });

  test("finds several shapes in one sentence in reading order", () => {
    const raws = [
      "Smith Dep. 45:3–12",
      "Ex. 7 at 3",
      "ECF No. 41 at 5",
      "Compl. ¶ 14",
      "DEF 0045–0049",
      "14:26",
    ];
    const occurrences = scanRecordCites(`${raws.join(", ")}.`);

    expect(occurrences.map((occurrence) => occurrence.raw)).toEqual(raws);
    expect(occurrences.map((occurrence) => occurrence.result)).toEqual(
      raws.map((raw) => parseRecordCite(raw)),
    );
    for (const occurrence of occurrences) {
      expect(occurrence.to - occurrence.from).toBe(occurrence.raw.length);
    }
  });

  test("uses UTF-16 offsets after Unicode and Chinese text", () => {
    const prefix = "证据 😀：";
    const deposition = "Smith Dep. 45:3–12";
    const exhibit = "Pl.'s Ex. 7, p. 3";
    const text = `${prefix}${deposition}，然后 ${exhibit}`;
    const occurrences = scanRecordCites(text);

    expect(prefix).toHaveLength(6);
    expect(occurrences.map((occurrence) => occurrence.raw)).toEqual([deposition, exhibit]);
    expect(occurrences[0]).toMatchObject({ from: 6, to: 6 + deposition.length });
    const exhibitFrom = text.indexOf(exhibit);
    expect(occurrences[1]).toMatchObject({
      from: exhibitFrom,
      to: exhibitFrom + exhibit.length,
    });
  });

  test("links Id. and supra only to the nearest preceding resolvable occurrence", () => {
    const repeated = "Smith Dep. 45:3–12";
    const text = `Id.; supra; ${repeated}; Ex. 7 at 3; ${repeated}; Id.; supra`;
    const occurrences = scanRecordCites(text);

    expect(occurrences.map((occurrence) => occurrence.referent)).toEqual([
      null,
      null,
      null,
      null,
      null,
      4,
      5,
    ]);
    expect(occurrences[0]?.result).toEqual({
      status: "error",
      raw: "Id.",
      reason: "no-earlier-referent",
    });
    expect(occurrences[1]?.result).toEqual({
      status: "error",
      raw: "supra",
      reason: "no-earlier-referent",
    });
    expect(occurrences[5]?.result).toMatchObject({ status: "parsed", reference: "previous" });
    expect(occurrences[6]?.result).toMatchObject({ status: "parsed", reference: "previous" });
  });

  test("does not mistake deposition page lines for a nested recording time", () => {
    const raw = "Smith Dep. 14:26–15:02";
    const occurrences = scanRecordCites(`See ${raw} and 14:26–15:02.`);

    expect(occurrences.map((occurrence) => occurrence.raw)).toEqual([raw, "14:26–15:02"]);
    expect(occurrences.map((occurrence) => occurrence.result)).toMatchObject([
      { status: "parsed", kind: "deposition" },
      { status: "parsed", kind: "time" },
    ]);
  });

  test("excludes a citation signal from a generic deposition transcript", () => {
    const raw = "Dep. Tr. 45:3-12";
    const occurrences = scanRecordCites(`See ${raw}.`);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ raw, from: 4, to: 4 + raw.length });
    expect(occurrences[0]?.result).toMatchObject({
      status: "parsed",
      sourceAlias: "dep tr",
    });
  });
});
