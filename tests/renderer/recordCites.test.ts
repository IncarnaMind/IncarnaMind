import { getSchema } from "@tiptap/core";
import { beforeAll, describe, expect, test } from "vitest";
import type { ChooseRecordCiteSourceInput, RecordCiteResult } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { translate } from "../../src/shared/i18n";
import { formatLocation } from "../../src/shared/locations";

const LOCATION = {
  kind: "page",
  from: 4,
  to: 4,
  printed: { from: "45", to: "45" },
  lines: { from: 3, to: 12 },
} as const;

const CITES: RecordCiteResult[] = [
  {
    raw: "Smith Dep. 45:3–12",
    from: 0,
    to: 18,
    outcome: "supported",
    documentId: "doc-supported",
    documentName: "Smith transcript",
    contentHash: "same-hash",
    location: LOCATION,
    pageFrom: 4,
    pageTo: 4,
    passage: "The notice arrived on 4 May.",
  },
  {
    raw: "Ex. 7 at 3",
    from: 19,
    to: 29,
    outcome: "partly",
    documentId: "doc-exhibit",
    documentName: "Exhibit 7",
    location: { kind: "page", from: 3, to: 3 },
    pageFrom: 3,
    pageTo: 3,
    passage: "Delivery was attempted on Monday.",
    covered: "the delivery attempt",
    uncovered: "receipt by the defendant",
  },
  {
    raw: "Dkt. 41 at 5",
    from: 30,
    to: 42,
    outcome: "choose",
    location: { kind: "page", from: 5, to: 5 },
    candidates: [
      { id: "duplicate-a", name: "Duplicate filing" },
      { id: "duplicate-b", name: "Duplicate filing" },
    ],
  },
  {
    raw: "PL-000123",
    from: 43,
    to: 52,
    outcome: "not-found",
    documentId: "doc-production",
    documentName: "Production",
    location: { kind: "page", from: 8, to: 8 },
    pageFrom: 8,
    pageTo: 8,
    passage: "The cited page concerns another event.",
    nearby: {
      location: { kind: "page", from: 9, to: 9, lines: { from: 5, to: 9 } },
      pageFrom: 9,
      pageTo: 9,
      passage: "The nearby passage states the damages figure.",
    },
  },
];

const TEXT = CITES.map((cite) => cite.raw).join(" ");
const CHOOSE_CITE = CITES[2] as RecordCiteResult;
const RESOLVED: RecordCiteResult = {
  ...CHOOSE_CITE,
  outcome: "supported",
  documentId: "duplicate-b",
  documentName: "Duplicate filing",
  passage: "The chosen filing supports the sentence.",
};

const asked: ChooseRecordCiteSourceInput[] = [];
let ui: typeof import("../../src/renderer/src/editor/recordCiteSources");

beforeAll(async () => {
  const bridge = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "chooseRecordCiteSource"
          ? async (input: ChooseRecordCiteSourceInput) => {
              asked.push(input);
              return { cite: RESOLVED };
            }
          : () => () => undefined,
    },
  );
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  ui = await import("../../src/renderer/src/editor/recordCiteSources");
});

describe("record cites on a sentence check", () => {
  test("the mark keeps every outcome in raw order through a JSON save and reload, even when the sentence is Supported", () => {
    for (const cite of CITES) expect(TEXT.slice(cite.from, cite.to)).toBe(cite.raw);
    const schema = getSchema(noteExtensions());
    const attrs = {
      id: "check-record-cites",
      request: "request-1",
      action: "check-against-documents",
      state: "supported",
      reason: null,
      detail: null,
      providerId: "test",
      modelId: "test",
      text: TEXT,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      recordCites: CITES,
      checkedAt: new Date().toISOString(),
    };
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: TEXT, marks: [{ type: "claimCheck", attrs }] }],
        },
      ],
    };

    const saved = schema.nodeFromJSON(content).toJSON();
    const [claim] = claimSpans(schema.nodeFromJSON(saved));

    expect(claim?.check.state).toBe("supported");
    expect(claim?.check.recordCites).toEqual(CITES);
    expect(claim?.check.recordCites?.map((cite) => cite.raw)).toEqual(
      CITES.map((cite) => cite.raw),
    );
    expect(claim?.check.recordCites?.at(-1)).toMatchObject({
      outcome: "not-found",
      passage: "The cited page concerns another event.",
      nearby: { passage: "The nearby passage states the damages figure." },
    });
  });

  test("candidate rows keep duplicate names distinct by stable Document id and show the exact Location", () => {
    const options = ui.recordCiteCandidateOptions(
      CHOOSE_CITE,
      [
        { id: "duplicate-a", name: "Same current name" },
        { id: "duplicate-b", name: "Same current name" },
      ],
      (key, params) => translate("en", key, params),
    );

    expect(options).toHaveLength(2);
    expect(options.map((option) => option.id)).toEqual(["duplicate-a", "duplicate-b"]);
    expect(options.map((option) => option.data?.["data-document-id"])).toEqual([
      "duplicate-a",
      "duplicate-b",
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "Same current name",
      "Same current name",
    ]);
    expect(options[0]?.detail).toBe(
      formatLocation(CITES[2]?.location ?? LOCATION, (key, params) => translate("en", key, params)),
    );
  });

  test("a duplicate-name candidate shows its source detail instead of only a page", () => {
    const options = ui.recordCiteCandidateOptions(
      {
        ...CHOOSE_CITE,
        candidates: [
          { id: "duplicate-a", name: "Duplicate filing", detail: "/cases/a/ECF 41.pdf" },
        ],
      },
      [],
      (key, params) => translate("en", key, params),
    );

    expect(options[0]?.detail).toBe("/cases/a/ECF 41.pdf");
  });

  test("a current Document name is found by stable id only, never by matching saved content", () => {
    const documents = [
      { id: "doc-supported", name: "Current transcript" },
      { id: "another-id", name: "Production" },
    ];
    expect(
      ui.recordCiteDocumentName(
        {
          documentId: "doc-supported",
          documentName: "Smith transcript",
          contentHash: "same-hash",
        },
        documents,
      ),
    ).toBe("Current transcript");
    expect(
      ui.recordCiteDocumentName(
        {
          documentId: "deleted-id",
          documentName: "Production",
          contentHash: "same-hash",
        },
        documents,
      ),
    ).toBe("Production");
  });

  test("choosing sends only the cite's stable coordinates and returns its resolved result", async () => {
    asked.length = 0;
    const input: ChooseRecordCiteSourceInput = {
      mindId: "mind-1",
      checkId: "check-record-cites",
      raw: "Dkt. 41 at 5",
      from: 30,
      to: 42,
      documentId: "duplicate-b",
    };

    await expect(ui.chooseRecordCite(input)).resolves.toEqual(RESOLVED);
    expect(asked).toEqual([input]);
  });
});
