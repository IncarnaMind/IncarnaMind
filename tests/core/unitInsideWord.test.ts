/**
 * A unit character that begins a word names no unit (#2251): 米 in 每米勒公司, 升 in 每升学, 吨 in
 * «单位：吨位分析». After 每 and after 单位：, where a unit's name is free to run on, the word
 * segmenter says whether the character stands alone, so a sentence that adds the unit to a plain
 * number is never a ✓ for it, alone or in a Note, and a real unit still counts.
 */
import { expect, test } from "vitest";
import { unitNotStated } from "../../src/core/answers/checks/units";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readStatedUnits } from "../../src/shared/figures";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";

interface Cited {
  quote: string;
  number: string;
  /** The line the model gives as the number's unit line, as a real model gave «单位：吨位分析». */
  unitQuote?: string;
}

/** What `claim` ends as, the model calling it supported from `cited`: alone, and in a Note. */
async function checked(claim: string, document: string, cited: Cited) {
  const plan: Plan = { verdict: "supported", says: cited.quote, ...cited };
  const { core, client, mind } = await setUpWithDocuments(checkingModel({ [claim]: plan }), [
    { name: "Report.txt", contents: `Report\n${document}\n` },
  ]);
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "deepseek",
    apiKey: "sk-test",
    modelId: "deepseek-flash",
  });
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
  const alone = (await core.checkClaim({ claim })).verdict;
  writeMind(client, [
    { type: "paragraph", attrs: { id: "block-1" }, content: [{ type: "text", text: claim }] },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "block-1", offset: 0 },
    to: { blockId: "block-1", offset: claim.length },
  });
  await client.settled();
  const [span] = claimSpans(readMind(client));
  core.close();
  return { alone, inNote: span?.check.state };
}

const read = (cited: string) => [{ cited: () => cited, document: () => cited }];

// protects=after 每 a unit character the word segmenter joins to what follows begins a word and writes no measure, so the unit a sentence adds to a plain number is found: 米 in 每米勒公司, 升 in 每升学 and 每升任; fails_when=a name, a school year or a promotion after 每 lets an invented unit through; no_claim=a word the segmenter splits (克 before 和, 吨 before 钢厂)
test.each([
  ["路线长54米。", "每米勒公司一份，路线长54", "54"],
  ["数量为54升。", "每升学一次登记一份，数量为54", "54"],
  ["数量为54升。", "每升任一次登记一份，数量为54", "54"],
])("%s against %j gives %s", (claim, cited, amount) => {
  expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
});

// protects=a real unit after 每 still writes its measure, whatever noun follows it, and a unit after a currency's slash is left to the rule it had ("8元/升至10元"), so a right sentence keeps its ✓; fails_when=the segmenter's test takes a unit from 每米布料, 每升汽油, 每吨煤, 每克黄金 or 每桶原油, or reaches a price's slash; no_claim=每升水, which the segmenter reads as the word 升水
test.each([
  ["路线长54米。", "每米布料30元，路线长54"],
  ["容量为54升。", "每升汽油8元；容量54"],
  ["产量为54,000吨。", "每吨煤800元，产量54,000"],
  ["重量为54克。", "每克黄金600元，重量54"],
  ["容量为54升。", "价格8元/升至10元，容量54"],
  ["产量为54,000桶。", "每桶原油80美元，产量54,000"],
])("%s against %j isn't flagged", (claim, cited) => {
  expect(unitNotStated(claim, read(cited))).toBeNull();
});

// protects=a unit line states its unit only where the unit is a word of its own: 吨 in «单位：吨位分析» is the start of 吨位, while a next line a PDF joined to the unit («单位：吨产量») leaves it standing; fails_when=吨位分析 reads as tonnes, or a joined line loses the unit
test("a unit line's unit is a word of its own", () => {
  expect(readStatedUnits("单位：吨位分析")).toEqual([]);
  expect(readStatedUnits("单位：吨产量").map(({ unit }) => unit)).toEqual([
    { kind: "other", word: "吨" },
  ]);
  expect(readStatedUnits("单位：吨").map(({ unit }) => unit)).toEqual([
    { kind: "other", word: "吨" },
  ]);
});

// protects=through the core, a model's Supported doesn't stand for a unit the Document never writes, alone or in a Note, where the unit's character only begins a word (DeepSeek V4.1 Flash called both sentences supported in 2 of 2 rounds, and gave «单位：吨位分析» as the unit line); fails_when=either path ends supported
test.each([
  {
    claim: "路线长54米。",
    document: "每米勒公司一份，路线长54",
    cited: { quote: "每米勒公司一份，路线长54", number: "54" },
  },
  {
    claim: "产量为54,000吨。",
    document: "单位：吨位分析\n产量\t54,000",
    cited: { quote: "产量\t54,000", number: "54,000", unitQuote: "单位：吨位分析" },
  },
])("$claim against $document is no ✓, alone or in a Note", async ({ claim, document, cited }) => {
  const { alone, inNote } = await checked(claim, document, cited);

  expect(alone).not.toBe("supported");
  expect(inNote).not.toBe("supported");
});

// protects=through the core, a right sentence keeps the model's ✓ in both paths where the unit is a real one: after 每 before a noun, and on a unit line; fails_when=the segmenter's test costs either its ✓
test.each([
  {
    claim: "路线长54米。",
    document: "每米布料30元，路线长54",
    cited: { quote: "每米布料30元，路线长54", number: "54" },
  },
  {
    claim: "产量为54,000吨。",
    document: "单位：吨\n产量\t54,000",
    cited: { quote: "产量\t54,000", number: "54,000", unitQuote: "单位：吨" },
  },
])("$claim against $document keeps its ✓", async ({ claim, document, cited }) => {
  expect(await checked(claim, document, cited)).toEqual({
    alone: "supported",
    inNote: "supported",
  });
});
