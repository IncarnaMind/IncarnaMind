/**
 * What a bounded check still shows (#2220): the quote every receipt keeps, cut to the one bound,
 * whatever part or place it is in, so a Contradicted sentence shows the words that contradict it,
 * a receipt that moves on a re-check keeps its id and its sign-off, and the card, the check record
 * and Undo still list every part, receipt and member. English and Simplified Chinese.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { SENTENCE_RESULT_LABELS } from "../../src/shared/claimChecks";
import {
  boundedCheckParts,
  CHECK_QUOTE_CHARS_AT_MOST,
  checkWithParts,
} from "../../src/shared/claimParts";
import { cardRows } from "../../src/shared/claimRows";
import { translate } from "../../src/shared/i18n";
import {
  citationSignOffBasis,
  namePartCitations,
  type SignOffRecord,
  signOffShown,
} from "../../src/shared/signOffs";
import { checkBasis, partWithReceipts, receipt, sentenceMark } from "../helpers/checkBounds";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

const PARTS = 9;
const RECEIPTS = 5;
const MEMBERS = 13;
const CHARACTERS = 500;
const QUOTE_BOUND = 200;

/** `text` repeated to exactly `length` characters. */
const toLength = (text: string, length: number) =>
  `${text.repeat(Math.ceil(length / text.length))}`.slice(0, length);

const ENGLISH_MARKER = "Headcount actually fell by 3 percent.";
const CHINESE_MARKER = "实际员工人数减少了百分之三。";

const cases = [
  {
    language: "en",
    sentence:
      "Nine places back the summary, with five receipts for each, and thirteen months of quantities.",
    quote: toLength(
      "The report describes the quarter in detail across every region and segment. ",
      CHARACTERS,
    ),
    // The words that contradict sit past 80 characters and inside the bound (the deciding part's
    // quote), so a bound that cuts them short shows.
    deciding: toLength("The quarterly report describes the period. ", 149) + ENGLISH_MARKER,
    marker: ENGLISH_MARKER,
  },
  {
    language: "zh-CN",
    sentence: "九处依据支撑这段总结，每一处各有五条引文，并列出十三个月的数量。",
    // An astral character at the bound, so a cut that splits it would show.
    quote:
      toLength("前三季度成本上升百分之十二，员工人数保持不变。", 199) +
      "𠀀" +
      toLength("收入与成本的变化在各地一致。", CHARACTERS - 200),
    deciding: toLength("第三季度报告详细描述了各地区的情况。", 149) + CHINESE_MARKER,
    marker: CHINESE_MARKER,
  },
] as const;

for (const example of cases)
  describe(example.language, () => {
    test("a checked sentence keeps every part, receipt and member, and the quote that contradicts it", async () => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const out = await createTempDataFolder();
      const printer = fakePrinter();
      const core = startCore(dataDir, { printer: printer.printer });
      await core.setOutputLocation(out);
      const file = await writeSourceFile(
        sources,
        "Quarter.txt",
        `${example.quote}\n\n${example.deciding}`,
      );
      const [document] = await addAndProcess(core, [file]);
      if (!document) throw new Error("Quarter.txt was not added.");
      const mind = await core.createMind({ title: "A checked Note" });
      const client = await connectToMind(core, mind.id);
      const mark = sentenceMark({
        text: example.sentence,
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        parts: PARTS,
        receipts: RECEIPTS,
        quote: example.quote,
        members: MEMBERS,
        deciding: { part: PARTS - 1, quote: example.deciding, verdict: "contradicted" },
      });
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: randomUUID() },
          content: [
            { type: "text", text: example.sentence, marks: [{ type: "claimCheck", attrs: mark }] },
          ],
        },
      ] satisfies JSONContent[]);
      await client.settled();

      // The card: a row for each part and for each member of the quantified part, each with its
      // receipts, every one naming its Document and place.
      const check = claimSpans(readMind(client))[0]?.check;
      if (!check?.parts) throw new Error("The sentence kept no check.");
      expect(check.parts).toHaveLength(PARTS);
      expect(cardRows(check.parts)).toHaveLength(PARTS - 1 + MEMBERS);
      for (const part of check.parts) {
        expect(part.evidence).toHaveLength(RECEIPTS);
        for (const receipt of part.evidence) {
          expect(receipt.id).toBeTruthy();
          expect(receipt.documentId).toBe(document.id);
          expect(receipt.location).not.toBeNull();
          expect(receipt.quote).toBeTruthy();
          expect(receipt.quote?.isWellFormed()).toBe(true);
          expect(receipt.quote?.length).toBeLessThanOrEqual(QUOTE_BOUND);
        }
      }
      const coverage = check.parts[0]?.coverage;
      expect(coverage?.members.map((member) => member.label)).toEqual(
        Array.from({ length: MEMBERS }, (_, member) => `Month ${member + 1}`),
      );
      for (const member of coverage?.members ?? []) {
        const receipt = member.evidence[0];
        expect(member.verdict).toBe("supported");
        expect(receipt?.id).toBeTruthy();
        expect(receipt?.quote).toBeTruthy();
        expect(receipt?.quote?.isWellFormed()).toBe(true);
        expect(receipt?.quote?.length).toBeLessThanOrEqual(QUOTE_BOUND);
      }
      // A Contradicted sentence keeps the words that contradict it, in the part that decides it.
      expect(check.state).toBe("contradicted");
      const deciding = check.parts[PARTS - 1];
      expect(deciding?.verdict).toBe("contradicted");
      expect(deciding?.evidence.length).toBe(RECEIPTS);
      expect(deciding?.evidence[0]?.quote ?? "").toContain(example.marker);
      expect(check.evidence?.quote ?? "").toContain(example.marker);

      // The check record: the sentence, its Document and the quote that decided it.
      const saved = await core.saveCheckRecord(mind.id);
      if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
      const name = saved.file.name.replace(/\.(pdf|csv)$/, "");
      const rows = recordRows(readFileSync(join(out, `${name}.csv`), "utf8"));
      const row = rows.find((each) => each.Kind === "Sentence");
      expect(row?.Sentence).toContain(example.sentence);
      expect(row?.Result).toBe(translate("en", SENTENCE_RESULT_LABELS.contradicted));
      expect(row?.Document).toBe(document.name);
      expect(row?.Quote).toContain(example.marker);

      // Undo: the check comes back whole, every part, receipt and member.
      const undo = new Y.UndoManager(client.blocks, { trackedOrigins: new Set(["editor"]) });
      const paragraph = client.blocks.get(0);
      const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
      if (!(text instanceof Y.XmlText)) throw new Error("The sentence isn't one run of text.");
      client.doc.transact(() => text.format(0, text.length, { claimCheck: null }), "editor");
      await client.settled();
      expect(claimSpans(readMind(client))).toHaveLength(0);
      undo.undo();
      await client.settled();
      const restored = claimSpans(readMind(client))[0]?.check;
      expect(restored?.parts).toHaveLength(PARTS);
      expect(restored?.parts?.every((part) => part.evidence.length === RECEIPTS)).toBe(true);
      expect(restored?.parts?.[0]?.coverage?.members).toHaveLength(MEMBERS);
      undo.destroy();
    }, 60_000);
  });

test("a receipt that moves on a re-check keeps its id and the sign-off on it", () => {
  const sentence = "Costs rose and headcount stayed flat.";
  const documentId = randomUUID();
  const quote = toLength("Costs rose in the third quarter while headcount stayed flat. ", 400);
  const given = [0, 1, 2, 3, 4].map((seed) =>
    receipt(documentId, seed, { quote: `${quote.slice(0, 396)}${String(seed).padStart(4, "0")}` }),
  );
  const [a, b, c, d, moving] = given;
  if (!a || !b || !c || !d || !moving) throw new Error("The fixture needs five receipts.");
  const basis = checkBasis(sentence, documentId);
  // The receipt that moves is the fifth of its part: the model cited it last.
  const previous = checkWithParts(
    basis,
    namePartCitations([partWithReceipts([a, b, c, d, moving], 0)]),
  );
  const stored = previous.parts?.[0]?.evidence[4];
  if (!stored?.id) throw new Error("The fifth receipt kept no id.");
  expect(stored.quote?.length).toBeGreaterThan(150);
  const signOff: SignOffRecord = {
    id: randomUUID(),
    target: { kind: "citation", id: stored.id },
    at: "2026-10-30T09:00:00.000Z",
    contentHash: citationSignOffBasis(sentence, stored),
    deletedAt: null,
    name: "Ada Lovelace",
    personId: "person-1",
  };
  // The next check names it first, as the receipt that decides the part now.
  const after = checkWithParts(
    basis,
    namePartCitations(
      boundedCheckParts([partWithReceipts([moving, a, b, c, d], 0)]),
      previous.parts ?? [],
    ),
  );
  const kept = after.parts?.[0]?.evidence[0];
  expect(kept?.id).toBe(stored.id);
  expect(kept?.quote?.length).toBeGreaterThan(150);
  if (!kept) throw new Error("The receipt that moved is gone.");
  expect(signOffShown(signOff, citationSignOffBasis(sentence, kept), [kept], null).state).toBe(
    "checked",
  );
});

test("a check through the engine stores a bounded quote, and a re-check keeps its receipt's id", async () => {
  const quote = `${"Costs rose across every region while headcount stayed flat. ".repeat(8)}`.slice(
    0,
    400,
  );
  const sentence = "Costs rose across every region while headcount stayed flat.";
  const plans = { [sentence]: { verdict: "supported" as const, quote } };
  const model = scriptedModel((call) => checkReply(call, plans), {
    generate: checkGenerate(plans),
  });
  const setup = await setUpWithDocuments(model, [{ name: "Costs.md", contents: quote }]);
  writeMind(setup.client, [
    {
      type: "paragraph",
      attrs: { id: randomUUID() },
      content: [{ type: "text", text: sentence }],
    },
  ]);
  await setup.client.settled();
  await setup.core.checkMind({
    requestId: randomUUID(),
    mindId: setup.mind.id,
    mode: "all",
  });
  await setup.client.settled();
  const first = claimSpans(readMind(setup.client))[0]?.check;
  expect(first?.state).toBe("supported");
  expect(first?.evidence?.quote?.length).toBeLessThanOrEqual(CHECK_QUOTE_CHARS_AT_MOST);
  expect(first?.evidence?.quote?.startsWith(quote.slice(0, 20))).toBe(true);
  expect(first?.parts?.[0]?.evidence[0]?.quote?.length).toBeLessThanOrEqual(
    CHECK_QUOTE_CHARS_AT_MOST,
  );
  const receiptId = first?.parts?.[0]?.evidence[0]?.id;
  expect(typeof receiptId).toBe("string");
  await setup.core.checkMind({
    requestId: randomUUID(),
    mindId: setup.mind.id,
    mode: "all",
  });
  await setup.client.settled();
  expect(claimSpans(readMind(setup.client))[0]?.check.parts?.[0]?.evidence[0]?.id).toBe(receiptId);
}, 60_000);
