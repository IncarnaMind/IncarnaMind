import { describe, expect, test } from "vitest";
import type { CitationLocation } from "../../src/core/api";
import { recordCiteAlias, recordCiteAliasMatches } from "../../src/core/recordCites/alias";
import {
  parseRecordCite,
  type RecordCiteToken,
  recordCiteSpans,
  recordCiteTokens,
} from "../../src/core/recordCites/parser";
import { ACCEPTED_RECORD_CITE_FIXTURES as ACCEPTED_FIXTURES } from "../helpers/recordCites";

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

const cites = (text: string) =>
  recordCiteTokens(text).filter(
    (token): token is Extract<RecordCiteToken, { kind: "cite" }> => token.kind === "cite",
  );
const raws = (text: string) => cites(text).map((cite) => cite.raw);

describe("record-cite fixtures", () => {
  test("has ten examples of every required shape", () => {
    const shapes = new Set(ACCEPTED_FIXTURES.map((fixture) => fixture.shape));
    expect(shapes.size).toBe(16);
    for (const shape of shapes) {
      expect(ACCEPTED_FIXTURES.filter((fixture) => fixture.shape === shape)).toHaveLength(10);
    }
  });

  test.each(ACCEPTED_FIXTURES)("$shape: $raw", (fixture) => {
    const result = parseRecordCite(fixture.raw);
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
  test.each(["Smith Dep. 45:3-12", "Smith Dep. 45:3–12", "Smith Dep. 45:3 — 12"])(
    "reads deposition dashes in %s",
    (raw) => {
      expect(parseRecordCite(raw)).toMatchObject({
        status: "parsed",
        location: depositionLocation(45, 45, 3, 12),
      });
    },
  );

  test.each([
    ["  SMITH   dEp.   45 : 3 – 12  ", "smith dep", depositionLocation(45, 45, 3, 12)],
    ["  Pl.’s   eX. 7, P. 3  ", "pl ex 7", page(3)],
    ["  EcF nO. 41 At 5  ", "dkt 41", page(5)],
    ["  cOmPl. ¶ 14  ", "compl", paragraphLocation(14)],
  ])("normalizes whitespace and case in %s", (raw, sourceAlias, location) => {
    expect(parseRecordCite(raw)).toMatchObject({ status: "parsed", raw, sourceAlias, location });
  });

  test("a single deposition line ends where it starts", () => {
    expect(parseRecordCite("Smith Dep. 45:3")).toMatchObject({
      status: "parsed",
      location: depositionLocation(45, 45, 3, 3),
    });
    expect(parseRecordCite("Id. at 47:5")).toMatchObject({
      status: "parsed",
      location: depositionLocation(47, 47, 5, 5),
    });
  });

  test("keeps exact first and last printed lines across a page break", () => {
    expect(parseRecordCite("Dep. Tr. 45:24–46:2")).toMatchObject({
      status: "parsed",
      kind: "deposition",
      location: depositionLocation(45, 46, 24, 2),
    });
  });

  test("keeps printed page labels apart from physical Unit numbers", () => {
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

  test("reads paragraphs as section paragraphs, not text lines", () => {
    const result = parseRecordCite("Smith Decl. ¶¶ 3–5");
    expect(result).toMatchObject({ status: "parsed", location: paragraphLocation(3, 5) });
    expect(result.status === "parsed" && result.location).not.toHaveProperty("lines");
  });

  test.each([
    ["Id. at 47:5–9", depositionLocation(47, 47, 5, 9)],
    ["Id. at 47:5–48:2", depositionLocation(47, 48, 5, 2)],
    ["Id. at 7", page(7)],
    ["Id. at 7–8", page(7, 8)],
    ["Id. ¶ 15", paragraphLocation(15)],
    ["Id. ¶¶ 15–16", paragraphLocation(15, 16)],
    ["Id.", null],
  ])("carries the exact Location of %s", (raw, location) => {
    expect(parseRecordCite(raw)).toEqual({
      status: "parsed",
      raw,
      kind: "id",
      sourceAlias: null,
      location,
      bates: null,
      reference: "previous",
    });
  });

  test.each([
    ["Am. Compl. ¶ 14", "am compl", paragraphLocation(14)],
    ["Second Am. Compl. ¶¶ 3–5", "second am compl", paragraphLocation(3, 5)],
    ["Def.'s Ex. 7 at 3", "def ex 7", page(3)],
    ["Def.’s Ex. 7, p. 3", "def ex 7", page(3)],
    ["Defs.' Ex. 7 at 3", "def ex 7", page(3)],
    ["Pl.'s Ex. 7 at 3–4", "pl ex 7", page(3, 4)],
    ["Smith Dep. Ex. 7 at 3", "smith dep ex 7", page(3)],
    ["Ex. A at 3", "ex a", page(3)],
    ["Exhibit 7 at 3", "ex 7", page(3)],
  ])("keeps the source's prefix in %s", (raw, sourceAlias, location) => {
    expect(parseRecordCite(raw)).toMatchObject({ status: "parsed", sourceAlias, location });
  });

  test.each([
    ["Smith Decl., supra", "smith decl", null],
    ["Ex. 7, supra", "ex 7", null],
    ["ECF No. 41, supra, at 6", "dkt 41", page(6)],
    ["Compl., supra, ¶ 3", "compl", paragraphLocation(3)],
  ])("keeps a named supra's source in %s", (raw, sourceAlias, location) => {
    expect(parseRecordCite(raw)).toMatchObject({
      status: "parsed",
      kind: "supra",
      sourceAlias,
      location,
      reference: "previous",
    });
  });

  test("reads a recording time only with its source's name", () => {
    expect(parseRecordCite("Hearing Tr. at 10:32–10:45")).toMatchObject({
      status: "parsed",
      kind: "time",
      sourceAlias: "hearing",
      location: { kind: "time", from: 632_000, to: 645_000 },
    });
    expect(parseRecordCite("Tr. at 10:32")).toMatchObject({ status: "error", reason: "malformed" });
    expect(parseRecordCite("at 10:32")).toMatchObject({ status: "error", reason: "malformed" });
  });

  test.each([
    ["PL-000123", "PL", "000123", "000123"],
    ["DEF 0045–0049", "DEF", "0045", "0049"],
    ["PL-000123–PL-000125", "PL", "000123", "000125"],
    ["ABC0001234", "ABC", "0001234", "0001234"],
    ["SMITH-12345", "SMITH", "12345", "12345"],
  ])("reads the Bates identifier %s with its prefix and zeros", (raw, prefix, from, to) => {
    expect(parseRecordCite(raw)).toMatchObject({
      status: "parsed",
      kind: "bates",
      bates: { prefix, from, to },
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
    "supra",
    "supra at 7",
    "12:3",
    "14:60",
    "1:60:00",
    "ID.",
  ])("returns malformed for %s", (raw) => {
    expect(parseRecordCite(raw)).toEqual({ status: "error", raw, reason: "malformed" });
  });

  test.each([
    "Smith Dep. 0:3–12",
    "Smith Dep. 45:0–12",
    "Smith Dep. 45:12–3",
    "Smith Dep. 46:3–45:2",
    "Smith Dep. 99999999999999999999:3–12",
    "Ex. 7 at 0",
    "Ex. 7 at 4–3",
    "Dkt. 41 at 0",
    "Compl. ¶ 0",
    "Smith Decl. ¶¶ 5–3",
    "DEF 0049–0045",
    "Recording Tr. at 14:26–12:20",
    "Recording Tr. at 14:60",
    "Id. at 0",
    "Id. at 47:0",
    "Id. at 47:5–4",
  ])("returns out-of-range for %s", (raw) => {
    expect(parseRecordCite(raw)).toMatchObject({ status: "error", raw, reason: "out-of-range" });
  });
});

describe("record-cite scanning", () => {
  test.each([
    "ID.",
    "COVID-19",
    "pages 10-12",
    "PL-123",
    "pl-000123",
    "FY 2023-2024",
    "ISO 9001-2015",
    "ISO-9001",
    "GDP 2019–2020",
    "USD 10000–20000",
    "RMB 50000–60000",
    "The board met at 10:30.",
    "董事会于 10:30 开会。",
    "Watch the video at 1:02.",
    "As noted supra, the claim fails.",
    "The independent 4:5 count and the complex 2 at 5.",
    "He said it was valid. Ibid.",
    "Each user has an id.",
    "The Video at 1:02 shows it.",
    "Team Meeting Recording at 10:30 started late.",
  ])("finds no record cite in %s", (text) => {
    expect(cites(text)).toEqual([]);
  });

  test("keeps repeated raw cites as separate occurrences with their own ranges", () => {
    const raw = "Smith Dep. 45:3–12";
    const text = `${raw}, then ${raw}.`;
    const found = cites(text);

    expect(found.map((cite) => cite.raw)).toEqual([raw, raw]);
    expect(found[0]).toMatchObject({ from: 0, to: raw.length });
    const second = text.indexOf(raw, raw.length);
    expect(found[1]).toMatchObject({ from: second, to: second + raw.length });
    for (const cite of found) {
      expect(text.slice(cite.from, cite.to)).toBe(cite.raw);
      expect(cite.result.raw).toBe(cite.raw);
    }
  });

  test("finds several shapes in one sentence in reading order", () => {
    const written = [
      "Smith Dep. 45:3–12",
      "Ex. 7 at 3",
      "ECF No. 41 at 5",
      "Compl. ¶ 14",
      "DEF 0045–0049",
      "Recording Tr. at 14:26",
    ];
    const found = cites(`(${written.join("; ")}).`);

    expect(found.map((cite) => cite.raw)).toEqual(written);
    expect(found.map((cite) => cite.result)).toEqual(written.map((raw) => parseRecordCite(raw)));
  });

  test("starts a cite at its source's name, never at the sentence before or a signal", () => {
    expect(raws("The witness denied it (Smith Dep. 45:3–12).")).toEqual(["Smith Dep. 45:3–12"]);
    expect(raws("See also Smith Dep. 45:3–12; cf. Jones Dep. 4:5.")).toEqual([
      "Smith Dep. 45:3–12",
      "Jones Dep. 4:5",
    ]);
    expect(raws("It is in the Agreement. Ex. 7 at 3 says so.")).toEqual(["Ex. 7 at 3"]);
    expect(raws("He signed it (Def.'s Mot., Ex. 7 at 3).")).toEqual(["Ex. 7 at 3"]);
    expect(raws("See Dep. Tr. 45:3-12.")).toEqual(["Dep. Tr. 45:3-12"]);
    expect(raws("The Smith Dep. 45:3–12 says so.")).toEqual(["Smith Dep. 45:3–12"]);
  });

  test("never drops a source's prefix to reach a bare exhibit or complaint", () => {
    const found = cites("(Defs.' Ex. 7 at 3; Am. Compl. ¶ 14; Second Am. Compl. ¶ 3)");
    expect(
      found.map((cite) => (cite.result.status === "parsed" ? cite.result.sourceAlias : null)),
    ).toEqual(["def ex 7", "am compl", "second am compl"]);
  });

  test("reads cites run straight on from Chinese, with UTF-16 offsets", () => {
    const text = "证据 😀：见Ex. 7 at 3，证词（Smith Dep. 45:3–12）。";
    const found = cites(text);
    expect(found.map((cite) => cite.raw)).toEqual(["Ex. 7 at 3", "Smith Dep. 45:3–12"]);
    for (const cite of found) expect(text.slice(cite.from, cite.to)).toBe(cite.raw);
  });

  test("a cite that goes on past what its shape reads is never read in part", () => {
    for (const text of [
      "Ex. 7 at 3, 5.",
      "PL-000123–125.",
      "Compl. ¶ 14, ¶ 16.",
      "Smith Dep. 45:3–",
    ]) {
      const found = cites(text);
      expect(found.at(-1)?.result).toMatchObject({ status: "error", reason: "malformed" });
    }
  });

  test("reads every range of one deposition", () => {
    const found = cites("(Smith Dep. 45:3–12, 47:1–4)");
    expect(found.map((cite) => cite.raw)).toEqual(["Smith Dep. 45:3–12", "47:1–4"]);
    expect(found[1]?.result).toMatchObject({
      status: "parsed",
      kind: "deposition",
      sourceAlias: "smith dep",
      location: depositionLocation(47, 47, 1, 4),
    });
  });

  test("lists a court decision's citation in reading order and reads no record cite inside it", () => {
    const decision = "Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)";
    expect(
      recordCiteTokens(`Smith Dep. 45:3–4; ${decision}; Id. at 105.`).map((each) => each.kind),
    ).toEqual(["cite", "authority", "cite"]);
  });

  test("lists statutes, regulations, rules, Restatements and inline nodes as other authorities", () => {
    for (const authority of [
      "42 U.S.C. § 1983",
      "29 C.F.R. § 1604.11(a)",
      "Fed. R. Civ. P. 56(a)",
      "Restatement (Second) of Contracts § 90 (1981)",
      "the Citation \uFFFC",
    ]) {
      expect(
        recordCiteTokens(`Smith Dep. 45:3. ${authority}. Id.`).map((each) => each.kind),
      ).toContain("authority");
    }
  });

  test("a supra naming no record item is another authority's, never a record cite", () => {
    expect(recordCiteTokens("Smith, supra note 3, at 46.").map((each) => each.kind)).toEqual([
      "authority",
    ]);
    expect(raws("Smith Dep., supra, at 45:3–4.")).toEqual(["Smith Dep., supra, at 45:3–4"]);
    expect(cites("Smith Dep., supra, at 45:3–4.")[0]?.result).toMatchObject({
      kind: "supra",
      sourceAlias: "smith dep",
      location: depositionLocation(45, 45, 3, 4),
    });
  });

  test("a short form followed by a pin cite it can't read is malformed", () => {
    for (const text of ["Smith Dep., supra note 3, at 46.", "Id. § 4.", "Ex. 7, supra n.2."]) {
      expect(cites(text)[0]?.result).toMatchObject({ status: "error", reason: "malformed" });
    }
  });

  test("a word that ends the sentence before is never part of a source's name", () => {
    expect(raws("He said no. Smith Dep. 45:3.")).toEqual(["Smith Dep. 45:3"]);
    expect(raws("It was paid by Acme Inc. Smith Dep. 45:3.")).toEqual(["Smith Dep. 45:3"]);
    expect(raws("A loan from Lake Co. Smith Dep. 45:3.")).toEqual(["Smith Dep. 45:3"]);
    expect(raws("He agreed (Acme Inc. Dep. 12:3).")).toEqual(["Acme Inc. Dep. 12:3"]);
  });

  test("reads full-width digits, colon and hyphen, keeping the cite as written", () => {
    for (const written of [
      "Smith Dep. ４５:３-４",
      "Smith Dep. 45：3-4",
      "Smith Dep. ４５：３－４",
    ]) {
      const text = `证人确认（${written}）。`;
      const [found] = cites(text);
      expect(found?.raw).toBe(written);
      expect(found && text.slice(found.from, found.to)).toBe(written);
      expect(found?.result).toMatchObject({
        status: "parsed",
        location: depositionLocation(45, 45, 3, 4),
      });
    }
  });

  test("gives the spans a sentence break must not fall in", () => {
    const text = "Plaintiff left (Smith Dep. 45:3–12). Id. at 47:5–9.";
    expect(recordCiteSpans(text).map((span) => text.slice(span.from, span.to))).toEqual([
      "Smith Dep. 45:3–12",
      "Id. at 47:5–9",
    ]);
  });
});

describe("record-source aliases", () => {
  test.each([
    ["Def.'s Ex. 7", "Defendants' Exhibit 7.pdf"],
    ["Pl.’s Ex. 7", "Plaintiff's Exhibit 7.pdf"],
    ["Smith Dep. Tr.", "Smith Deposition Transcript.pdf"],
    ["Smith Dep.", "Smith Deposition.pdf"],
    ["Am. Compl.", "Amended Complaint.pdf"],
    ["ECF No. 41", "Dkt. 41.pdf"],
  ])("%s names %s", (cited, name) => {
    expect(recordCiteAliasMatches(name, recordCiteAlias(cited))).toBe(true);
  });

  test.each([
    ["Def.'s Ex. 7", "Exhibit 7.pdf"],
    ["Ex. 7", "Def.'s Ex. 7.pdf"],
    ["Am. Compl.", "Complaint.pdf"],
    ["Compl.", "Amended Complaint.pdf"],
    ["Ex. 7", "Ex. 70.pdf"],
    ["Jones' Dep.", "Jone Deposition.pdf"],
  ])("%s does not name %s", (cited, name) => {
    expect(recordCiteAliasMatches(name, recordCiteAlias(cited))).toBe(false);
  });
});
