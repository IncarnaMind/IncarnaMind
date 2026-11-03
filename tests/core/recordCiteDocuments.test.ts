import { expect, test } from "vitest";
import { recordCiteLibrary } from "../../src/core/recordCites/documents";
import { parseRecordCite } from "../../src/core/recordCites/parser";
import { resolveRecordCites } from "../../src/core/recordCites/resolver";
import type { LiveDocument } from "../../src/shared/citations";
import type { UnitText } from "../../src/shared/units";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { buildPdf } from "../helpers/pdf";

const live = (id: string, name: string) =>
  ({ id, name, title: null, contentHash: `${id}-hash` }) as LiveDocument;
const page = (pageNumber: number, text: string, printed = String(pageNumber)): UnitText => ({
  page: pageNumber,
  kind: "page",
  label: { printed },
  text,
});

test("record Documents filter by name and Bates index before lazily reading Units", () => {
  const reads: string[] = [];
  const texts: Record<string, UnitText[]> = {
    unrelated: [page(3, "Unrelated")],
    exhibit: [page(3, "Exact exhibit")],
    production: [page(7, "PL-000123\nExact Bates")],
  };
  const lookups: string[] = [];
  const { documents, batesHolders } = recordCiteLibrary(
    {
      names: () => [
        live("unrelated", "Unrelated.pdf"),
        live("exhibit", "Exhibit 7.pdf"),
        live("production", "Production.pdf"),
      ],
      pageTexts: (id) => {
        reads.push(id);
        return texts[id] ?? [];
      },
      batesHolders: (prefix, identifier) => {
        lookups.push(`${prefix}-${identifier}`);
        return new Set(prefix === "PL" && identifier === "000123" ? ["production"] : []);
      },
    },
    { documentIds: null, excluded: new Map() },
  );
  expect(reads).toEqual([]);

  const exhibit = resolveRecordCites({
    cites: [parseRecordCite("Ex. 7 at 3")],
    documents,
    choices: {},
    ...(batesHolders && { batesHolders }),
  });
  expect(exhibit[0]).toMatchObject({ outcome: "found", documentId: "exhibit" });
  expect(reads).toEqual(["exhibit"]);

  const bates = resolveRecordCites({
    cites: [parseRecordCite("PL-000123")],
    documents,
    choices: {},
    ...(batesHolders && { batesHolders }),
  });
  expect(bates[0]).toMatchObject({ outcome: "found", documentId: "production" });
  expect(reads).toEqual(["exhibit", "production"]);
  expect(lookups).toEqual(["PL-000123"]);

  resolveRecordCites({
    cites: [parseRecordCite("Ex. 7 at 3")],
    documents,
    choices: {},
  });
  expect(reads).toEqual(["exhibit", "production"]);
});

test.each([
  {
    name: "printed-only",
    file: () =>
      buildPdf([{ lines: ["Cover"] }, { lines: ["Exact Bates"] }], {
        pageLabels: [{ page: 2, style: "D", prefix: "PL000", start: 123 }],
      }),
  },
  {
    name: "contiguous",
    file: () => buildPdf([{ lines: ["Cover"] }, { lines: ["PL000123", "Exact Bates"] }]),
  },
])(
  "a Bates number is found through the keyword index and the printed page names: $name",
  async ({ file }) => {
    const claim = "PL-000123 Exact Bates proves the record fact.";
    const setup = await setUpWithDocuments(
      checkingModel({
        [claim]: { verdict: "supported", quote: "Exact Bates", judgement: "same" },
      }),
      [{ name: "Production.pdf", contents: file() }],
    );

    const result = await setup.core.checkClaim({ claim });

    expect(result.recordCites?.[0]).toMatchObject({ outcome: "supported", passage: /Exact Bates/ });
  },
);

test("record Documents honor the evidence scope and exclusions before any read", () => {
  const reads: string[] = [];
  const { documents } = recordCiteLibrary(
    {
      names: () => [live("allowed", "Exhibit 7.pdf"), live("excluded", "Exhibit 7.pdf")],
      pageTexts: (id) => {
        reads.push(id);
        return [page(3, id)];
      },
    },
    { documentIds: ["allowed", "excluded"], excluded: new Map([["excluded", "own-workings"]]) },
  );
  expect(documents.map((document) => document.id)).toEqual(["allowed"]);
  expect(reads).toEqual([]);
});
