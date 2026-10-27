import { Editor, getSchema, getTextBetween, getTextSerializersFromSchema } from "@tiptap/core";
import {
  DOMSerializer,
  DOMParser as ProseMirrorDOMParser,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { parseHTML } from "linkedom";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement, toMarkdown } from "../../src/core/answers/blocks";
import {
  ANSWER_BLOCK,
  CALCULATED_FIGURE_NODE,
  type CalculatedFigure,
  PROPOSAL_ATTRIBUTE,
} from "../../src/core/api";
import {
  blockText,
  firstLineOf,
  plainText,
  type ReadOptions,
  readBlock,
  reviewReading,
} from "../../src/core/mindText";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import type { NodeJSON } from "../../src/shared/blockJson";
import {
  calculatedFigureNode,
  readCalculatedFigureAttributes,
} from "../../src/shared/calculatedFigures";
import { FORMULA_VERSION } from "../../src/shared/formula";

function figure(shown = "20.0"): CalculatedFigure {
  return {
    label: "Revenue",
    formula: "SUM(revenue)",
    inputs: [
      {
        name: "revenue",
        label: "Current revenue",
        citation: {
          passageId: "passage-1",
          documentId: "document-1",
          documentName: "Report",
          contentHash: "content-1",
          pageFrom: null,
          pageTo: null,
          location: null,
          quote: "Revenue 20",
          check: "found",
          checkReason: null,
        },
        number: {
          chars: "20",
          at: 8,
          value: 20,
          scale: 1,
          scaleWord: null,
          unit: { kind: "plain" },
          decimals: 0,
          approximate: false,
          reading: null,
        },
        cell: null,
        unitStatement: null,
      },
    ],
    value: 20,
    unit: { kind: "plain" },
    approximate: false,
    shown,
    show: { language: "en", as: null, decimals: 1, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
  };
}

test("the shared Note schema retains a calculated figure as one inline atom", () => {
  const schema = getSchema(noteExtensions());
  const json = calculatedFigureNode(figure(), "figure-1");
  const node = schema.nodeFromJSON(json);
  expect(node.type.name).toBe(CALCULATED_FIGURE_NODE);
  expect(node.isInline).toBe(true);
  expect(node.isAtom).toBe(true);
  expect(node.type.spec.selectable).toBe(true);
  expect(node.toJSON()).toEqual({ ...json, attrs: { ...json.attrs, claimCheck: null } });
});

function serialized(value: CalculatedFigure, analysisId: string | null = null) {
  const schema = getSchema(noteExtensions());
  const node = schema.nodeFromJSON(calculatedFigureNode(value, "figure-1", analysisId));
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const dom = DOMSerializer.fromSchema(schema).serializeNode(node, { document }) as HTMLElement;
  const paragraph = document.createElement("p");
  paragraph.append(dom);
  document.body.append(paragraph);
  return { schema, document, dom };
}

function pasted(document: Document, schema = getSchema(noteExtensions())): ProseMirrorNode {
  return ProseMirrorDOMParser.fromSchema(schema).parse(document.body);
}

function copiedText(doc: ProseMirrorNode): string {
  return getTextBetween(
    doc,
    { from: 0, to: doc.content.size },
    {
      textSerializers: getTextSerializersFromSchema(doc.type.schema),
    },
  ).trim();
}

test.each(["en", "zh-CN"] as const)(
  "HTML clipboard keeps the validated %s receipt and visible text",
  (language) => {
    const value = figure();
    value.show.language = language;
    value.label = language === "zh-CN" ? "收入" : "Revenue";
    const { document, dom, schema } = serialized(value);
    const copy = pasted(document, schema).firstChild?.firstChild;
    expect(dom.textContent).toBe("20.0");
    expect(copy?.type.name).toBe(CALCULATED_FIGURE_NODE);
    expect(readCalculatedFigureAttributes(copy?.attrs)).toEqual({
      id: "figure-1",
      figure: value,
      analysisId: null,
    });
    expect(copiedText(pasted(document, schema))).toBe("20.0");
  },
);

test("clipboard carries an Analysis reference without a formula or output payload", () => {
  const value: CalculatedFigure = {
    ...figure(),
    formula: "",
    inputs: [],
    analysis: { analysis: 1, result: "revenue" },
  };
  const { document } = serialized(value, "run-1");
  expect(readCalculatedFigureAttributes(pasted(document).firstChild?.firstChild?.attrs)).toEqual({
    id: "figure-1",
    figure: value,
    analysisId: "run-1",
  });
});

test.each(["{", "null", "[]", "{}"])(
  "malformed clipboard receipt %s stays plain visible text",
  (payload) => {
    const { document, dom } = serialized(figure());
    dom.setAttribute("data-type", CALCULATED_FIGURE_NODE);
    dom.setAttribute("data-id", "figure-1");
    dom.setAttribute("data-figure", payload);
    const copy = pasted(document);
    expect(copy.firstChild?.firstChild?.isText).toBe(true);
    expect(copiedText(copy)).toBe("20.0");
  },
);

test("HTML preserves shown markup characters as literal text and never executes a formula", () => {
  const shown = '<img src="missing" onerror="throw 42"> & 20.0';
  const value = { ...figure(shown), formula: "not_a_formula(" };
  const { document, dom } = serialized(value);
  expect(dom.textContent).toBe(shown);
  expect(dom.querySelector("img")).toBeNull();
  expect(
    readCalculatedFigureAttributes(pasted(document).firstChild?.firstChild?.attrs)?.figure,
  ).toEqual(value);
});

test.each(["id", "figure", "analysisId"])(
  "invalid clipboard %s falls back to visible text",
  (field) => {
    const { document, dom } = serialized(figure());
    if (field === "id") dom.setAttribute("data-id", "");
    if (field === "figure")
      dom.setAttribute("data-figure", JSON.stringify({ ...figure(), value: "20" }));
    if (field === "analysisId") dom.setAttribute("data-analysis-id", "unrelated-run");
    const copy = pasted(document);
    expect(copy.firstChild?.firstChild?.isText).toBe(true);
    expect(copiedText(copy)).toBe("20.0");
  },
);

test("clipboard drops extra claimed verdict fields", () => {
  const value = figure();
  const { document, dom } = serialized(value);
  dom.setAttribute("data-figure", JSON.stringify({ ...value, verified: true }));
  dom.setAttribute("data-checked", "true");
  const copy = pasted(document).firstChild?.firstChild;
  expect(copy?.attrs).toEqual({
    id: "figure-1",
    figure: value,
    analysisId: null,
    claimCheck: null,
  });
});

test("a malformed direct JSON node cannot emit an HTML receipt", () => {
  const schema = getSchema(noteExtensions());
  const node = schema.nodeFromJSON({
    type: CALCULATED_FIGURE_NODE,
    attrs: { id: "figure-1", figure: {} },
  });
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const dom = DOMSerializer.fromSchema(schema).serializeNode(node, { document }) as HTMLElement;
  expect(dom.hasAttribute("data-figure")).toBe(false);
  expect(dom.textContent).toBe("");
});

test("the existing UniqueID extension gives a pasted occurrence its own id", () => {
  const value = figure();
  const original = calculatedFigureNode(value, "figure-1");
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [original] }] },
  });
  onTestFinished(() => editor.destroy());
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
    ...original,
    attrs: { ...original.attrs, id: null },
  });
  const copies: unknown[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === CALCULATED_FIGURE_NODE) copies.push(node.attrs);
  });
  expect(copies).toHaveLength(2);
  const first = readCalculatedFigureAttributes(copies[0]);
  const second = readCalculatedFigureAttributes(copies[1]);
  expect(first?.id).toBe("figure-1");
  expect(second?.id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(second?.figure).toEqual(value);
});

function stored(block: NodeJSON) {
  const doc = new Y.Doc();
  onTestFinished(() => doc.destroy());
  const blocks = doc.getXmlFragment("blocks");
  blocks.insert(0, [createElement(block)]);
  const element = blocks.get(0);
  if (!(element instanceof Y.XmlElement)) throw new Error("Missing stored Block");
  return { element, blocks };
}

const text = (value: string): NodeJSON => ({ type: "text", text: value });
const paragraph = (...content: NodeJSON[]): NodeJSON => ({ type: "paragraph", content });
const readOptions: ReadOptions = {
  includeQuestions: true,
  footnote: () => ({ source: "Report", unverified: false }),
  trimBeforeCitation: false,
};

test.each(["mixed", "only", "table", "answer"])(
  "the core keeps the displayed value in %s content",
  (kind) => {
    const calc = calculatedFigureNode(figure(), "figure-1");
    const p = kind === "mixed" ? paragraph(text("收入"), calc, text("。")) : paragraph(calc);
    const block =
      kind === "table"
        ? {
            type: "table",
            content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p] }] }],
          }
        : kind === "answer"
          ? { type: ANSWER_BLOCK, content: [p] }
          : p;
    const { element, blocks } = stored(block);
    const expected = kind === "mixed" ? "收入20.0。" : "20.0";
    expect(plainText(element)).toBe(expected);
    expect(blockText(element)).toBe(expected);
    expect(toMarkdown(element)).toContain(expected);
    if (kind !== "answer")
      expect(firstLineOf(blocks)).toBe(kind === "mixed" ? "收入20.0" : expected);
    if (kind !== "table") {
      expect(readBlock(element, readOptions)).toMatchObject([
        {
          kind: "paragraph",
          content: expect.arrayContaining([
            expect.objectContaining({ kind: "text", text: "20.0" }),
          ]),
        },
      ]);
    }
  },
);

test("invalid stored figure metadata contributes no invented text", () => {
  const { element } = stored(
    paragraph(
      text("before"),
      {
        type: CALCULATED_FIGURE_NODE,
        attrs: { id: "figure-1", figure: {} },
      },
      text("after"),
    ),
  );
  expect(plainText(element)).toBe("beforeafter");
  expect(blockText(element)).toBe("beforeafter");
  expect(toMarkdown(element)).toBe("beforeafter");
});

test.each(["insert", "delete"] as const)(
  "the figure follows existing pending %s reading",
  (kind) => {
    const calc = calculatedFigureNode(figure(), "figure-1");
    calc.attrs = {
      ...calc.attrs,
      [PROPOSAL_ATTRIBUTE]: { id: "change-1", request: "request-1", kind },
    };
    const { element, blocks } = stored(paragraph(text("before"), calc, text("after")));
    const expected = kind === "insert" ? "beforeafter" : "before20.0after";
    expect(plainText(element)).toBe(expected);
    expect(blockText(element)).toBe(expected);
    expect(toMarkdown(element)).toBe(expected);
    const reviewed = readBlock(element, { ...readOptions, review: reviewReading(blocks) });
    expect(reviewed).toMatchObject([
      {
        content: expect.arrayContaining([
          expect.objectContaining({
            kind: "text",
            text: "20.0",
            [kind === "insert" ? "inserted" : "deleted"]: expect.objectContaining({
              id: "change-1",
            }),
          }),
        ]),
      },
    ]);
  },
);
