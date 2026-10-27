import { describe, expect, test } from "vitest";
import type { CitationLocation } from "../../src/core/api";
import {
  type BatesRange,
  parseRecordCite,
  type RecordCiteKind,
  type RecordCiteParseOptions,
} from "../../src/core/recordCites/parser";

interface AcceptedFixture {
  shape: string;
  raw: string;
  kind: RecordCiteKind;
  sourceAlias: string | null;
  location: CitationLocation | null;
  bates: BatesRange | null;
  reference: "previous" | null;
  options?: RecordCiteParseOptions;
}

const previous = { hasPrevious: true } as const;

const directFixture = (
  shape: string,
  raw: string,
  kind: RecordCiteKind,
  sourceAlias: string | null,
  location: CitationLocation,
): AcceptedFixture => ({
  shape,
  raw,
  kind,
  sourceAlias,
  location,
  bates: null,
  reference: null,
});

const batesFixture = (
  shape: string,
  raw: string,
  prefix: string,
  from: string,
  to = from,
): AcceptedFixture => ({
  shape,
  raw,
  kind: "bates",
  sourceAlias: prefix.toLocaleLowerCase(),
  location: null,
  bates: { prefix, from, to },
  reference: null,
});

const previousFixture = (
  shape: string,
  raw: string,
  kind: "id" | "supra",
  location: CitationLocation | null,
): AcceptedFixture => ({
  shape,
  raw,
  kind,
  sourceAlias: null,
  location,
  bates: null,
  reference: "previous",
  options: previous,
});

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

const timeLocation = (from: number, to = from): CitationLocation => ({
  kind: "time",
  from: from * 1000,
  to: to * 1000,
});

const ten = (make: (index: number) => AcceptedFixture) =>
  Array.from({ length: 10 }, (_, index) => make(index));

const names = [
  "Smith",
  "Jones",
  "Garcia",
  "Chen",
  "Patel",
  "Brown",
  "Davis",
  "Lee",
  "Martin",
  "Taylor",
];
const padded = (value: number, width: number) => String(value).padStart(width, "0");

const ACCEPTED_FIXTURES: readonly AcceptedFixture[] = [
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "named deposition, one page",
      `${name} Dep. ${45 + index}:3–${12 + index}`,
      "deposition",
      `${name.toLocaleLowerCase()} dep`,
      depositionLocation(45 + index, 45 + index, 3, 12 + index),
    );
  }),
  ...ten((index) =>
    directFixture(
      "deposition transcript, one page",
      `Dep. Tr. ${45 + index}:3-${12 + index}`,
      "deposition",
      "dep tr",
      depositionLocation(45 + index, 45 + index, 3, 12 + index),
    ),
  ),
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "deposition across a page break",
      `${name} Dep. ${45 + index}:24–${46 + index}:2`,
      "deposition",
      `${name.toLocaleLowerCase()} dep`,
      depositionLocation(45 + index, 46 + index, 24, 2),
    );
  }),
  ...ten((index) =>
    directFixture(
      "exhibit with at",
      `Ex. ${index + 1} at ${index + 3}`,
      "exhibit",
      `ex ${index + 1}`,
      page(index + 3),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "plaintiff exhibit with p.",
      `Pl.'s Ex. ${index + 1}, p. ${index + 3}`,
      "exhibit",
      `pl's ex ${index + 1}`,
      page(index + 3),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "ECF docket entry",
      `ECF No. ${41 + index} at ${5 + index}`,
      "docket",
      `ecf no ${41 + index}`,
      page(5 + index),
    ),
  ),
  ...ten((index) =>
    directFixture(
      "Dkt. docket entry",
      `Dkt. ${41 + index} at ${5 + index}`,
      "docket",
      `dkt ${41 + index}`,
      page(5 + index),
    ),
  ),
  ...ten((index) => {
    const number = padded(123 + index, 6);
    return batesFixture("single Bates identifier", `PL-${number}`, "PL", number);
  }),
  ...ten((index) => {
    const from = padded(45 + index * 10, 4);
    const to = padded(49 + index * 10, 4);
    return batesFixture("Bates range", `DEF ${from}–${to}`, "DEF", from, to);
  }),
  ...ten((index) =>
    directFixture(
      "one complaint paragraph",
      `Compl. ¶ ${14 + index}`,
      "paragraph",
      "compl",
      paragraphLocation(14 + index),
    ),
  ),
  ...ten((index) => {
    const name = names[index] ?? "Smith";
    return directFixture(
      "declaration paragraph range",
      `${name} Decl. ¶¶ ${3 + index}–${5 + index}`,
      "paragraph",
      `${name.toLocaleLowerCase()} decl`,
      paragraphLocation(3 + index, 5 + index),
    );
  }),
  ...ten((index) => {
    const from = (14 + index) * 60 + 20 + index;
    return directFixture(
      "transcript time",
      `${14 + index}:${20 + index}`,
      "time",
      null,
      timeLocation(from),
    );
  }),
  ...ten((index) => {
    const from = 3740 + index;
    const to = 3750 + index;
    return directFixture(
      "transcript time range",
      `${index % 2 === 0 ? "at " : ""}1:02:${padded(20 + index, 2)}–1:02:${padded(30 + index, 2)}`,
      "time",
      null,
      timeLocation(from, to),
    );
  }),
  ...ten((index) => previousFixture("Id.", index % 2 === 0 ? "Id." : "ID.", "id", null)),
  ...ten((index) =>
    previousFixture("Id. with a new page", `Id. at ${7 + index}`, "id", page(7 + index)),
  ),
  ...ten((index) => previousFixture("supra", index % 2 === 0 ? "supra" : "SUPRA", "supra", null)),
];

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
