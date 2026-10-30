/**
 * What a bounded check still shows (#2220): a sentence whose parts, receipts, coverage members
 * and quotes are all past the bound keeps every one of them, with the place they name, so its
 * card lists each row, the check record names its deciding receipt, and Undo brings the whole
 * check back. English and Simplified Chinese.
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
  CHECK_MEMBERS_AT_MOST,
  CHECK_PARTS_AT_MOST,
  CHECK_QUOTE_CHARS_AT_MOST,
  CHECK_RECEIPTS_AT_MOST,
  CHECK_REFERENCE_QUOTE_CHARS,
} from "../../src/shared/claimParts";
import { cardRows } from "../../src/shared/claimRows";
import { translate } from "../../src/shared/i18n";
import { sentenceMark } from "../helpers/checkBounds";
import { checkGenerate, checkReply } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { recordRows } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

const PARTS = 12;
const RECEIPTS = 6;
const MEMBERS = 30;
const CHARACTERS = 500;

const cases = [
  {
    language: "en",
    sentence:
      "Twelve places back the summary, with six receipts for each, and thirty months of quantities.",
    quote:
      `${"Costs rose 12 percent in the third quarter while headcount stayed flat. ".repeat(10)}`.slice(
        0,
        CHARACTERS,
      ),
  },
  {
    language: "zh-CN",
    sentence: "十二处依据支撑这段总结，每一处各有六条引文，并列出三十个月的数量。",
    // An astral character at the bound, so a cut that splits it would show.
    quote:
      `${"前三季度成本上升百分之十二，员工人数保持不变，收入持续增长。".repeat(20)}`.slice(0, 198) +
      "𠀀" +
      `${"收入与成本的变化在各地一致。".repeat(10)}`.slice(0, CHARACTERS - 200),
  },
] as const;

for (const example of cases)
  describe(example.language, () => {
    test("a sentence past every bound still lists every part and receipt", async () => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const out = await createTempDataFolder();
      const printer = fakePrinter();
      const core = startCore(dataDir, { printer: printer.printer });
      await core.setOutputLocation(out);
      const file = await writeSourceFile(sources, "Quarter.txt", example.quote);
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

      // The card: a row for each part, and for each member of the quantified part, each with
      // its receipts, every one still naming its Document and place.
      const check = claimSpans(readMind(client))[0]?.check;
      if (!check?.parts) throw new Error("The sentence kept no check.");
      expect(check.parts).toHaveLength(PARTS);
      expect(cardRows(check.parts)).toHaveLength(PARTS - 1 + MEMBERS);
      for (const [index, part] of check.parts.entries()) {
        expect(part.evidence).toHaveLength(RECEIPTS);
        for (const [at, receipt] of part.evidence.entries()) {
          expect(receipt.id).toBeTruthy();
          expect(receipt.documentId).toBe(document.id);
          expect(receipt.location).not.toBeNull();
          expect(receipt.quote).toBeTruthy();
          expect(receipt.quote?.isWellFormed()).toBe(true);
          expect(receipt.quote?.length).toBeLessThanOrEqual(
            index < CHECK_PARTS_AT_MOST && at < CHECK_RECEIPTS_AT_MOST
              ? CHECK_QUOTE_CHARS_AT_MOST
              : CHECK_REFERENCE_QUOTE_CHARS,
          );
        }
      }
      const coverage = check.parts[0]?.coverage;
      expect(coverage?.members.map((member) => member.label)).toEqual(
        Array.from({ length: MEMBERS }, (_, member) => `Month ${member + 1}`),
      );
      for (const [index, member] of (coverage?.members ?? []).entries()) {
        const receipt = member.evidence[0];
        expect(member.verdict).toBe("supported");
        expect(receipt?.id).toBeTruthy();
        expect(receipt?.quote).toBeTruthy();
        expect(receipt?.quote?.isWellFormed()).toBe(true);
        expect(receipt?.quote?.length).toBeLessThanOrEqual(
          index < CHECK_MEMBERS_AT_MOST ? CHECK_QUOTE_CHARS_AT_MOST : CHECK_REFERENCE_QUOTE_CHARS,
        );
      }
      expect(check.state).toBe("supported");
      expect(check.evidence?.quote).toBeTruthy();
      expect(check.evidence?.quote?.length).toBeLessThanOrEqual(CHECK_QUOTE_CHARS_AT_MOST);

      // The check record: the sentence's row, its Document and the quote that decided it.
      const saved = await core.saveCheckRecord(mind.id);
      if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
      const name = saved.file.name.replace(/\.(pdf|csv)$/, "");
      const rows = recordRows(readFileSync(join(out, `${name}.csv`), "utf8"));
      const row = rows.find((each) => each.Kind === "Sentence");
      expect(row?.Sentence).toContain(example.sentence);
      expect(row?.Result).toBe(translate("en", SENTENCE_RESULT_LABELS.supported));
      expect(row?.Document).toBe(document.name);
      expect(row?.Quote).toBeTruthy();
      expect(row?.Quote?.slice(0, 20)).toBe(example.quote.slice(0, 20));

      // Undo: the check comes back whole, every part and receipt.
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
