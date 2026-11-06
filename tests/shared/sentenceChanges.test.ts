import { getSchema, type JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  changedText,
  paragraphStart,
  paragraphsRemoved,
  sentenceChanges,
  takesOnlyOut,
} from "../../src/shared/sentenceChanges";

/*
 * What an edit does to the User's sentences, read from the text before and after it (#2356): the
 * shapes a real model wrote for "Delete one sentence from the Parking paragraph" (DeepSeek, two
 * rounds), the old sentences kept, taken out whole, or joined and reworded into what it wrote.
 */

const PARKING = {
  en: "Parking: the tenant may use six underground spaces. Each costs 800 a month. Spaces are allocated by the landlord.",
  zh: "停车位：承租方可使用地下停车位 6 个。每个车位每月 800 元。车位由出租方分配。",
};
const EN = {
  spaces: "Parking: the tenant may use six underground spaces.",
  costs: "Each costs 800 a month.",
  allocated: "Spaces are allocated by the landlord.",
};
const ZH = {
  spaces: "停车位：承租方可使用地下停车位 6 个。",
  costs: "每个车位每月 800 元。",
  allocated: "车位由出租方分配。",
};

describe("A removal that also rewrites the sentences it keeps is no removal alone (#2356)", () => {
  // protects=each recorded edit that took one sentence of three out, or none, and joined or reworded the others is read as rewriting them, the sentence whose words it no longer holds as taken out, in English and Chinese; fails_when=a joined or reworded sentence reads as kept or taken out, or the edit reads as only taking text out; no_claim=what a real model writes.
  test.each([
    {
      case: "English 3",
      before: PARKING.en,
      after: "Parking: the tenant may use six underground spaces, each 800 a month.",
      takenOut: [EN.allocated],
      rewritten: [EN.spaces, EN.costs],
    },
    {
      case: "English 5, 6 and 7",
      before: PARKING.en,
      after: "Parking: the tenant may use six underground spaces, each costing 800 a month.",
      takenOut: [EN.allocated],
      rewritten: [EN.spaces, EN.costs],
    },
    {
      case: "English 9",
      before: PARKING.en,
      after:
        "Parking: each of six underground spaces costs 800 a month, allocated by the landlord.",
      takenOut: [],
      rewritten: [EN.spaces, EN.costs, EN.allocated],
    },
    {
      case: "Chinese 11",
      before: PARKING.zh,
      after: "地下停车位 6 个，每车位月租 800 元，由出租方分配。",
      takenOut: [],
      rewritten: [ZH.spaces, ZH.costs, ZH.allocated],
    },
    {
      case: "Chinese 12, 15 and 17",
      before: PARKING.zh,
      after: "停车位：承租方可使用地下停车位 6 个，每个车位每月 800 元。",
      takenOut: [ZH.allocated],
      rewritten: [ZH.spaces, ZH.costs],
    },
    {
      case: "Chinese 18",
      before: PARKING.zh,
      after: "停车位：承租方可使用地下停车位6个，每个车位每月800元。",
      takenOut: [ZH.allocated],
      rewritten: [ZH.spaces, ZH.costs],
    },
  ])("held out: $case", ({ before, after, takenOut, rewritten }) => {
    const changes = sentenceChanges([before], [after]);

    expect(changes).toEqual({
      kept: 0,
      takenOut: takenOut.length,
      shortened: 0,
      rewritten: rewritten.length,
      written: 1,
      named: { takenOut, rewritten },
    });
    expect(takesOnlyOut(changes)).toBe(false);
  });

  // protects=an edit that only takes text out reads so: a whole sentence of three, in the middle or at the end, in English or Chinese, words out of a sentence, a whole paragraph, a list item's sentence and a table cell's, the rest word for word; fails_when=any of them reads as rewriting, so it would wait; no_claim=what a real model writes.
  test.each([
    {
      case: "en, the middle sentence",
      before: [PARKING.en],
      after: [`${EN.spaces} ${EN.allocated}`],
      changes: { kept: 2, takenOut: 1, shortened: 0, named: [EN.costs] },
    },
    {
      case: "zh, the middle sentence",
      before: [PARKING.zh],
      after: [`${ZH.spaces}${ZH.allocated}`],
      changes: { kept: 2, takenOut: 1, shortened: 0, named: [ZH.costs] },
    },
    {
      case: "en, the last sentence",
      before: [PARKING.en],
      after: [`${EN.spaces} ${EN.costs}`],
      changes: { kept: 2, takenOut: 1, shortened: 0, named: [EN.allocated] },
    },
    {
      case: "zh, the last sentence",
      before: [PARKING.zh],
      after: [`${ZH.spaces}${ZH.costs}`],
      changes: { kept: 2, takenOut: 1, shortened: 0, named: [ZH.allocated] },
    },
    {
      case: "en, words out of a sentence",
      before: [PARKING.en],
      after: [`${EN.spaces} Each costs 800. ${EN.allocated}`],
      changes: { kept: 2, takenOut: 0, shortened: 1, named: [] },
    },
    {
      case: "a whole paragraph",
      before: ["Deposit: three months' rent, held by the landlord.", PARKING.en],
      after: [PARKING.en],
      changes: {
        kept: 3,
        takenOut: 1,
        shortened: 0,
        named: ["Deposit: three months' rent, held by the landlord."],
      },
    },
    {
      case: "a list item's sentence",
      before: ["Rent is 98,000 a month. It is paid by the 5th."],
      after: ["Rent is 98,000 a month."],
      changes: { kept: 1, takenOut: 1, shortened: 0, named: ["It is paid by the 5th."] },
    },
    {
      case: "a table cell's sentence",
      before: ["六个车位。每个每月 800 元。"],
      after: ["六个车位。"],
      changes: { kept: 1, takenOut: 1, shortened: 0, named: ["每个每月 800 元。"] },
    },
  ])("decoy, only taken out: $case", ({ before, after, changes }) => {
    const read = sentenceChanges(before, after);

    expect(read).toEqual({
      kept: changes.kept,
      takenOut: changes.takenOut,
      shortened: changes.shortened,
      rewritten: 0,
      written: 0,
      named: { takenOut: changes.named, rewritten: [] },
    });
    expect(takesOnlyOut(read)).toBe(true);
  });

  // protects=a sentence kept but for a mark written into it is rewritten, not kept, so a removal that also changes a kept sentence's marks is no removal alone; fails_when=marks don't count, so it reads as only taken out; no_claim=what a real model writes.
  test("a mark changed in a kept sentence is a rewrite", () => {
    const changes = sentenceChanges(
      [PARKING.en],
      ["Parking: the tenant may use six underground spaces! Each costs 800 a month."],
    );

    expect(changes).toMatchObject({ kept: 1, takenOut: 1, rewritten: 1, written: 1 });
    expect(takesOnlyOut(changes)).toBe(false);
  });

  // protects=an edit that takes nothing out is no removal, whether it changes nothing or only adds; fails_when=either reads as only taking text out; no_claim=what a real model writes.
  test("nothing taken out, or a sentence added, is no removal", () => {
    expect(takesOnlyOut(sentenceChanges([PARKING.en], [PARKING.en]))).toBe(false);
    const added = sentenceChanges([PARKING.en], [`${PARKING.en} Visitors park free.`]);
    expect(added).toMatchObject({ kept: 3, takenOut: 0, rewritten: 0, written: 1 });
    expect(takesOnlyOut(added)).toBe(false);
  });
});

const schema = getSchema(noteExtensions());
const REQUEST = "r1";
let next = 0;
const id = () => `b${++next}`;
const ref = () => ({ id: id(), request: REQUEST });
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});
const struck = (value: string) => text(value, [{ type: "proposalDelete", attrs: ref() }]);
const written = (value: string) => text(value, [{ type: "proposalInsert", attrs: ref() }]);
const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: id() },
  content,
});
const whole = (kind: "insert" | "delete", words: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: id(), proposal: { id: id(), request: REQUEST, kind } },
  content: [text(words)],
});

function blocksOf(content: JSONContent[]) {
  return prosemirrorToYXmlFragment(
    schema.nodeFromJSON({ type: "doc", content }),
    new Y.Doc().getXmlFragment(MIND_CONTENT_FIELD),
  );
}

describe("The text a request's Proposals change, before and after (#2356)", () => {
  // protects=the paragraphs a request's Proposals touch are read as they stand and as they will read accepted, wherever they are: a list item and a table cell with a sentence struck read as only taken out, a paragraph struck whole and written again joined reads as rewritten, and a paragraph the request doesn't touch is left out; fails_when=an untouched paragraph is read, a struck sentence is read as kept, or what is written anew is missed; no_claim=how the editor shows them.
  test("a list item and a table cell with a sentence struck, the rest left alone", () => {
    const blocks = blocksOf([
      paragraph(text("Lease terms.")),
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("Rent is 98,000 a month. "), struck("It is paid by the 5th.")),
            ],
          },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [paragraph(text("六个车位。"), struck("每个每月 800 元。"))],
              },
            ],
          },
        ],
      },
    ]);

    const read = changedText(blocks, REQUEST);

    expect(read).toEqual({
      before: ["Rent is 98,000 a month. It is paid by the 5th.", "六个车位。每个每月 800 元。"],
      after: ["Rent is 98,000 a month. ", "六个车位。"],
    });
    expect(takesOnlyOut(sentenceChanges(read.before, read.after))).toBe(true);
  });

  test("a paragraph struck whole and written again with its sentences joined", () => {
    const blocks = blocksOf([
      whole("delete", PARKING.en),
      whole(
        "insert",
        "Parking: the tenant may use six underground spaces, each costing 800 a month.",
      ),
      paragraph(text("Deposit: three months' rent.")),
    ]);

    const read = changedText(blocks, REQUEST);

    expect(read).toEqual({
      before: [PARKING.en],
      after: ["Parking: the tenant may use six underground spaces, each costing 800 a month."],
    });
    expect(takesOnlyOut(sentenceChanges(read.before, read.after))).toBe(false);
  });

  test("a paragraph whose full stop is struck and a comma written joins its sentences", () => {
    const blocks = blocksOf([
      paragraph(
        text("停车位：承租方可使用地下停车位 6 个"),
        struck("。"),
        written("，"),
        text("每个车位每月 800 元。"),
        struck("车位由出租方分配。"),
      ),
    ]);

    const read = changedText(blocks, REQUEST);

    expect(read.after).toEqual(["停车位：承租方可使用地下停车位 6 个，每个车位每月 800 元。"]);
    expect(sentenceChanges(read.before, read.after)).toMatchObject({
      takenOut: 1,
      rewritten: 2,
      written: 1,
    });
  });
});

describe("How a paragraph removed whole is named (#2356)", () => {
  // protects=a removed paragraph is named by its label without the colon when it starts with one ("Parking", 停车位), else by its first 4 words or 8 Chinese characters with "…" when cut, whole when short, and its sentences are counted; fails_when=the label keeps its colon, a long paragraph isn't cut, or a short one is; no_claim=how the line shows it.
  test.each([
    [PARKING.en, "Parking"],
    [PARKING.zh, "停车位"],
    ["The boat leaves at nine and returns at five.", "The boat leaves at…"],
    ["请带一件厚外套和手套，山上风大。", "请带一件厚外套和…"],
    ["Bring a coat.", "Bring a coat."],
    ["带外套。", "带外套。"],
    ["What the tenant and the landlord agreed: rent first.", "What the tenant and…"],
  ])("%s", (text, start) => {
    expect(paragraphStart(text)).toBe(start);
  });

  test("its sentences are counted, the first paragraph named", () => {
    expect(paragraphsRemoved([PARKING.en])).toEqual({
      paragraphs: 1,
      sentences: 3,
      start: "Parking",
    });
    expect(paragraphsRemoved([PARKING.zh, "押金：三个月租金，由出租方保管。"])).toEqual({
      paragraphs: 2,
      sentences: 4,
      start: "停车位",
    });
  });
});
