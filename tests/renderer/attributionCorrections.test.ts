import { randomUUID } from "node:crypto";
import { Editor } from "@tiptap/core";
import { DOMParser } from "linkedom";
import { afterAll, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import type { CitationAttributes, ClaimCheckAttributes, ClaimCheckPart } from "../../src/core/api";
import { ClaimChecks, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { LiveDocument } from "../../src/shared/citations";
import { attributionCorrection, checkWithParts } from "../../src/shared/claimParts";
import { formatClaimFacetPeriod } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";

const mocked = vi.hoisted(() => ({
  documents: [] as LiveDocument[],
  language: "en" as "en" | "zh-CN",
  request: vi.fn(async () => true),
  error: vi.fn(),
}));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: {
    getState: () => ({ documents: mocked.documents, settings: { language: mocked.language } }),
  },
}));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  requestEdit: mocked.request,
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/notices", () => ({
  useNotices: { getState: () => ({ showError: mocked.error }) },
}));

const PERIOD = { start: "2024-03-01", end: "2024-03-31", precision: "month" } as const;
const CASES = [
  {
    language: "en",
    kind: "source",
    literal: "According to Residents",
    named: "Residents",
    fact: "Nora lives in Oslo.",
    text: "According to Residents, Nora lives in Oslo.",
    document: "Register",
    quote: "Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    literal: "根据旧名册",
    named: "旧名册",
    fact: "诺拉住在奥斯陆。",
    text: "根据旧名册，诺拉住在奥斯陆。",
    document: "居民登记",
    quote: "诺拉住在奥斯陆。",
  },
  {
    language: "en",
    kind: "time",
    literal: "Currently",
    named: "",
    fact: "the branch is open.",
    text: "Currently, the branch is open.",
    document: "Facility letter",
    quote: "As at March 2024, the branch was open.",
  },
  {
    language: "zh-CN",
    kind: "time",
    literal: "目前",
    named: "",
    fact: "分行营业。",
    text: "目前，分行营业。",
    document: "分行通知",
    quote: "截至2024年3月，分行营业。",
  },
] as const;

let actions: typeof import("../../src/renderer/src/attributionCorrections");
let checkCommands: typeof import("../../src/renderer/src/commands/checks")["checkCommands"];
let handles: typeof import("../../src/renderer/src/commands/handles");
let openEditors: typeof import("../../src/renderer/src/editor/openEditors");
let menus: typeof import("../../src/renderer/src/commands/menus");

beforeAll(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.assign(document.defaultView, { incarnamind: { on: () => () => undefined } });
  for (const [key, value] of Object.entries({
    window: document.defaultView,
    document,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }))
    vi.stubGlobal(key, value);
  actions = await import("../../src/renderer/src/attributionCorrections");
  ({ checkCommands } = await import("../../src/renderer/src/commands/checks"));
  handles = await import("../../src/renderer/src/commands/handles");
  openEditors = await import("../../src/renderer/src/editor/openEditors");
  menus = await import("../../src/renderer/src/commands/menus");
  await import("../../src/renderer/src/commands/objectMenus");
});
afterAll(() => vi.unstubAllGlobals());

function fixture(row: (typeof CASES)[number]) {
  mocked.language = row.language;
  mocked.request.mockClear();
  mocked.error.mockClear();
  const actual = randomUUID();
  const named = randomUUID();
  mocked.documents = [
    { id: actual, name: row.document, contentHash: "v1" },
    { id: named, name: row.named, contentHash: "n1" },
  ];
  const receipt: CitationAttributes = {
    id: randomUUID(),
    passageId: randomUUID(),
    documentId: actual,
    documentName: row.document,
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    quote: row.quote,
    check: "found",
    checkReason: null,
  };
  const part: ClaimCheckPart = {
    span: { start: 0, end: row.literal.length },
    kind: "fact",
    facet:
      row.kind === "time"
        ? { kind: "time", period: PERIOD }
        : {
            kind: "source",
            named: { start: row.literal.indexOf(row.named), end: row.literal.length },
            candidates: [{ documentId: named }],
          },
    verdict: "unsupported",
    evidence: [receipt],
    says: null,
    unsupported: {
      reason: "A different attribution was checked.",
      covered: null,
      uncovered: null,
      found: true,
    },
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
  const factStart = row.text.indexOf(row.fact);
  const check: ClaimCheckAttributes = checkWithParts(
    {
      id: randomUUID(),
      request: randomUUID(),
      action: "check-against-documents",
      state: "unsupported",
      text: row.text,
      providerId: null,
      modelId: null,
      reason: null,
      detail: null,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-29T12:00:00.000Z",
    },
    [
      part,
      {
        ...part,
        span: { start: factStart, end: row.text.length },
        facet: undefined,
        verdict: "supported",
        unsupported: null,
        evidence: [{ ...receipt, id: randomUUID() }],
      },
    ],
  );
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...noteExtensions(), ClaimChecks],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: randomUUID() },
          content: [
            { type: "text", text: row.text, marks: [{ type: "claimCheck", attrs: check }] },
          ],
        },
      ],
    },
  });
  onTestFinished(() => editor.destroy());
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const mindId = randomUUID();
  handles.noteHandle.current = { editor, doc, mindId, place: mindId };
  onTestFinished(() => {
    handles.noteHandle.current = null;
  });
  onTestFinished(openEditors.registerMindEditor(mindId, editor));
  const claim = shownClaims(editor.state)[0];
  if (!claim) throw new Error("The mounted editor has no current check.");
  return { editor, doc, mindId, claim, part, receipt, actual, named };
}

test.each(CASES)(
  "$language $kind has one row action through caret, menu and palette",
  async (row) => {
    const { editor, doc, mindId, claim, part } = fixture(row);
    editor.commands.setTextSelection(1 + Math.floor(row.literal.length / 2));
    const id = row.kind === "source" ? "check.correctSource" : "check.correctPeriod";
    const command = checkCommands.find((each) => each.id === id);
    if (!command) throw new Error("The correction command is missing.");
    const context = { selection: [], focus: null, surface: "mind" } as const;
    expect(command.when?.(context)).toBe(true);
    const label =
      typeof command.label === "string"
        ? translate(row.language, command.label)
        : command.label(context, (key, values) => translate(row.language, key, values));
    expect(label).toBe(
      row.kind === "source"
        ? translate(row.language, "claim.source.changeTo", { document: row.document })
        : translate(row.language, "claim.time.changeTo", {
            period: formatClaimFacetPeriod(PERIOD, row.language),
          }),
    );
    expect(menus.menuIds("check")).toContain(id);
    await command.run(context);
    expect(mocked.request).toHaveBeenCalledWith(
      editor,
      mindId,
      doc,
      "follow-citation",
      undefined,
      { from: claim.sentence.from, to: claim.sentence.to },
      undefined,
      { id: claim.check.id, span: part.span },
    );
    mocked.request.mockClear();
    editor.commands.setTextSelection(row.text.length);
    expect(command.when?.(context)).toBe(false);
    const here = vi.fn(() => {
      void actions.correctAttribution(editor, mindId, doc, claim, part);
    });
    const rowContext = {
      ...context,
      focus: { kind: "check", id: `${claim.check.id}:${part.span.start}:${part.span.end}` },
      here: { [id]: here },
    } as const;
    expect(command.when?.(rowContext)).toBe(true);
    await command.run(rowContext);
    expect(here).toHaveBeenCalledOnce();
    expect(mocked.request).toHaveBeenCalledOnce();
    const wrongContext = { ...context, focus: { kind: "check", id: "another-row" } } as const;
    expect(command.when?.(wrongContext)).toBe(false);
  },
);

test("source metadata never chooses a twin, invalid remembered id or stale candidate", () => {
  const { claim, part, named } = fixture(CASES[0]);
  expect(
    attributionCorrection(
      claim.check,
      { ...part, facet: { kind: "source", named: { start: 13, end: 22 }, candidates: [] } },
      mocked.documents,
    )?.kind,
  ).toBe("source");
  for (const facet of [
    {
      kind: "source",
      named: { start: 13, end: 22 },
      candidates: [{ documentId: named }, { documentId: "twin" }],
    },
    { kind: "source", named: { start: 13, end: 22 }, candidates: [{ documentId: "removed" }] },
    {
      kind: "source",
      named: { start: 13, end: 22 },
      candidates: [],
      selectedDocumentId: "removed",
    },
  ] as const)
    expect(
      attributionCorrection(
        claim.check,
        { ...part, facet: { ...facet, candidates: [...facet.candidates] } },
        mocked.documents,
      ),
    ).toBeNull();
});

test("a time period must occur in this row's found quotes", () => {
  const { claim, part } = fixture(CASES[2]);
  expect(
    attributionCorrection(
      claim.check,
      {
        ...part,
        evidence: part.evidence.map((each) => ({ ...each, quote: "The branch is open." })),
      },
      mocked.documents,
    ),
  ).toBeNull();
  expect(
    attributionCorrection(
      claim.check,
      {
        ...part,
        facet: { kind: "time", period: { ...PERIOD, start: "2023-03-01", end: "2023-03-31" } },
      },
      mocked.documents,
    ),
  ).toBeNull();
});

test.each([CASES[0], CASES[2]])("$kind keeps an explicitly cited old version's evidence", (row) => {
  const { claim, part, actual } = fixture(row);
  const old = {
    ...part,
    evidence: part.evidence.map((citation) => ({ ...citation, keptOver: "v2" })),
  };
  const before = structuredClone(old);
  const documents = mocked.documents.map((document) =>
    document.id === actual ? { ...document, contentHash: "v2" } : document,
  );
  expect(attributionCorrection(claim.check, old, documents)?.kind).toBe(row.kind);
  expect(old).toEqual(before);
});
