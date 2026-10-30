import { randomUUID } from "node:crypto";
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser } from "linkedom";
import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { citationSentences } from "../../src/core/answers/checks/sentences";
import {
  type CitationAttributes,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type ClaimFacet,
  type EditAction,
  type EditCause,
  type EditWithAiInput,
  type EditWithAiResult,
  MIND_CONTENT_FIELD,
  MIND_PROPOSAL_REQUESTS_FIELD,
} from "../../src/core/api";
import { editPrompt } from "../../src/core/edits/prompt";
import { proposeRewrite, readSelection } from "../../src/core/proposals/write";
import { selectionForEdit } from "../../src/renderer/src/editor/editSelection";
import { citationAttributesOf } from "../../src/shared/citations";
import { checkWithParts, partCitations } from "../../src/shared/claimParts";
import {
  proposalRequestOf,
  recordProposalRequest,
  resolveProposals,
} from "../../src/shared/proposals";
import { namePartCitations } from "../../src/shared/signOffs";
import { editorExtensions, headlessEditor } from "../helpers/editor";
import { readMind } from "../helpers/minds";

const PERIOD = { start: "2024-03-01", end: "2024-03-31", precision: "month" } as const;
const CASES = [
  {
    language: "en",
    kind: "source",
    literal: "According to Residents",
    claim: "According to Residents, Nora lives in Oslo.",
    fact: "Nora lives in Oslo.",
    replacement: "According to the Register",
    corrected: "According to the Register[1], Nora lives in Oslo.",
    source: "Register",
    quote: "Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    literal: "根据旧名册",
    claim: "根据旧名册，诺拉住在奥斯陆。",
    fact: "诺拉住在奥斯陆。",
    replacement: "根据居民登记",
    corrected: "根据居民登记[1]，诺拉住在奥斯陆。",
    source: "居民登记",
    quote: "诺拉住在奥斯陆。",
  },
  {
    language: "en",
    kind: "time",
    literal: "Currently",
    claim: "Currently, the rate is 5%.",
    fact: "the rate is 5%.",
    replacement: "In March 2024",
    corrected: "In March 2024[1], the rate was 5%.",
    source: "Facility letter",
    quote: "As at March 2024, the rate was 5%.",
  },
  {
    language: "zh-CN",
    kind: "time",
    literal: "目前",
    claim: "目前，利率为5%。",
    fact: "利率为5%。",
    replacement: "2024 年 3 月",
    corrected: "2024 年 3 月[1]，利率为5%。",
    source: "贷款函",
    quote: "截至2024年3月，利率为5%。",
  },
] as const;

function fixture(row: (typeof CASES)[number], inline: boolean, action?: EditAction) {
  const receipt: CitationAttributes = {
    documentId: randomUUID(),
    documentName: row.source,
    passageId: randomUUID(),
    contentHash: "a".repeat(64),
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    quote: row.quote,
    check: "found",
    checkReason: null,
  };
  const facet: ClaimFacet =
    row.kind === "time" ? { kind: "time", period: PERIOD } : { kind: "source" };
  const checked = (words: string, extra: Partial<ClaimCheckPart> = {}): ClaimCheckPart => {
    const start = row.claim.indexOf(words);
    if (start < 0) throw new Error("The fixture literal is missing.");
    return {
      span: { start, end: start + words.length },
      kind: "fact",
      verdict: "supported",
      evidence: [receipt],
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
      ...extra,
    };
  };
  const parts = namePartCitations([
    checked(row.literal, {
      facet,
      verdict: "unsupported",
      unsupported: {
        reason: "The checked Document gives another attribution.",
        covered: null,
        uncovered: null,
        found: true,
      },
    }),
    checked(row.fact),
  ]);
  const owned = parts[0]?.evidence[0];
  if (!owned || typeof owned.id !== "string")
    throw new Error("The canonical receipt was not named.");
  const check: ClaimCheckAttributes = checkWithParts(
    {
      id: randomUUID(),
      request: randomUUID(),
      action: "check-against-documents",
      state: "unsupported",
      text: row.claim,
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
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
    parts,
  );
  const blockId = randomUUID();
  const marked = (text: string): JSONContent => ({
    type: "text",
    text,
    marks: [{ type: "claimCheck", attrs: check }],
  });
  const content = inline
    ? [
        marked(row.literal),
        { type: "citation", attrs: owned },
        marked(row.claim.slice(row.literal.length)),
      ]
    : [marked(row.claim)];
  const editor = headlessEditor();
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", attrs: { id: blockId }, content }],
  });
  editor.commands.setTextSelection({ from: 1, to: 1 + row.literal.length + (inline ? 1 : 0) });
  const selected = selectionForEdit(editor.state);
  if (!selected) throw new Error("The editor did not select the literal qualifier.");
  const input: EditWithAiInput = {
    requestId: randomUUID(),
    mindId: randomUUID(),
    action: action ?? "improve",
    from: selected.from,
    to: selected.to,
    text: selected.text,
  };
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = prosemirrorToYXmlFragment(
    editor.state.doc,
    doc.getXmlFragment(MIND_CONTENT_FIELD),
  );
  const read = readSelection(blocks, input.from, input.to, action);
  if (!read.ok) throw new Error(`The Core could not read the selected qualifier: ${read.reason}`);
  return { doc, blocks, input, selection: read.selection, owned, parts, check };
}

test.each(CASES)("$language $kind targets one row while editing its full assertion", (row) => {
  const { doc, blocks, input, owned, parts, check } = fixture(row, false, "follow-citation");
  const first = parts[0];
  if (!first) throw new Error("The fixture has no qualifier row.");
  const part = { id: check.id, span: first.span };
  const read = readSelection(
    blocks,
    input.from,
    { ...input.to, offset: row.claim.length },
    input.action,
    part,
  );
  if (!read.ok) throw new Error(`The full assertion could not be read: ${read.reason}`);
  expect.soft(read.selection.plain).toBe(row.claim);
  expect.soft(read.selection.citations.map((citation) => citation.id)).toEqual([owned.id]);
  const instruction =
    row.kind === "source"
      ? `Use ${owned.documentName} as the attribution.`
      : "State March 2024 and adjust the tense.";
  expect
    .soft(
      editPrompt({
        action: input.action,
        instruction,
        passage: read.selection.text,
        context: read.selection.context,
        quotes: [row.quote],
      }),
    )
    .toContain(instruction);
  recordProposalRequest(doc, input.requestId, {
    source: "edit-with-ai",
    action: input.action,
    instruction,
    part,
    providerId: "scripted",
    modelId: "scripted",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  expect.soft(proposalRequestOf(doc, input.requestId)).toMatchObject({ part });
});

test.each(CASES)("$language $kind keeps physical Citations when row receipts are scoped", (row) => {
  const { blocks, input, parts, check, owned } = fixture(row, true, "follow-citation");
  const first = parts[0];
  if (!first) throw new Error("The qualifier row is missing.");
  const read = readSelection(
    blocks,
    input.from,
    { ...input.to, offset: row.claim.length + 1 },
    input.action,
    { id: check.id, span: first.span },
  );
  if (!read.ok) throw new Error(`The full cited assertion could not be read: ${read.reason}`);
  expect(read.selection.citations.map((citation) => citation.id)).toEqual([owned.id]);
  expect(read.selection.citedElements).toHaveLength(1);
});

test.each([
  null,
  {},
  { id: "check", span: { start: -1, end: 5 } },
  { id: "check", span: { start: 0, end: "5" } },
])("malformed stored row targets never become unscoped requests: %j", (part) => {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const request = randomUUID();
  doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD).set(request, {
    source: "edit-with-ai",
    action: "follow-citation",
    part,
    providerId: "scripted",
    modelId: "scripted",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  expect(proposalRequestOf(doc, request)).toBeNull();
});

describe.each([
  { inline: false, name: "uncited ordinary part receipt", action: "follow-citation" },
  { inline: true, name: "explicit inline Citation control", action: "follow-citation" },
  { inline: false, name: "uncited ordinary part receipt", action: "cut-unsupported" },
  { inline: true, name: "explicit inline Citation control", action: "cut-unsupported" },
] as const)("$action with $name", ({ inline, action }) => {
  test.each(CASES)("$language $kind exposes only the selected owned receipt", (row) => {
    const { doc, blocks, input, selection, owned, parts } = fixture(row, inline, action);
    expect(input.text).toBe(`${row.literal}${inline ? "\uFFFC" : ""}`);
    expect(input.from.offset).toBe(0);
    expect(input.to.offset).toBe(row.literal.length + (inline ? 1 : 0));
    expect(selection.plain).toBe(input.text);
    expect(selection.context).toContain(row.fact);
    expect(citationSentences(blocks).get(owned.id ?? "")?.citation).toMatchObject({
      ...citationAttributesOf({ ...owned }),
      id: owned.id,
    });
    const owner = parts[0];
    if (!owner) throw new Error("The selected qualifier has no owning part.");
    expect(partCitations(owner)).toHaveLength(1);
    expect.soft(selection.citations.map((citation) => citation.id)).toEqual([owned.id]);
    expect.soft(selection.text).toContain("[1]");
    const prompt = editPrompt({
      action: input.action,
      instruction: "",
      passage: selection.text,
      context: selection.context,
      before: selection.before,
      after: selection.after,
      quotes: selection.citations.map((citation) =>
        typeof citation.quote === "string" ? citation.quote : "",
      ),
    });
    expect.soft(prompt).toContain(`[1] “${owned.quote}”`);

    let unmatched = -1;
    doc.transact(() => {
      unmatched = proposeRewrite(selection, `${row.replacement}[1]`, input.requestId, randomUUID)
        .notes.unmatchedMarkers;
    });
    expect.soft(unmatched).toBe(0);
    doc.transact(() => resolveProposals(blocks, () => true, "accept"));
    const actual: Record<string, unknown>[] = [];
    readMind({ blocks }).descendants((node) => {
      if (node.type.name === "citation") actual.push(node.attrs);
    });
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({ ...owned, id: expect.any(String) });
    if (inline) expect(actual[0]?.id).toBe(owned.id);
    else {
      expect(actual[0]?.id).not.toBe(owned.id);
      expect(citationSentences(blocks).get(owned.id ?? "")?.citation).toMatchObject(owned);
    }
  });
});

test.each(CASES)("$language $kind uses current complete row bounds, not the whole mark", (row) => {
  const { blocks, input, parts } = fixture(row, false, "follow-citation");
  const selected = (from: number, to: number) => {
    const read = readSelection(
      blocks,
      { ...input.from, offset: from },
      { ...input.to, offset: to },
      input.action,
    );
    if (!read.ok) throw new Error(`The Core could not read the test range: ${read.reason}`);
    return read.selection;
  };
  expect(selected(1, row.literal.length).citations).toEqual([]);
  const factFrom = row.claim.indexOf(row.fact);
  const neighbor = selected(factFrom, factFrom + row.fact.length);
  expect(neighbor.citations.map((citation) => citation.id)).toEqual([parts[1]?.evidence[0]?.id]);
  const block = blocks.get(0);
  const text = block instanceof Y.XmlElement ? block.get(0) : null;
  if (!(text instanceof Y.XmlText)) throw new Error("The marked text is missing.");
  text.insert(factFrom, "Changed ");
  expect(selected(0, row.literal.length).citations).toEqual([]);
});

test("a later physical Citation keeps its id after earlier row-only receipt markers", () => {
  const first = fixture(CASES[0], false, "follow-citation");
  const second = fixture(CASES[2], true, "follow-citation");
  const last = second.blocks.get(0);
  if (!(last instanceof Y.XmlElement)) throw new Error("The cited paragraph is missing.");
  first.blocks.push([last.clone()]);
  const read = readSelection(first.blocks, first.input.from, second.input.to, "follow-citation");
  if (!read.ok) throw new Error(`The multi-paragraph selection was rejected: ${read.reason}`);
  expect(read.selection.citations.map((citation) => citation.id)).toEqual([
    ...first.parts.map((part) => part.evidence[0]?.id),
    second.owned.id,
  ]);
  expect(read.selection.citedElements).toHaveLength(1);
  const paragraphs = read.selection.text.split("\n\n");
  expect(paragraphs).toHaveLength(2);
  first.doc.transact(() => {
    proposeRewrite(
      read.selection,
      `${paragraphs[0]?.replace(CASES[0].literal, CASES[0].replacement)}\n\n[3] ${CASES[2].replacement}`,
      randomUUID(),
      randomUUID,
    );
    resolveProposals(first.blocks, () => true, "accept");
  });
  const actual: Record<string, unknown>[] = [];
  readMind(first).descendants((node) => {
    if (node.type.name === "citation") actual.push(node.attrs);
  });
  expect(actual).toHaveLength(3);
  expect(new Set(actual.map((citation) => citation.id)).size).toBe(3);
  expect(actual.find((citation) => citation.id === second.owned.id)).toMatchObject(second.owned);
});

describe.each(["improve", undefined] as const)(
  "ordinary receipt without citation-aware action %s",
  (action) => {
    test.each(CASES)("$language $kind preserves the existing edit input", (row) => {
      const { selection } = fixture(row, false, action);
      expect(selection.citations).toEqual([]);
      expect(selection.text).toBe(row.literal);
    });
  },
);

let editingDocument: Y.Doc | null = null;
let activeEdit: ((input: EditWithAiInput) => Promise<EditWithAiResult>) | null = null;
afterAll(() => vi.unstubAllGlobals());
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const bridge = {
  on(event: string, listener: (payload: unknown) => void) {
    const registered = listeners.get(event) ?? new Set<(payload: unknown) => void>();
    registered.add(listener);
    listeners.set(event, registered);
    return () => registered.delete(listener);
  },
  async openMind() {
    if (!editingDocument) throw new Error("The edit fixture has no Note.");
    return { state: Y.encodeStateAsUpdate(editingDocument), access: "edit" };
  },
  async applyMindUpdate(_mindId: string, update: Uint8Array) {
    if (!editingDocument) throw new Error("The edit fixture has no Note.");
    Y.applyUpdate(editingDocument, update);
  },
  async watchComparisonMind() {},
  async unwatchComparisonMind() {},
  async closeMind() {},
  async recordAiUse() {},
  async editWithAi(input: EditWithAiInput) {
    if (!activeEdit) throw new Error("The edit fixture has no request handler.");
    return activeEdit(input);
  },
};

test.each(CASES)(
  "$language $kind applies its Citation and words through one offered Undo",
  async (row) => {
    const { doc, blocks, input, owned, parts, check } = fixture(row, false, "follow-citation");
    editingDocument = doc;
    const document = new DOMParser().parseFromString(
      "<!doctype html><html><head></head><body></body></html>",
      "text/html",
    );
    Object.assign(document.defaultView, { incarnamind: bridge });
    vi.stubGlobal("window", document.defaultView);
    vi.stubGlobal("document", document);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
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
    const { requestEdit } = await import("../../src/renderer/src/editWithAi");
    const { openMindCopy, flushMindUpdates } = await import("../../src/renderer/src/mindCopies");
    const { AppliedEditLine, appliedLineIn } = await import(
      "../../src/renderer/src/editor/appliedEditLine"
    );
    const { undoStackOf } = await import("../../src/renderer/src/editor/editorUndo");
    const { ProposalReview } = await import("../../src/renderer/src/editor/proposalReview");
    const { useUndo } = await import("../../src/renderer/src/undo");
    useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
    const local = await new Promise<Y.Doc>((resolve, reject) => {
      const close = openMindCopy(
        input.mindId,
        (copy) => {
          if (copy.doc) resolve(copy.doc);
          else reject(new Error("The Note did not open for editing."));
        },
        reject,
      );
      onTestFinished(close);
    });
    onTestFinished(() => local.destroy());
    const editor = new Editor({
      element: document.createElement("div", {}),
      extensions: [
        ...editorExtensions(),
        Collaboration.configure({ document: local, field: MIND_CONTENT_FIELD }),
        ProposalReview,
        AppliedEditLine.configure({ translate: (key) => key, undoKeys: () => "" }),
      ],
    });
    onTestFinished(() => editor.destroy());
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    const original = editor.state.doc.toJSON();
    expect(undoStackOf(editor)?.undoStack).toHaveLength(0);
    editor.commands.setTextSelection({ from: 1, to: 1 + row.claim.length });
    const selected = selectionForEdit(editor.state);
    if (!selected) throw new Error("The bound editor did not select the qualifier.");
    const first = parts[0];
    if (!first) throw new Error("The qualifier row is missing.");
    const part = { id: check.id, span: first.span };
    const instruction =
      row.kind === "source"
        ? `Use ${owned.documentName}.`
        : "State March 2024 and adjust the tense.";
    activeEdit = async (actual) => {
      expect(actual.part).toEqual(part);
      expect(actual.text).toBe(row.claim);
      expect(actual.instruction).toBe(instruction);
      const read = readSelection(blocks, actual.from, actual.to, actual.action, actual.part);
      if (!read.ok) throw new Error(`The edit selection was rejected: ${read.reason}`);
      expect(read.selection.citations).toHaveLength(1);
      const request = randomUUID();
      const cause: EditCause = { requestId: actual.requestId, request, apply: true };
      const emit = (update: Uint8Array) => {
        for (const listener of listeners.get("mind.update") ?? []) {
          listener({ mindId: actual.mindId, update, cause });
        }
      };
      doc.on("update", emit);
      let proposals = 0;
      try {
        doc.transact(() => {
          recordProposalRequest(doc, request, {
            source: "edit-with-ai",
            action: actual.action,
            instruction: actual.instruction,
            part: actual.part,
            providerId: "scripted",
            modelId: "scripted",
            createdAt: "2026-10-29T12:00:00.000Z",
          });
          proposals = proposeRewrite(read.selection, row.corrected, request, randomUUID).proposals
            .length;
        });
      } finally {
        doc.off("update", emit);
      }
      expect(proposals).toBeGreaterThan(0);
      return {
        kind: "proposed",
        request,
        proposals,
        droppedCitations: 0,
        outOfDate: 0,
        stateVector: Y.encodeStateVector(doc),
      };
    };
    onTestFinished(() => {
      activeEdit = null;
    });
    expect(
      await requestEdit(
        editor,
        input.mindId,
        local,
        input.action,
        instruction,
        selected.range,
        undefined,
        part,
      ),
    ).toBe(true);
    expect(appliedLineIn(editor.state)?.kind).toBe("applied");
    expect(editor.state.doc.textContent).toBe(row.corrected.replace("[1]", ""));
    const citations: Record<string, unknown>[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") citations.push(node.attrs);
    });
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ ...owned, id: expect.any(String) });
    expect(citations[0]?.id).not.toBe(owned.id);
    expect(useUndo.getState().done).toHaveLength(1);
    expect(undoStackOf(editor)?.undoStack).toHaveLength(1);
    await useUndo.getState().undo();
    await flushMindUpdates(input.mindId);
    expect(editor.state.doc.toJSON()).toEqual(original);
    expect(readMind({ blocks }).toJSON()).toEqual(original);
    expect(useUndo.getState().done).toHaveLength(0);
  },
);
