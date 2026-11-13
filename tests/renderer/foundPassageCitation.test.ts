/**
 * The User makes a Passage a check found the sentence's Citation (#3019): Add as Citation on the
 * card, or all of them together from the check's result line, each one step of Undo. The ✓ is read
 * from the Note as it stands: it shows at once with no new request, Undo takes it away again, and
 * the Note opened again reads the same.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser } from "linkedom";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type Core,
  type Document,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { CitationNumbers } from "../../src/renderer/src/editor/citationNumbers";
import { ClaimChecks, claimsOf, shownClaims } from "../../src/renderer/src/editor/claimChecks";
import { checkRows, noteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { translate } from "../../src/shared/i18n";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({ resolveProposalsIn: vi.fn() }));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/store", () => ({
  useAppStore: { getState: () => ({ documents: [], minds: [], settings: { language: "en" } }) },
}));

const { addAsCitation, addFoundCitations, foundCitationInserts } = await import(
  "../../src/renderer/src/checks"
);
const { checkStateKey } = await import("../../src/renderer/src/unsupportedFixes");
const { noteStateOf, noteStateParts } = await import("../../src/renderer/src/noteState");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllGlobals();
});

const LINE = "The tide turns twice a day.";
const OTHER = "The harbour closes at dusk.";
const LINE_ZH = "港口的潮水每天都会涨落两次。";
const OTHER_ZH = "港口在黄昏时关闭。";
const DAWN = "Boats leave the harbour at dawn.";
const TIDES = {
  name: "Tides.md",
  contents: `# Tides\n\n${LINE}\n\n${OTHER}\n\n${LINE_ZH}\n\n${OTHER_ZH}\n\n${DAWN}\n`,
};
const SENTENCE = "Tides turn twice in a day here.";
const SENTENCE_ZH = "这里的潮水每天涨落两次。";
const PLANS: Record<string, Plan> = {
  [SENTENCE]: { verdict: "supported", quote: LINE, says: LINE, judgement: "same" },
  [SENTENCE_ZH]: { verdict: "supported", quote: LINE_ZH, says: LINE_ZH, judgement: "same" },
};

const citationOf = (tides: Document, quote: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    documentId: tides.id,
    documentName: tides.name,
    contentHash: tides.contentHash,
    quote,
    check: "found",
  },
});

const cited = (id: string, sentence: string, citation: JSONContent): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text: sentence.slice(0, -1) },
    citation,
    { type: "text", text: sentence.slice(-1) },
  ],
});

function stubDom() {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  Object.defineProperty(document, "styleSheets", { value: [] });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", document.defaultView);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({
    fontStyle: "",
    fontWeight: "",
    fontSize: "",
    fontFamily: "",
  }));
}

/** The Note's editor, as the window binds it to the Note's copy the core keeps. */
function editorOf(client: MindClient): Editor {
  const editor = new Editor({
    element: globalThis.document.createElement("div"),
    editorProps: { handleScrollToSelection: () => true },
    extensions: [
      ...noteExtensions(),
      CitationNumbers,
      ClaimChecks,
      Collaboration.configure({ document: client.doc, field: MIND_CONTENT_FIELD }),
    ],
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  cleanup.push(() => editor.destroy());
  return editor;
}

/** The Note's sentences as a window opening it reads them: each check's mark and its Citations. */
async function reopened(core: Core, mindId: string) {
  const client = await connectToMind(core, mindId);
  return claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  }).claims.map((claim) => claim.shown);
}

const citationsIn = (editor: Editor): CitationAttributes[] => {
  const found: CitationAttributes[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs as CitationAttributes);
  });
  return found;
};

async function checked(paragraphs: (tides: Document) => JSONContent[], ids: readonly string[]) {
  stubDom();
  const calls: ModelCall[] = [];
  const setup = await setUpWithDocuments(checkingModel(PLANS, calls), [TIDES]);
  const [tides] = setup.documents;
  if (!tides) throw new Error("Tides.md wasn't added.");
  writeMind(setup.client, paragraphs(tides));
  await setup.client.settled();
  for (const id of ids) {
    await setup.core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId: id, offset: 0 },
      to: { blockId: id, offset: 1 },
    });
  }
  await setup.client.settled();
  const editor = editorOf(setup.client);
  return { ...setup, tides, calls, editor };
}

describe("Add as Citation on the card", { timeout: 30_000 }, () => {
  // protects=Add as Citation on the card keeps the check's mark and shows the ✓ at once and sends no request, its Citation says the check found it, Undo brings found elsewhere back, and the Note opened again reads each the same, in English and Chinese (#3019); fails_when=the ✓ waits on a new check, stays after Undo, or reads otherwise once the Note is opened again; no_claim=how the row is drawn.
  test.each([
    [SENTENCE, OTHER, LINE],
    [SENTENCE_ZH, OTHER_ZH, LINE_ZH],
  ])("%s", async (sentence, writerQuote, found) => {
    const { core, mind, client, calls, editor } = await checked(
      (tides) => [cited("s", sentence, citationOf(tides, writerQuote))],
      ["s"],
    );
    const [claim] = shownClaims(editor.state);
    if (!claim) throw new Error("The sentence has no check.");
    expect(claim.shown).toEqual({ state: "not-checked", reason: "found-elsewhere" });
    const asked = calls.length;

    expect(addAsCitation(editor, claim)).toBe(true);
    expect(shownClaims(editor.state)[0]?.shown).toEqual({ state: "supported" });
    expect(citationsIn(editor).map((each) => [each.quote, each.foundByCheck ?? null])).toEqual([
      [writerQuote, null],
      [expect.stringContaining(found), true],
    ]);
    expect(calls.length).toBe(asked);
    await client.settled();
    expect(await reopened(core, mind.id)).toEqual([{ state: "supported" }]);

    editor.commands.undo();
    expect(shownClaims(editor.state)[0]?.shown).toEqual({
      state: "not-checked",
      reason: "found-elsewhere",
    });
    expect(citationsIn(editor).map((each) => each.quote)).toEqual([writerQuote]);
    await client.settled();
    expect(await reopened(core, mind.id)).toEqual([
      { state: "not-checked", reason: "found-elsewhere" },
    ]);
    expect(calls.length).toBe(asked);
  });

  // protects=a sentence with no Citation of its writer keeps the ✓ and "+" its check gave, as it always did: the rule is for a ✓ beside a Citation whose words don't say it (#2739); fails_when=an uncited sentence the check backed shows no ✓; no_claim=none.
  test("a sentence with no Citation keeps its ✓", async () => {
    const { editor } = await checked(
      () => [
        { type: "paragraph", attrs: { id: "s" }, content: [{ type: "text", text: SENTENCE }] },
      ],
      ["s"],
    );
    expect(shownClaims(editor.state)[0]?.shown).toEqual({ state: "supported" });
  });
});

/** A part Supported on a Passage of Tides, as a check stores it. */
const part = (tides: Document, start: number, end: number, quote: string): ClaimCheckPart => ({
  span: { start, end },
  kind: "fact",
  verdict: "supported",
  evidence: [
    {
      passageId: `passage-${start}`,
      documentId: tides.id,
      documentName: tides.name,
      contentHash: tides.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote,
      check: "found",
      checkReason: null,
    },
  ],
  decidingEvidence: 0,
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
});

/** A sentence of two parts, each Supported on a Passage its writer's Citation doesn't quote. */
function twoParts(tides: Document): JSONContent {
  const first = "The tide turns twice a day";
  const sentence = `${first} and boats leave at dawn.`;
  const second = sentence.indexOf("boats");
  const check: ClaimCheckAttributes = {
    id: "two",
    request: "earlier",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: sentence,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [{ documentId: tides.id, contentHash: tides.contentHash }],
    excluded: [],
    checkedAt: "2026-11-13T09:00:00.000Z",
    parts: [part(tides, 0, first.length, LINE), part(tides, second, sentence.length - 1, DAWN)],
  };
  return {
    type: "paragraph",
    attrs: { id: "two" },
    content: [
      {
        type: "text",
        text: sentence.slice(0, -1),
        marks: [{ type: CLAIM_CHECK_MARK, attrs: check }],
      },
      citationOf(tides, OTHER),
      { type: "text", text: "." },
    ],
  };
}

describe("All together from the check's result line", { timeout: 30_000 }, () => {
  // protects=Add all adds every Passage the Note's checks found that its sentences don't cite, two for a sentence of two parts included, each after its own part's words, as one step: one Undo takes all of them back; a sentence edited since its check is left as it is, and one deleted since adds nothing (#3019); fails_when=Undo takes back only some, an edited sentence gets a Citation at the old words' place, a deleted one breaks the rest, or a request is sent; no_claim=the line's words.
  test("one Undo takes all of them back", async () => {
    const { client, calls, editor } = await checked(
      (tides) => [
        cited("en", SENTENCE, citationOf(tides, OTHER)),
        cited("zh", SENTENCE_ZH, citationOf(tides, OTHER_ZH)),
        twoParts(tides),
        cited("edited", SENTENCE, citationOf(tides, OTHER)),
        cited("deleted", SENTENCE, citationOf(tides, OTHER)),
      ],
      ["en", "zh", "edited", "deleted"],
    );
    const asked = calls.length;
    // The User edits one checked sentence and deletes another before adding them.
    const edited = shownClaims(editor.state).find((each) => each.place?.blockId === "edited");
    if (!edited) throw new Error("The edited sentence has no check.");
    editor.commands.insertContentAt(edited.sentence.from + "Tides".length, " always");
    editor.commands.command(({ tr, state }) => {
      state.doc.descendants((node, pos) => {
        if (node.attrs.id === "deleted") tr.delete(pos, pos + node.nodeSize);
      });
      return true;
    });
    const before = editor.getJSON();
    expect(
      shownClaims(editor.state).map((each) => [each.place?.blockId, each.shown.state]),
    ).toEqual([
      ["en", "not-checked"],
      ["zh", "not-checked"],
      ["two", "not-checked"],
      ["edited", "needs-recheck"],
    ]);
    expect(foundCitationInserts(editor.state).flatMap((each) => each.citations).length).toBe(4);

    expect(addFoundCitations(editor)).toBe(4);
    expect(
      shownClaims(editor.state).map((each) => [each.place?.blockId, each.shown.state]),
    ).toEqual([
      ["en", "supported"],
      ["zh", "supported"],
      ["two", "supported"],
      ["edited", "needs-recheck"],
    ]);
    const pieces = (index: number) => {
      const found: string[] = [];
      editor.state.doc.child(index).forEach((node) => {
        found.push(node.isText ? (node.text ?? "") : `[${String(node.attrs.quote)}]`);
      });
      return found;
    };
    // Each before its sentence's stop, as Add as Citation puts one.
    expect(pieces(0).at(-1)).toBe(".");
    expect(pieces(0).filter((each) => each.startsWith("["))).toHaveLength(2);
    expect(pieces(1).at(-1)).toBe("。");
    expect(pieces(1).filter((each) => each.startsWith("["))).toHaveLength(2);
    expect(pieces(2)).toEqual([
      "The tide turns twice a day",
      `[${LINE}]`,
      " and boats leave at dawn",
      `[${DAWN}]`,
      `[${OTHER}]`,
      ".",
    ]);
    expect(foundCitationInserts(editor.state)).toEqual([]);

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
    expect(foundCitationInserts(editor.state).flatMap((each) => each.citations).length).toBe(4);
    await client.settled();
    expect(calls.length).toBe(asked);
  });
});

describe("Supported, not yet cited, in its own words and counted apart", {
  timeout: 30_000,
}, () => {
  // protects=a sentence whose ✓ waits on its Passage reads "Supported, not yet cited" on its mark and card, has a row of its own in the check card, is never among the supported nor among those to check, and makes the Note's state "1 not yet cited", never Not checked nor the green Checked, in English and Chinese; once added, it is supported and the Note is Checked (#3019); fails_when=it is worded or counted as Not checked or as supported, or the Note shows Checked while it waits; no_claim=the row's look.
  test.each([
    ["en", "Supported, not yet cited", "1 supported, not yet cited", "1 not yet cited"],
    ["zh-CN", "有依据，尚未引用", "1 句有依据，尚未引用", "1 句尚未引用"],
  ] as const)("%s", async (language, heading, row, badge) => {
    const { editor } = await checked(
      (tides) => [
        cited("cited", SENTENCE, citationOf(tides, LINE)),
        cited("waiting", SENTENCE, citationOf(tides, OTHER)),
      ],
      ["cited", "waiting"],
    );
    const health = () =>
      noteHealth(editor.state.doc, {
        claims: shownClaims(editor.state),
        citationCheck: () => "found",
      });
    const waiting = shownClaims(editor.state).find((each) => each.place?.blockId === "waiting");
    if (!waiting) throw new Error("The sentence has no check.");
    expect(translate(language, checkStateKey(editor, waiting))).toBe(heading);
    expect(health()).toMatchObject({ supported: 1, toCheck: [], notYetCited: [waiting.from] });
    const rows = checkRows(health());
    expect(rows.map((each) => [each.row, each.places.length])).toEqual([
      ["supported", 1],
      ["notYetCited", 1],
    ]);
    expect(translate(language, "checks.row.notYetCited.one")).toBe(row);
    const state = noteStateOf(health());
    expect(state?.kind).toBe("not-yet-cited");
    expect(
      state && noteStateParts(state, (key, params) => translate(language, key, params), language),
    ).toEqual([badge]);

    expect(addFoundCitations(editor)).toBe(1);
    expect(health()).toMatchObject({ supported: 2, notYetCited: [] });
    expect(noteStateOf(health())?.kind).toBe("checked");
  });
});
