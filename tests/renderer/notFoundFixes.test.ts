import { type Editor, getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, Plugin, type Transaction } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckPart,
  FOOTNOTE_NODE,
  GENERATED_MARK,
} from "../../src/core/api";
import { citationNumbersPlugin } from "../../src/renderer/src/editor/citationNumbers";
import {
  claimPartRows,
  claimPlaces,
  claimSpans,
  type ShownClaim,
} from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  cantBeChecked,
  claimCheckShown,
  partFoundNothing,
  readClaimCheck,
  sentenceResultOf,
} from "../../src/shared/claimChecks";
import { type MessageKey, translate } from "../../src/shared/i18n";

vi.mock("../../src/renderer/src/core", () => ({ core: {} }));
vi.mock("../../src/renderer/src/editWithAi", () => ({
  resolveProposalsIn: vi.fn(),
  requestEdit: vi.fn(),
  useEdits: { getState: () => ({ pending: {} }) },
}));
vi.mock("../../src/renderer/src/modelInUse", () => ({ modelInUseOf: vi.fn() }));
vi.mock("../../src/renderer/src/i18n", () => ({ translateNow: (key: string) => key }));

const {
  checkStateKey,
  cutSentence,
  applyDocumentWording,
  keepAsView,
  offersFindSources,
  offersKeepAsView,
  offersNotFound,
  searchedLess,
  sentenceOf,
} = await import("../../src/renderer/src/unsupportedFixes");
const { useNotices } = await import("../../src/renderer/src/notices");
const { useUndo } = await import("../../src/renderer/src/undo");

const schema = getSchema(noteExtensions());

const paragraph = (text: string, ...inline: JSONContent[]): JSONContent => ({
  type: "paragraph",
  content: [...(text === "" ? [] : [{ type: "text", text }]), ...inline],
});

const citation: JSONContent = {
  type: CITATION_NODE,
  attrs: {
    passageId: null,
    documentId: "lease",
    documentName: "Lease",
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: "a quote",
    check: "found",
    checkReason: null,
  },
};

function editorHolding(content: JSONContent[], isEditable = true) {
  const undoStack: { step: unknown; before: EditorState }[] = [];
  const manager = {
    undoStack,
    redoStack: [],
    lastChange: 0,
    stopCapturing() {},
    addTrackedOrigin() {},
    on() {},
    off() {},
  };
  let state = EditorState.create({
    doc: schema.nodeFromJSON({ type: "doc", content }),
    plugins: [
      citationNumbersPlugin(),
      new Plugin({
        key: yUndoPluginKey,
        state: { init: () => ({ undoManager: manager }), apply: (_tr, value) => value },
      }),
    ],
  });
  const dispatched: Transaction[] = [];
  const editor = {
    get state() {
      return state;
    },
    get isDestroyed() {
      return false;
    },
    isEditable,
    view: {
      dispatch(tr: Transaction) {
        const before = state;
        state = state.apply(tr);
        undoStack.push({ step: {}, before });
        dispatched.push(tr);
      },
    },
    commands: {
      undo() {
        const undone = undoStack.pop();
        if (undone) state = undone.before;
        return true;
      },
    },
    on() {},
    off() {},
  } as unknown as Editor;
  return { editor, dispatched, undoStack };
}

/** The `index`th sentence of the `block`th top-level block, as a check of it would hold it. */
function claimOn(
  editor: Editor,
  block: number,
  index: number,
  over: {
    state?: string;
    citedCaseUnchecked?: boolean;
    evidence?: unknown;
    unsupported?: unknown;
    excluded?: unknown[];
  } = {},
): ShownClaim {
  let start = 0;
  for (let i = 0; i < block; i++) start += editor.state.doc.child(i).nodeSize;
  const node = editor.state.doc.child(block);
  const span = claimPlaces(node, start).sentences[index];
  if (!span) throw new Error("No such sentence.");
  const { from, to } = span;
  return {
    check: {
      citedCaseUnchecked: false,
      evidence: null,
      unsupported: null,
      excluded: [],
      scope: { folderId: null, widened: false },
      ...over,
    },
    from,
    to,
    sentence: { from, to, text: span.text },
    shown: { state: over.state ?? "unsupported" },
  } as unknown as ShownClaim;
}

const textsOf = (editor: Editor) => editor.state.doc.children.map((each) => each.textContent);

describe("Cut it", () => {
  test.each(["inside", "end"])(
    "uses the canonical cited sentence for searches and Cut it (%s)",
    (place) => {
      const content =
        place === "inside"
          ? paragraph(
              "Revenue ",
              citation,
              { type: "text", text: "rose 8%. Next stays." },
              citation,
            )
          : paragraph(
              "Revenue rose 8%.",
              citation,
              { type: "text", text: " Next stays." },
              citation,
            );
      const { editor, dispatched } = editorHolding([content]);
      const before = editor.state.doc.toJSON();
      const claim = claimOn(editor, 0, 0);
      expect(sentenceOf(editor, claim)).toBe("Revenue rose 8%.");
      cutSentence(editor, claim);
      expect(dispatched).toHaveLength(1);
      expect(textsOf(editor)).toEqual(["Next stays."]);
      expect(editor.state.doc.textContent).not.toContain("Revenue");
      let citations = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === CITATION_NODE) citations++;
      });
      expect(citations).toBe(1);
      editor.commands.undo();
      expect(editor.state.doc.toJSON()).toEqual(before);
    },
  );
  test("cuts a whole final cited paragraph and its Citation, with Undo", () => {
    const { editor, dispatched } = editorHolding([paragraph("Revenue rose 8%.", citation)]);
    const before = editor.state.doc.toJSON();
    cutSentence(editor, claimOn(editor, 0, 0));
    expect(dispatched).toHaveLength(1);
    expect(textsOf(editor)).toEqual([""]);
    expect(editor.state.doc.toJSON()).not.toEqual(before);
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
  test.each([
    ["the first sentence", 0, ["Two dogs. Three birds."]],
    ["a sentence in the middle", 1, ["One cat. Three birds."]],
    ["the last sentence", 2, ["One cat. Two dogs."]],
  ])("takes out %s with the space that kept it from its neighbour", (_name, index, expected) => {
    const { editor, dispatched } = editorHolding([paragraph("One cat. Two dogs. Three birds.")]);
    cutSentence(editor, claimOn(editor, 0, index));
    expect(textsOf(editor)).toEqual(expected);
    expect(dispatched).toHaveLength(1);
  });

  test("takes out a sentence of Chinese, which has no spaces", () => {
    const { editor } = editorHolding([paragraph("猫在睡觉。狗在跑步。鸟在唱歌。")]);
    cutSentence(editor, claimOn(editor, 0, 1));
    expect(textsOf(editor)).toEqual(["猫在睡觉。鸟在唱歌。"]);
  });

  test("takes out the spaces around the last sentence of a paragraph that ends in one", () => {
    const { editor } = editorHolding([paragraph("One cat. Two dogs. ")]);
    cutSentence(editor, claimOn(editor, 0, 1));
    expect(textsOf(editor)).toEqual(["One cat."]);
  });

  test("takes out the paragraph when the sentence is all it says", () => {
    const { editor } = editorHolding([paragraph("One cat."), paragraph("Two dogs.")]);
    cutSentence(editor, claimOn(editor, 0, 0));
    expect(textsOf(editor)).toEqual(["Two dogs."]);
  });

  test("leaves one empty paragraph when it was the only one", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    cutSentence(editor, claimOn(editor, 0, 0));
    expect(textsOf(editor)).toEqual([""]);
  });

  test("takes out the list item when the sentence is all it says", () => {
    const item = (text: string): JSONContent => ({
      type: "listItem",
      content: [paragraph(text)],
    });
    const { editor } = editorHolding([
      { type: "bulletList", content: [item("One cat."), item("Two dogs.")] },
    ]);
    const list = editor.state.doc.child(0);
    const first = list.child(0);
    const from = 3;
    const to = from + first.textContent.length;
    cutSentence(editor, {
      check: {},
      from,
      to,
      sentence: { from, to, text: first.textContent },
      shown: { state: "unsupported" },
    } as unknown as ShownClaim);
    expect(editor.state.doc.child(0).childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("Two dogs.");
  });
});

describe("a sentence that cites nothing and nothing backs", () => {
  test("is offered Cut it and Keep as my view", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(true);
  });

  test("is not offered them when the sentence has a Citation, or a verdict other than unsupported", () => {
    const { editor } = editorHolding([paragraph("One cat.", citation), paragraph("Two dogs.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(false);
    expect(offersNotFound(editor, claimOn(editor, 1, 0, { state: "supported" }))).toBe(false);
    expect(offersNotFound(editor, claimOn(editor, 1, 0, { state: "contradicted" }))).toBe(false);
  });

  test("is not offered them for a court decision no Document holds, which has a card of its own", () => {
    const { editor } = editorHolding([paragraph("One cat.")]);
    expect(offersNotFound(editor, claimOn(editor, 0, 0, { citedCaseUnchecked: true }))).toBe(false);
  });

  test("is not offered them in a Mind that can't be edited", () => {
    const { editor } = editorHolding([paragraph("One cat.")], false);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(false);
  });

  test("a sentence that names an Analysis's figure as another's is offered no Cut and no search: its fix is the User's edit (#2378)", () => {
    const { editor } = editorHolding([paragraph("North's total amount is 9,450.")]);
    const misnamed = claimOn(editor, 0, 0, {
      unsupported: {
        kind: "analysis-name",
        reason: "The sentence doesn’t say this figure is Total amount, South",
      },
    });
    expect(offersNotFound(editor, misnamed)).toBe(false);
    expect(offersFindSources(editor, misnamed)).toBe(false);
    expect(offersNotFound(editor, claimOn(editor, 0, 0))).toBe(true);
  });
});

describe("Find sources is offered where searching papers and the web could help", () => {
  test("for an unsupported sentence it can quote nothing for, unless it has a Citation or a court decision", () => {
    const { editor } = editorHolding([
      paragraph("One cat.", citation),
      paragraph("Two dogs."),
      paragraph("Three birds."),
    ]);
    expect(offersFindSources(editor, claimOn(editor, 1, 0))).toBe(true);
    expect(offersFindSources(editor, claimOn(editor, 0, 0))).toBe(false);
    expect(offersFindSources(editor, claimOn(editor, 2, 0, { evidence: { quote: "x" } }))).toBe(
      false,
    );
    expect(offersFindSources(editor, claimOn(editor, 2, 0, { citedCaseUnchecked: true }))).toBe(
      false,
    );
  });

  test("for an own-workings sentence with a Citation, whose card has no cited-sentence fixes", () => {
    const { editor } = editorHolding([paragraph("One cat.", citation)]);
    expect(
      offersFindSources(editor, claimOn(editor, 0, 0, { excluded: [{ reason: "own-workings" }] })),
    ).toBe(true);
  });
});

describe("The heading of a sentence's check (#1608)", () => {
  const quoted = { quote: "Pets up to 15 kg." };
  test("is Not found for a sentence with no Citation that nothing in the scope states, even in a Mind that can't be edited", () => {
    for (const editable of [true, false]) {
      const { editor } = editorHolding([paragraph("One cat.")], editable);
      expect(checkStateKey(editor, claimOn(editor, 0, 0))).toBe("claim.state.notFound");
    }
  });

  test("is Unsupported where Passages were found that don't back it, or the sentence has a card of its own", () => {
    const { editor } = editorHolding([paragraph("One cat.", citation), paragraph("Two dogs.")]);
    const unsupported = [
      claimOn(editor, 0, 0),
      claimOn(editor, 1, 0, { evidence: quoted }),
      claimOn(editor, 1, 0, { unsupported: { covered: "pets", uncovered: "cats", quoted } }),
      claimOn(editor, 1, 0, {
        unsupported: { reason: "Pets up to 15 kg.", covered: null, uncovered: null, found: true },
      }),
      claimOn(editor, 1, 0, { excluded: [{ reason: "own-workings" }] }),
      claimOn(editor, 1, 0, { citedCaseUnchecked: true }),
    ];
    for (const claim of unsupported) {
      expect(checkStateKey(editor, claim)).toBe("claim.state.unsupported");
    }
    expect(checkStateKey(editor, claimOn(editor, 1, 0, { state: "supported" }))).toBe(
      "claim.state.supported",
    );
  });
});

/** A Citation a part's check found, as `checkedCitation` reads one. */
const partCitation = {
  passageId: "passage-1",
  documentId: "lease",
  documentName: "Lease",
  contentHash: "v1",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  quote: "a quote",
  check: "found" as const,
  checkReason: null,
};

/** A part as the core writes one into a check's mark (#2002). */
const partOf = (
  start: number,
  end: number,
  verdict: "supported" | "unsupported" | "contradicted" | "not-checked",
  over: Record<string, unknown> = {},
) => ({
  span: { start, end },
  kind: "fact",
  verdict,
  evidence: [],
  says: null,
  unsupported: null,
  calculation: null,
  reason: verdict === "not-checked" ? "failed" : null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
  ...over,
});

/** The card a sentence with parts shows, read from its mark and shown as the window shows it. */
function partsClaim(
  editor: Editor,
  block: number,
  index: number,
  parts: Record<string, unknown>[],
  now?: string,
): ShownClaim {
  let start = 0;
  for (let i = 0; i < block; i++) start += editor.state.doc.child(i).nodeSize;
  const node = editor.state.doc.child(block);
  const span = claimPlaces(node, start).sentences[index];
  if (!span) throw new Error("No such sentence.");
  const check = readClaimCheck({
    id: "parts",
    request: "",
    action: "check-against-documents",
    state: "supported",
    text: span.text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-02T14:25:00.000Z",
    parts,
  });
  if (!check) throw new Error("The parts check didn't read.");
  return {
    check,
    from: span.from,
    to: span.to,
    sentence: { from: span.from, to: span.to, text: span.text },
    shown: claimCheckShown(check, {
      text: now ?? span.text,
      versions: new Map(),
      folderId: null,
      scope: null,
    }),
  } as unknown as ShownClaim;
}

const HEAD_WORDS = {
  en: {
    supported: "Supported",
    unsupported: "Needs a look · Unsupported",
    contradicted: "Needs a look · Contradicted",
    "not-checked": "Not checked",
    "needs-recheck": "Needs a look · Needs re-check",
    notFound: "Needs a look · Not found",
  },
  "zh-CN": {
    supported: "有依据",
    unsupported: "需要留意：无依据",
    contradicted: "需要留意：与文档矛盾",
    "not-checked": "未核对",
    "needs-recheck": "需要留意：需重新核对",
    notFound: "需要留意：未找到",
  },
} as const;

/** A part's row label, as the row draws it: Not found when it found nothing. */
const rowWord = (language: "en" | "zh-CN", part: { verdict: string | null }) =>
  translate(
    language,
    (part.verdict === "unsupported" &&
    partFoundNothing(part as Parameters<typeof partFoundNothing>[0])
      ? "claim.state.notFound"
      : `claim.state.${part.verdict}`) as MessageKey,
  );

// protects=#2313: when no part found anything, the header and every row say Not found, and the record counts it so, in English and Chinese; fails_when=a part that found nothing is called Unsupported, or the header differs from its rows; no_claim=what the card's body offers.
test.each(["en", "zh-CN"] as const)(
  "all parts found nothing: the header, the rows and the count say Not found in %s",
  (language) => {
    const { editor } = editorHolding([paragraph("Revenue rose and costs fell")]);
    const claim = partsClaim(editor, 0, 0, [
      partOf(0, 12, "unsupported"),
      partOf(17, 27, "unsupported"),
    ]);
    const words = HEAD_WORDS[language];
    expect(translate(language, checkStateKey(editor, claim))).toBe(words.notFound);
    const rows = claimPartRows(claim.check) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((part) => rowWord(language, part))).toEqual([words.notFound, words.notFound]);
    expect(sentenceResultOf(claim.shown, claim.check, 0)).toBe("notFound");
  },
);

// protects=#2313: one part that found a Passage keeps the sentence and that row Unsupported, while the part that found nothing says Not found, in English and Chinese; fails_when=the sentence reads Not found though something was found; no_claim=the row's quote and its Add as Citation (claimPartsCoverage.test.ts).
test.each(["en", "zh-CN"] as const)(
  "a part that found a Passage is Unsupported beside a part that found nothing in %s",
  (language) => {
    const { editor } = editorHolding([paragraph("Revenue rose and costs fell")]);
    const claim = partsClaim(editor, 0, 0, [
      partOf(0, 12, "unsupported", { evidence: [partCitation] }),
      partOf(17, 27, "unsupported"),
    ]);
    const words = HEAD_WORDS[language];
    expect(translate(language, checkStateKey(editor, claim))).toBe(words.unsupported);
    expect(sentenceResultOf(claim.shown, claim.check, 0)).toBe("unsupported");
    const rows = claimPartRows(claim.check) ?? [];
    expect(rows.map((part) => rowWord(language, part))).toEqual([
      words.unsupported,
      words.notFound,
    ]);
  },
);

// protects=#2313: a part whose check read a Passage and judged it keeps Unsupported even with no quote; fails_when=a read Passage is called found nothing; no_claim=the same part with no Passage found.
test.each(["en", "zh-CN"] as const)(
  "a part that read a Passage stays Unsupported with no quote in %s",
  (language) => {
    const { editor } = editorHolding([paragraph("Revenue rose and costs fell")]);
    const judged = partOf(17, 27, "unsupported", {
      unsupported: {
        reason: "The lease says costs rose.",
        covered: null,
        uncovered: null,
        found: true,
      },
    });
    const empty = partOf(17, 27, "unsupported");
    const claim = partsClaim(editor, 0, 0, [
      partOf(0, 12, "supported", { evidence: [partCitation] }),
      judged,
    ]);
    const part = (each: unknown) => each as Parameters<typeof partFoundNothing>[0];
    const words = HEAD_WORDS[language];
    expect(partFoundNothing(part(claim.check.parts?.[1]))).toBe(false);
    expect(rowWord(language, part(claim.check.parts?.[1]))).toBe(words.unsupported);
    expect(partFoundNothing(part(empty))).toBe(true);
    expect(rowWord(language, part(empty))).toBe(words.notFound);
  },
);

// protects=#2313: one part Supported keeps the sentence Unsupported, never Not found, in English and Chinese; fails_when=the header or a supported row reads Not found; no_claim=the supported row's Citation.
test.each(["en", "zh-CN"] as const)(
  "one part Supported keeps the sentence Unsupported in %s",
  (language) => {
    const { editor } = editorHolding([paragraph("Revenue rose and costs fell")]);
    const claim = partsClaim(editor, 0, 0, [
      partOf(0, 12, "supported", { evidence: [partCitation] }),
      partOf(17, 27, "unsupported"),
    ]);
    const words = HEAD_WORDS[language];
    expect(translate(language, checkStateKey(editor, claim))).toBe(words.unsupported);
    expect(sentenceResultOf(claim.shown, claim.check, 0)).toBe("unsupported");
    const rows = claimPartRows(claim.check) ?? [];
    expect(rows.map((part) => rowWord(language, part))).toEqual([words.supported, words.notFound]);
  },
);

// protects=#2313: the header and both rows agree in every state a parts card shows, in English and Chinese; fails_when=one state names a result the rows do not; no_claim=what the card's body offers in each state.
test.each(["en", "zh-CN"] as const)(
  "the header and both rows agree for every state a parts card shows, in %s",
  (language) => {
    const words = HEAD_WORDS[language];
    const both = (verdict: "supported" | "unsupported" | "contradicted" | "not-checked") => [
      partOf(0, 12, verdict, verdict === "supported" ? { evidence: [partCitation] } : {}),
      partOf(17, 27, verdict, verdict === "supported" ? { evidence: [partCitation] } : {}),
    ];
    const CASES = [
      {
        name: "supported",
        parts: both("supported"),
        header: "supported",
        rows: ["supported", "supported"],
      },
      {
        name: "not found",
        parts: both("unsupported"),
        header: "notFound",
        rows: ["notFound", "notFound"],
      },
      {
        name: "contradicted",
        parts: [
          partOf(0, 12, "contradicted", { evidence: [partCitation] }),
          partOf(17, 27, "supported", { evidence: [partCitation] }),
        ],
        header: "contradicted",
        rows: ["contradicted", "supported"],
      },
      {
        name: "not checked",
        parts: [
          partOf(0, 12, "not-checked"),
          partOf(17, 27, "supported", { evidence: [partCitation] }),
        ],
        header: "not-checked",
        rows: ["not-checked", "supported"],
      },
      {
        name: "can't be checked",
        parts: [
          partOf(0, 12, "not-checked", { reason: "kept-inside" }),
          partOf(17, 27, "not-checked", { reason: "kept-inside" }),
        ],
        header: "not-checked",
        rows: ["not-checked", "not-checked"],
        uncheckable: true,
      },
      {
        name: "needs re-check",
        parts: both("supported"),
        header: "needs-recheck",
        rows: ["needs-recheck", "needs-recheck"],
      },
    ] as const;
    for (const each of CASES) {
      const { editor } = editorHolding([paragraph("Revenue rose and costs fell")]);
      const claim = partsClaim(
        editor,
        0,
        0,
        [...each.parts],
        each.name === "needs re-check" ? "Changed words." : undefined,
      );
      expect(translate(language, checkStateKey(editor, claim)), each.name).toBe(words[each.header]);
      const rows = claimPartRows(claim.check) ?? [];
      expect(rows, each.name).toHaveLength(2);
      expect(
        rows.map((part) =>
          claim.shown.state === "needs-recheck"
            ? translate(language, "claim.state.needs-recheck")
            : rowWord(language, part),
        ),
        each.name,
      ).toEqual(each.rows.map((row) => words[row]));
      if ("uncheckable" in each && each.uncheckable)
        expect(cantBeChecked(claim.shown), each.name).toBe(true);
    }
  },
);

describe("Keep as my view on a contradicted sentence", () => {
  beforeEach(() => {
    useUndo.setState({ done: [], undone: [], line: null, running: null });
  });

  /** The check of the first paragraph's marked words, as a contradicted card holds it. */
  const contradictedIn = (editor: Editor): ShownClaim => ({
    ...(claimsIn(editor).c as ShownClaim),
    shown: { state: "contradicted" },
  });

  const contradictedText = (text: string): JSONContent => ({
    type: "text",
    text,
    marks: [checkMark("c", text, "contradicted")],
  });

  const checkAttrsOf = (editor: Editor) => {
    const found: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (mark.type.name === CLAIM_CHECK_MARK) found.push(mark.attrs);
      }
    });
    return found;
  };

  const markTypesOf = (editor: Editor) => {
    const found: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText) for (const mark of node.marks) found.push(mark.type.name);
    });
    return found;
  };

  test("is offered for a contradicted sentence alone, in a Mind that can be edited", () => {
    const { editor } = editorHolding([
      { type: "paragraph", content: [contradictedText("Two dogs.")] },
    ]);
    expect(offersKeepAsView(editor, contradictedIn(editor))).toBe(true);
    for (const state of ["supported", "unsupported", "not-checked", "needs-recheck"] as const) {
      const claim = { ...contradictedIn(editor), shown: { state } } as ShownClaim;
      expect(offersKeepAsView(editor, claim)).toBe(false);
    }
    const { editor: fixed } = editorHolding(
      [{ type: "paragraph", content: [contradictedText("Two dogs.")] }],
      false,
    );
    expect(offersKeepAsView(fixed, contradictedIn(fixed))).toBe(false);
  });

  test("keeps the words as the User's own view, and one Undo brings the contradicted mark back", async () => {
    const { editor, dispatched } = editorHolding([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Two dogs.",
            marks: [checkMark("c", "Two dogs.", "contradicted"), { type: GENERATED_MARK }],
          },
        ],
      },
    ]);
    const claim = contradictedIn(editor);
    keepAsView(editor, claim);

    expect(dispatched).toHaveLength(1);
    expect(editor.state.doc.textContent).toBe("Two dogs.");
    expect(markTypesOf(editor)).toEqual([CLAIM_CHECK_MARK]);
    const attrs = checkAttrsOf(editor)[0] as Record<string, unknown>;
    expect(attrs.id).toBe("c");
    expect(attrs.kept).toBe(true);
    const check = readClaimCheck(attrs);
    expect(
      check &&
        claimCheckShown(check, { text: "Two dogs.", versions: null, folderId: null, scope: null }),
    ).toEqual({ state: "kept" });

    const [change] = useUndo.getState().done;
    expect(
      change?.said(
        (key) => key,
        (name) => name,
      ),
    ).toBe("claim.keptAsView");
    await useUndo.getState().undo();
    expect(editor.state.doc.textContent).toBe("Two dogs.");
    expect(checkAttrsOf(editor)[0]?.kept).toBeNull();
    expect(markTypesOf(editor).sort()).toEqual([CLAIM_CHECK_MARK, GENERATED_MARK].sort());
    const restored = readClaimCheck(checkAttrsOf(editor)[0]);
    expect(
      restored &&
        claimCheckShown(restored, {
          text: "Two dogs.",
          versions: null,
          folderId: null,
          scope: null,
        }),
    ).toEqual({ state: "contradicted" });
  });
});

describe("Search all Documents is offered while the check looked in less than every Document", () => {
  const scoped = (scope: Record<string, unknown>) =>
    ({ check: { scope } }) as unknown as ShownClaim;
  const chosen = { folderIds: [], tagIds: [], documentIds: ["lease"] };

  test("in the Mind's Folder, or in the scope the User chose", () => {
    expect(searchedLess(scoped({ folderId: "f1", widened: false }))).toBe(true);
    expect(searchedLess(scoped({ folderId: null, widened: false, chosen }))).toBe(true);
    expect(searchedLess(scoped({ folderId: "f1", widened: false, chosen }))).toBe(true);
  });

  test("not once it looked in every Document, or when it had no Folder", () => {
    expect(searchedLess(scoped({ folderId: "f1", widened: true }))).toBe(false);
    expect(searchedLess(scoped({ folderId: null, widened: false }))).toBe(false);
  });
});

/** A paragraph's pieces as the editor holds them: its text nodes, and a footnote as "[its text]". */
const shapeOf = (editor: Editor, block = 0) => {
  const pieces: string[] = [];
  editor.state.doc.child(block).forEach((child) => {
    pieces.push(child.isText ? (child.text ?? "") : `[${child.textContent}]`);
  });
  return pieces;
};

const checkMark = (id: string, text: string, state = "unsupported") => ({
  type: CLAIM_CHECK_MARK,
  attrs: {
    id,
    request: "request-1",
    action: "check-against-documents",
    state,
    text,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-23T09:00:00.000Z",
  },
});

/** Text with a check's mark on it, or a footnote holding words. */
const marked = (id: string, text: string): JSONContent => ({
  type: "text",
  text,
  marks: [checkMark(id, text)],
});
const note = (text: string): JSONContent => ({
  type: FOOTNOTE_NODE,
  content: [{ type: "text", text }],
});
const plain = (text: string): JSONContent => ({ type: "text", text });

/** The checks of the document as the editor finds them, ready to cut by. */
function claimsIn(editor: Editor): Record<string, ShownClaim> {
  return Object.fromEntries(
    claimSpans(editor.state.doc).map((span) => [
      span.check.id,
      { ...span, shown: { state: "unsupported" } } as unknown as ShownClaim,
    ]),
  );
}

describe("Cut it in a paragraph with footnotes", () => {
  const cases: [string, JSONContent[], string, string[]][] = [
    [
      "a footnote before the sentence",
      [
        plain("Whales sing in the bay."),
        note("See p. 4."),
        plain(" "),
        marked("c", "Seals rest on the sandbanks."),
      ],
      "c",
      ["Whales sing in the bay.", "[See p. 4.]"],
    ],
    [
      "a footnote after the sentence, which goes with it",
      [
        marked("c", "Whales sing in the bay."),
        note("See p. 4."),
        plain(" Seals rest on the sandbanks."),
      ],
      "c",
      ["Seals rest on the sandbanks."],
    ],
    [
      "a footnote one sentence further back",
      [
        plain("Whales sing."),
        note("See p. 4."),
        plain(" Seals rest on the sandbanks. "),
        marked("c", "Gulls follow the boats."),
      ],
      "c",
      ["Whales sing.", "[See p. 4.]", " Seals rest on the sandbanks."],
    ],
    [
      "two footnotes before the sentence",
      [
        plain("One cat."),
        note("First."),
        plain(" Two dogs."),
        note("Second."),
        plain(" "),
        marked("c", "Three birds."),
      ],
      "c",
      ["One cat.", "[First.]", " Two dogs.", "[Second.]"],
    ],
    [
      "a sentence between two footnotes",
      [
        plain("One cat."),
        note("First."),
        plain(" "),
        marked("c", "Two dogs."),
        note("Second."),
        plain(" Three birds."),
      ],
      "c",
      ["One cat.", "[First.]", " Three birds."],
    ],
    [
      "a footnote at the end of the paragraph",
      [marked("c", "One cat."), plain(" Two dogs."), note("See p. 4.")],
      "c",
      ["Two dogs.", "[See p. 4.]"],
    ],
    [
      "the sentence before a footnote at the end of the paragraph",
      [plain("One cat. "), marked("c", "Two dogs."), note("See p. 4.")],
      "c",
      ["One cat."],
    ],
  ];

  test.each(cases)("takes out exactly the sentence with %s", (_name, content, id, expected) => {
    const { editor, dispatched } = editorHolding([{ type: "paragraph", content }]);
    const claim = claimsIn(editor)[id] as ShownClaim;
    expect(editor.state.doc.textBetween(claim.from, claim.to, "", "")).toBe(
      content.flatMap((each) => (each.marks ? [each.text ?? ""] : [])).join(""),
    );
    cutSentence(editor, claim);
    expect(shapeOf(editor)).toEqual(expected);
    expect(dispatched).toHaveLength(1);
  });

  test("puts every check on its own words, however many footnotes come before it", () => {
    const { editor } = editorHolding([
      {
        type: "paragraph",
        content: [
          marked("a", "One cat."),
          note("First."),
          plain(" "),
          marked("b", "Two dogs."),
          note("Second."),
          plain(" "),
          marked("c", "Three birds."),
        ],
      },
    ]);
    const claims = claimsIn(editor);
    for (const [id, words] of [
      ["a", "One cat."],
      ["b", "Two dogs."],
      ["c", "Three birds."],
    ] as const) {
      const claim = claims[id] as ShownClaim;
      expect(editor.state.doc.textBetween(claim.from, claim.to)).toBe(words);
      expect(claim.sentence.text.startsWith(words)).toBe(true);
      expect(
        editor.state.doc.textBetween(claim.sentence.from, claim.sentence.from + words.length),
      ).toBe(words);
    }
  });

  test("cuts nothing, and says so, when the words at the sentence's place aren't the sentence", () => {
    const { editor, dispatched } = editorHolding([
      { type: "paragraph", content: [plain("One cat. "), marked("c", "Two dogs.")] },
    ]);
    const claim = claimsIn(editor).c as ShownClaim;
    const drifted = {
      ...claim,
      sentence: { ...claim.sentence, from: claim.sentence.from - 3, to: claim.sentence.to - 3 },
    } as ShownClaim;
    const before = useNotices.getState().errors.length;
    cutSentence(editor, drifted);
    expect(dispatched).toHaveLength(0);
    expect(shapeOf(editor)).toEqual(["One cat. ", "Two dogs."]);
    expect(useNotices.getState().errors).toHaveLength(before + 1);
    expect(useNotices.getState().errors.at(-1)?.message).toBe("claim.cutSentence.moved");
  });
});

describe("Use the Document's wording for one forecast part", () => {
  function forecast(end: number): ClaimCheckPart {
    return {
      span: { start: 0, end },
      kind: "fact",
      verdict: "unsupported",
      evidence: [],
      says: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
      unsupported: {
        kind: "forecast-certainty",
        reason: "forecast",
        covered: null,
        uncovered: null,
        quoted: {
          passageId: "p",
          documentId: "d",
          documentName: "Forecast",
          contentHash: "v1",
          quote: "Revenue is forecast to reach £10m",
          pageFrom: 1,
          pageTo: 1,
          location: null,
          check: "found",
          checkReason: null,
        },
      },
    };
  }

  test("changes the second identical fact only, keeps its adjacent Citation and opinion, and Undo restores all", () => {
    const fact = "Revenue will reach £10m";
    const holding = editorHolding([
      paragraph(`${fact}. ${fact}`, citation, {
        type: "text",
        text: ", and we think the deal is risky.",
      }),
    ]);
    const { editor, dispatched } = holding;
    const before = editor.state.doc;
    const claim = claimOn(editor, 0, 1, { state: "unsupported" });
    claim.check.text = claim.sentence.text;
    applyDocumentWording(editor, claim, forecast(fact.length));
    expect(dispatched).toHaveLength(1);
    expect(editor.state.doc.textContent).toBe(
      `${fact}. Revenue is forecast to reach £10m, and we think the deal is risky.`,
    );
    let citations = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === CITATION_NODE) citations++;
    });
    expect(citations).toBe(1);
    expect(editor.state.doc.toJSON()).not.toEqual(before.toJSON());
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before.toJSON());
  });

  test("retains the old check as needing a recheck after replacing all its text", () => {
    const sentence = "Revenue will reach £10m.";
    const { editor } = editorHolding([
      {
        type: "paragraph",
        content: [
          { type: "text", text: sentence, marks: [checkMark("forecast", sentence, "unsupported")] },
        ],
      },
    ]);
    const span = claimSpans(editor.state.doc)[0];
    if (!span) throw new Error("The forecast check was not read.");
    applyDocumentWording(
      editor,
      { ...span, shown: { state: "unsupported" } },
      forecast(sentence.length),
    );
    const retained = claimSpans(editor.state.doc)[0]?.check;
    expect(retained?.id).toBe("forecast");
    expect(
      retained &&
        claimCheckShown(retained, {
          text: editor.state.doc.textContent,
          versions: null,
          folderId: null,
          scope: null,
        }),
    ).toEqual({ state: "needs-recheck", why: "edited" });
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe(sentence);
  });

  test("does nothing if the sentence moved or changed", () => {
    const { editor, dispatched } = editorHolding([paragraph("Revenue will reach £10m.")]);
    const claim = claimOn(editor, 0, 0, { state: "unsupported" });
    claim.check.text = claim.sentence.text;
    applyDocumentWording(
      editor,
      { ...claim, sentence: { ...claim.sentence, text: "Revenue will reach £12m." } },
      forecast(22),
    );
    expect(dispatched).toHaveLength(0);
    expect(useNotices.getState().errors.at(-1)?.message).toBe("error.check.partChanged");
  });
});
