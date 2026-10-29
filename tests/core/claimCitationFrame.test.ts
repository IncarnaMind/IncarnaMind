import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  checkedSentences,
  everySentence,
  selectedSentences,
} from "../../src/core/answers/checks/sentences";
import {
  CITATION_NODE,
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
} from "../../src/core/api";
import { ClaimChecks, claimsOf, paragraphPlaces } from "../../src/renderer/src/editor/claimChecks";
import { sentencesToCheck } from "../../src/renderer/src/editor/healthCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { opinionSentenceRanges, opinionsIn } from "../../src/renderer/src/editor/opinionLocations";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { partWithResult, pendingPart } from "../../src/shared/claimParts";
import { writeOpinionSentences } from "../../src/shared/opinions";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { editorExtensions, headlessEditor } from "../helpers/editor";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const schema = getSchema(noteExtensions());
const context = { versions: null, folderId: null, scope: null };
const citation: Citation = {
  passageId: "passage",
  documentId: "results",
  documentName: "Results",
  contentHash: "v1",
  quote: "Revenue rose 8%.",
  pageFrom: 1,
  pageTo: 1,
  location: null,
  check: "found",
  checkReason: null,
};
const cases = [
  { text: "Revenue rose 8%; we think this is risky.", opinion: "we think this is risky" },
  { text: "收入上涨8%；我们认为这有风险。", opinion: "我们认为这有风险" },
];

function checkOf(text: string, opinion: string): ClaimCheckAttributes {
  const at = text.indexOf(opinion);
  return {
    id: "check",
    request: "request",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text,
    evidence: citation,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
    scope: { folderId: null, widened: false },
    checkedAt: "2026-10-29T00:00:00.000Z",
    parts: [
      partWithResult(
        { span: { start: 0, end: at }, kind: "fact" },
        {
          verdict: "supported",
          evidence: citation,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          versions: [],
          excluded: [],
        },
      ),
      pendingPart({ span: { start: at, end: at + opinion.length }, kind: "opinion" }),
    ],
  };
}

function note(
  text: string,
  check: ClaimCheckAttributes,
  at: number | null = null,
  node: JSONContent = { type: CITATION_NODE, attrs: citation },
) {
  const words = (value: string): JSONContent[] =>
    value ? [{ type: "text", text: value, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }] : [];
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p" },
        content:
          at === null ? words(text) : [...words(text.slice(0, at)), node, ...words(text.slice(at))],
      },
    ],
  });
}

function blocksOf(doc: ReturnType<typeof note>) {
  const ydoc = new Y.Doc();
  const blocks = ydoc.getXmlFragment("mind");
  prosemirrorToYXmlFragment(doc, blocks);
  return blocks;
}

for (const example of cases)
  describe(example.text, () => {
    for (const place of ["start", "inside", "end"] as const) {
      test(`adding and deleting a Citation at ${place} preserves the checked literal words and part targets`, () => {
        const check = checkOf(example.text, example.opinion);
        const at =
          place === "start"
            ? 0
            : place === "end"
              ? example.text.length
              : example.text.indexOf(example.opinion) + 2;
        const doc = note(example.text, check, at);
        const [claim] = claimsOf(doc, context).claims;
        expect(claim?.check.text).toBe(example.text);
        expect(claim?.sentence.text).toBe(example.text);
        expect(claim?.shown).toEqual({ state: "supported" });
        const opinion = opinionsIn(doc, new Y.Doc())[0];
        expect(opinion).toBeDefined();
        const opinionStart = example.text.indexOf(example.opinion);
        expect(opinion?.range.from).toBe(1 + opinionStart + (at <= opinionStart ? 1 : 0));
        expect(opinion?.range.to).toBe(
          1 +
            opinionStart +
            example.opinion.length +
            (at < opinionStart + example.opinion.length ? 1 : 0),
        );
        expect(doc.textBetween(opinion?.range.from ?? 0, opinion?.range.to ?? 0)).toBe(
          example.opinion,
        );
        const block = doc.firstChild;
        if (!block) throw new Error("Missing paragraph.");
        expect(paragraphPlaces(block, 0).text).toBe(
          example.text.slice(0, at) + INLINE_NODE + example.text.slice(at),
        );
        const removed = EditorState.create({ doc }).tr.delete(at + 1, at + 2).doc;
        expect(claimsOf(removed, context).claims[0]?.shown).toEqual({ state: "supported" });
      });
    }

    test("Core readers use the same literal words and keep the Citation as evidence", () => {
      const check = checkOf(example.text, example.opinion);
      const at = example.text.indexOf(example.opinion) + 2;
      for (const citationAt of [at, example.text.length]) {
        const blocks = blocksOf(note(example.text, check, citationAt));
        const [sentence] = everySentence(blocks);
        expect(sentence?.text).toBe(example.text);
        expect(sentence?.cited).toEqual([expect.objectContaining({ quote: citation.quote })]);
        const selected = selectedSentences(blocks, [
          {
            from: { blockId: "p", offset: citationAt },
            to: { blockId: "p", offset: citationAt + 1 },
          },
        ]);
        expect(selected.ok && selected.sentences[0]?.text).toBe(example.text);
        const [marked] = checkedSentences(blocks);
        expect(marked?.sentence).toBe(example.text);
        expect(
          marked && claimCheckShown(marked.check, { ...context, text: marked.sentence }),
        ).toEqual({ state: "supported" });
      }
    });

    for (const edit of ["word", "space", "other-inline"] as const) {
      test(`${edit} changes still require a fresh check`, () => {
        const check = checkOf(example.text, example.opinion);
        const doc =
          edit === "other-inline"
            ? note(example.text, check, 2, {
                type: "documentChip",
                attrs: { documentId: "another", documentName: "Another" },
              })
            : note(
                edit === "space"
                  ? `${example.text.slice(0, 2)} ${example.text.slice(2)}`
                  : `Changed ${example.text}`,
                check,
              );
        expect(claimsOf(doc, context).claims[0]?.shown).toEqual({
          state: "needs-recheck",
          why: "edited",
        });
      });
    }

    test("legacy checks retain their Citation-insensitive comparison", () => {
      const check = checkOf(example.text, example.opinion);
      delete check.parts;
      expect(
        claimsOf(note(example.text, check, example.text.length), context).claims[0]?.shown,
      ).toEqual({ state: "supported" });
    });
  });

test("automatic checking leaves all 20 pure opinions out, including cited ones, while mixed facts and manual checks remain", () => {
  const inventory = new Y.Doc();
  const pure = Array.from({ length: 20 }, (_, index) => ({
    id: `opinion-${index}`,
    blockId: `pure-${index}`,
    text: index % 2 ? `我们认为方案${index}很有希望。` : `We think option ${index} is promising.`,
    occurrence: 0,
    parts: [
      pendingPart({
        span: {
          start: 0,
          end:
            index % 2
              ? `我们认为方案${index}很有希望。`.length
              : `We think option ${index} is promising.`.length,
        },
        kind: "opinion",
      }),
    ],
  }));
  writeOpinionSentences(inventory, pure);
  const editor = headlessEditor([...editorExtensions(), ClaimChecks]);
  const mixed = cases[0];
  if (!mixed) throw new Error("Missing mixed fixture.");
  editor.commands.setContent({
    type: "doc",
    content: [
      ...pure.map((entry, index) => ({
        type: "paragraph",
        attrs: { id: entry.blockId },
        content: [
          { type: "text", text: entry.text },
          ...(index % 2 ? [{ type: CITATION_NODE, attrs: citation }] : []),
        ],
      })),
      { type: "paragraph", attrs: { id: "mixed" }, content: [{ type: "text", text: mixed.text }] },
    ],
  });
  const omitted = opinionSentenceRanges(editor.state.doc, inventory);
  expect(omitted).toHaveLength(20);
  expect(
    sentencesToCheck(editor.state, new Set(), undefined, omitted).map(({ blockId }) => blockId),
  ).toEqual(["mixed"]);
  const first = pure[0];
  if (!first) throw new Error("Missing manual fixture.");
  writeOpinionSentences(inventory, pure.slice(1));
  const checked = {
    ...checkOf(mixed.text, mixed.opinion),
    id: first.id,
    text: first.text,
    parts: [
      partWithResult(
        { span: { start: 0, end: first.text.length }, kind: "opinion" },
        {
          verdict: "supported",
          evidence: citation,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
          versions: [],
          excluded: [],
        },
      ),
    ],
  };
  editor.commands.setContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: first.blockId },
        content: [
          { type: "text", text: first.text, marks: [{ type: CLAIM_CHECK_MARK, attrs: checked }] },
          { type: CITATION_NODE, attrs: citation },
        ],
      },
    ],
  });
  expect(opinionSentenceRanges(editor.state.doc, inventory)).toEqual([]);
  expect(claimsOf(editor.state.doc, context).claims[0]?.shown).toEqual({ state: "supported" });
});

test("a multi-block selection keeps a short middle sentence after Citation prefixes", () => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "first" },
        content: [{ type: "text", text: "Opening words." }],
      },
      {
        type: "paragraph",
        attrs: { id: "middle" },
        content: [
          ...Array.from({ length: 20 }, () => ({ type: CITATION_NODE, attrs: citation })),
          { type: "text", text: "Last point." },
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "last" },
        content: [{ type: "text", text: "Closing words." }],
      },
    ],
  });
  const selected = selectedSentences(blocksOf(doc), [
    {
      from: { blockId: "first", offset: 0 },
      to: { blockId: "last", offset: "Closing words.".length },
    },
  ]);
  expect(selected.ok && selected.sentences.map(({ text }) => text)).toEqual([
    "Opening words.",
    "Last point.",
    "Closing words.",
  ]);
});

for (const [before, after] of [
  [
    "The harbour office opens to visitors in the morning.",
    "The harbour office opens to visitors in the daytime.",
  ],
  ["港务处上午接待访客。", "港务处白天接待访客。"],
])
  test(`a public Core Check again writes the edited literal basis: ${before}`, async () => {
    if (!before || !after) throw new Error("Missing sentence fixture.");
    const plans = {
      [before]: { verdict: "supported" as const, quote: before },
      [after]: { verdict: "supported" as const, quote: before },
    };
    const model = scriptedModel((call) => checkReply(call, plans), {
      generate: checkGenerate(plans),
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Office.md", contents: before },
    ]);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "p" }, content: [{ type: "text", text: before }] },
    ]);
    await client.settled();
    const check = () =>
      core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
    expect((await check()).kind).toBe("checked");
    await client.settled();
    expect(claimsOf(readMind(client), context).claims[0]?.shown).toEqual({ state: "supported" });
    editMind(client, (blocks) =>
      blocks.map((block) => ({
        ...block,
        content: block.content?.map((node) =>
          node.type === "text" ? { ...node, text: after } : node,
        ),
      })),
    );
    await client.settled();
    expect(claimsOf(readMind(client), context).claims[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "edited",
    });
    expect((await check()).kind).toBe("checked");
    await client.settled();
    const [current] = claimsOf(readMind(client), context).claims;
    expect(current?.check.text).toBe(after);
    expect(current?.sentence.text).toBe(after);
    expect(current?.shown).toEqual({ state: "supported" });
  });
