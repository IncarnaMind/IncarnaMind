import { describe, expect, test } from "vitest";
import type { CitationLocation } from "../../src/core/api";
import { depositionMapper } from "../../src/core/documents/deposition";
import { parseRecordCite, recordCiteTokens } from "../../src/core/recordCites/parser";
import { linkRecordCites, resolverInput } from "../../src/core/recordCites/referents";
import { type RecordCiteDocument, resolveRecordCites } from "../../src/core/recordCites/resolver";
import type { UnitText } from "../../src/shared/units";
import {
  ACCEPTED_RECORD_CITE_FIXTURES,
  type AcceptedRecordCiteFixture,
} from "../helpers/recordCites";

const page = (number: number, text: string, printed = String(number)): UnitText => ({
  page: number,
  kind: "page",
  label: { printed },
  text,
});

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${from + index} Text ${from + index}`).join(
    "\n",
  );
const contentRows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `Text ${from + index}`).join("\n");
const paragraphRows = (from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `¶ ${from + index} Text ${from + index}`,
  ).join("\n");

function documentFor(fixture: AcceptedRecordCiteFixture, index: number): RecordCiteDocument {
  const base = { id: `fixture-${index}`, contentHash: `hash-${index}` };
  const location = fixture.location;
  switch (fixture.shape) {
    case "named deposition, one page": {
      if (location?.kind !== "page" || !location.lines) throw new Error("No deposition Location.");
      return {
        ...base,
        name: `${fixture.raw.split(" ")[0]} Deposition.pdf`,
        units: [page(100 + index, `Page ${location.from}\n${rows(1, location.lines.to)}`)],
      };
    }
    case "deposition transcript, one page": {
      if (location?.kind !== "page" || !location.lines) throw new Error("No deposition Location.");
      return {
        ...base,
        name: "Deposition Transcript.pdf",
        units: [page(100 + index, `Page ${location.from}\n${rows(1, location.lines.to)}`)],
      };
    }
    case "deposition across a page break": {
      if (location?.kind !== "page" || !location.lines) throw new Error("No deposition Location.");
      return {
        ...base,
        name: `${fixture.raw.split(" ")[0]} Deposition.pdf`,
        units: [
          page(100 + index, `Page ${location.from}\n${rows(1, 24)}`),
          page(101 + index, `Page ${location.to}\n${rows(1, 2)}`),
        ],
      };
    }
    case "exhibit with at": {
      if (location?.kind !== "page") throw new Error("No exhibit Location.");
      return {
        ...base,
        name: `Exhibit ${fixture.sourceAlias?.split(" ").at(-1)}.pdf`,
        units: [page(location.from, "Exhibit page")],
      };
    }
    case "plaintiff exhibit with p.":
      if (location?.kind !== "page") throw new Error("No exhibit Location.");
      return {
        ...base,
        name: `Pl.'s Ex. ${fixture.sourceAlias?.split(" ").at(-1)}.pdf`,
        units: [page(location.from, "Plaintiff exhibit page")],
      };
    case "ECF docket entry":
      if (location?.kind !== "page") throw new Error("No docket Location.");
      return {
        ...base,
        name: `ECF No. ${fixture.sourceAlias?.split(" ").at(-1)}.pdf`,
        units: [page(location.from, "ECF page")],
      };
    case "Dkt. docket entry":
      if (location?.kind !== "page") throw new Error("No docket Location.");
      return {
        ...base,
        name: `Dkt. ${fixture.sourceAlias?.split(" ").at(-1)}.pdf`,
        units: [page(location.from, "Docket page")],
      };
    case "single Bates identifier":
      return {
        ...base,
        name: "Production.pdf",
        units: [page(7, `${fixture.raw}\nExact Bates page`)],
      };
    case "Bates range": {
      if (!fixture.bates) throw new Error("No Bates range.");
      const first = Number(fixture.bates.from);
      return {
        ...base,
        name: "Defendant production.pdf",
        units: Array.from({ length: 5 }, (_, offset) =>
          page(
            8 + offset,
            `DEF ${String(first + offset).padStart(4, "0")}\nRange page ${offset + 1}`,
          ),
        ),
      };
    }
    case "one complaint paragraph":
      if (location?.kind !== "section" || !location.paragraphs) {
        throw new Error("No complaint Location.");
      }
      return {
        ...base,
        name: "Complaint.pdf",
        units: [page(2, `¶ ${location.paragraphs.from} Exact complaint paragraph`)],
      };
    case "declaration paragraph range": {
      if (location?.kind !== "section" || !location.paragraphs) {
        throw new Error("No paragraph Location.");
      }
      return {
        ...base,
        name: `${fixture.raw.split(" ")[0]} Declaration.pdf`,
        units: [page(2, paragraphRows(location.paragraphs.from, location.paragraphs.to))],
      };
    }
    case "transcript time":
    case "transcript time range": {
      if (location?.kind !== "time") throw new Error("No time Location.");
      return {
        ...base,
        name: "Recording.vtt",
        units: [
          {
            page: 1,
            kind: "cues",
            label: { speakers: ["Bob"] },
            text: "Exact answer",
            anchors: [
              {
                start: 0,
                end: "Exact answer".length,
                target: `t${location.from}-${location.to + 5000}`,
              },
            ],
          },
        ],
      };
    }
    default:
      throw new Error(`A direct Document is not needed for ${fixture.shape}.`);
  }
}

function expectedLocation(
  fixture: AcceptedRecordCiteFixture,
  document: RecordCiteDocument,
): CitationLocation | null {
  const requested = fixture.location;
  if (fixture.kind === "bates" && fixture.bates) {
    const first = document.units[0];
    const last = document.units.at(-1);
    if (!first || !last || first.page === null || last.page === null) return null;
    return {
      kind: "page",
      from: first.page,
      to: last.page,
      printed: {
        from: first.label?.printed ?? `${fixture.bates.prefix} ${fixture.bates.from}`,
        to: last.label?.printed ?? `${fixture.bates.prefix} ${fixture.bates.to}`,
      },
    };
  }
  if (!requested) return null;
  if (requested.kind === "section" || requested.kind === "time") {
    if (requested.kind === "time") {
      return { ...requested, to: requested.to + 5000, speaker: "Bob" };
    }
    return requested;
  }
  const units = document.units;
  const first = units[0];
  const last = units.at(-1);
  if (!first || !last || first.page === null || last.page === null) return null;
  if (fixture.kind === "deposition") {
    return { ...requested, from: first.page, to: last.page };
  }
  if (requested.kind !== "page") return requested;
  return {
    ...requested,
    from: first.page,
    to: last.page,
    printed: { from: String(first.page), to: String(last.page) },
  };
}

function expectedPassage(fixture: AcceptedRecordCiteFixture): string {
  switch (fixture.shape) {
    case "named deposition, one page":
    case "deposition transcript, one page": {
      if (fixture.location?.kind !== "page" || !fixture.location.lines) return "";
      return contentRows(fixture.location.lines.from, fixture.location.lines.to);
    }
    case "deposition across a page break":
      return "Text 24\nText 1\nText 2";
    case "exhibit with at":
      return "Exhibit page";
    case "plaintiff exhibit with p.":
      return "Plaintiff exhibit page";
    case "ECF docket entry":
      return "ECF page";
    case "Dkt. docket entry":
      return "Docket page";
    case "single Bates identifier":
      return `${fixture.raw}\nExact Bates page`;
    case "Bates range": {
      const first = Number(fixture.bates?.from);
      return Array.from(
        { length: 5 },
        (_, index) => `DEF ${String(first + index).padStart(4, "0")}\nRange page ${index + 1}`,
      ).join("\n");
    }
    case "one complaint paragraph":
      if (fixture.location?.kind !== "section" || !fixture.location.paragraphs) return "";
      return `¶ ${fixture.location.paragraphs.from} Exact complaint paragraph`;
    case "declaration paragraph range": {
      if (fixture.location?.kind !== "section" || !fixture.location.paragraphs) return "";
      return paragraphRows(fixture.location.paragraphs.from, fixture.location.paragraphs.to);
    }
    case "transcript time":
    case "transcript time range":
      return "Bob: Exact answer";
    default:
      return "";
  }
}

describe("ten resolving fixtures of every accepted record-cite shape", () => {
  test("the table has sixteen shapes with ten examples each", () => {
    const shapes = new Set(ACCEPTED_RECORD_CITE_FIXTURES.map((fixture) => fixture.shape));
    expect(shapes.size).toBe(16);
    for (const shape of shapes) {
      expect(
        ACCEPTED_RECORD_CITE_FIXTURES.filter((fixture) => fixture.shape === shape),
      ).toHaveLength(10);
    }
  });

  test.each(ACCEPTED_RECORD_CITE_FIXTURES.filter((fixture) => !fixture.reference))(
    "$shape: $raw resolves its exact Document, Location and Passage",
    (fixture) => {
      const index = ACCEPTED_RECORD_CITE_FIXTURES.indexOf(fixture);
      const document = documentFor(fixture, index);
      const [result] = resolveRecordCites({
        cites: [parseRecordCite(fixture.raw)],
        documents: [document],
        choices: {},
        deposition: depositionMapper,
      });
      expect(result).toMatchObject({
        raw: fixture.raw,
        outcome: "found",
        documentId: document.id,
        contentHash: document.contentHash,
        location: expectedLocation(fixture, document),
        passage: expectedPassage(fixture),
      });
    },
  );

  test.each(ACCEPTED_RECORD_CITE_FIXTURES.filter((fixture) => fixture.kind === "id"))(
    "$shape: $raw resolves on the record item before it",
    (fixture) => {
      const nextPage = fixture.location?.kind === "page" ? fixture.location.from : 3;
      const document: RecordCiteDocument = {
        id: "previous-record",
        name: "Exhibit 7.pdf",
        contentHash: "hash-previous",
        units: [
          page(3, "Previous passage"),
          ...(fixture.location?.kind === "page" ? [page(nextPage, "Next passage")] : []),
        ],
      };
      const results = resolveRecordCites({
        cites: linkRecordCites(recordCiteTokens(`Ex. 7 at 3; ${fixture.raw}`)).map(resolverInput),
        documents: [document],
        choices: {},
        deposition: depositionMapper,
      });
      expect(results[1]).toMatchObject({
        raw: fixture.raw,
        outcome: "found",
        documentId: document.id,
        location:
          fixture.location?.kind === "page"
            ? {
                kind: "page",
                from: nextPage,
                to: nextPage,
                printed: { from: String(nextPage), to: String(nextPage) },
              }
            : { kind: "page", from: 3, to: 3, printed: { from: "3", to: "3" } },
        passage: fixture.location ? "Next passage" : "Previous passage",
      });
    },
  );

  test.each(ACCEPTED_RECORD_CITE_FIXTURES.filter((fixture) => fixture.kind === "supra"))(
    "$shape: $raw resolves on the earlier cite of its source",
    (fixture) => {
      const name = fixture.raw.split(" ")[0] ?? "";
      const declaration: RecordCiteDocument = {
        id: "declaration",
        name: `${name} Declaration.pdf`,
        contentHash: "hash-declaration",
        units: [page(2, "¶ 3 Previous passage\n¶ 4 Later")],
      };
      const exhibit: RecordCiteDocument = {
        id: "exhibit",
        name: "Exhibit 7.pdf",
        contentHash: "hash-exhibit",
        units: [page(3, "Exhibit passage")],
      };
      const results = resolveRecordCites({
        cites: linkRecordCites(
          recordCiteTokens(`${name} Decl. ¶ 3; Ex. 7 at 3; ${fixture.raw}`),
        ).map(resolverInput),
        documents: [declaration, exhibit],
        choices: {},
      });
      expect(results[2]).toMatchObject({
        raw: fixture.raw,
        outcome: "found",
        documentId: "declaration",
        passage: "¶ 3 Previous passage",
      });
    },
  );
});
