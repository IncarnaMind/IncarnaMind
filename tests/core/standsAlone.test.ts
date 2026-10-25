import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import { asksAboutEarlier, withoutPointersBack } from "../../src/core/answers/pointersBack";
import { pageBlocks } from "../../src/shared/answerBlocks";
import type { NodeJSON } from "../../src/shared/blockJson";
import { askAssistant, lastResult } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import {
  type ModelCall,
  promptOf,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * Text that goes into a page stands on its own (#1172): once a write is
 * whole, a paragraph that is only a pointer to an earlier Answer goes from
 * what the assistant writes into a Mind and from an Answer as Add to note
 * puts it in a page, never from the Answer in the panel. Everything else
 * stays as written.
 */

const OWN = "Pay is 5k a month [^1].";

describe("Paragraphs that are only a pointer", () => {
  // protects=a paragraph that is one listed pointer sentence and nothing else goes, in English and Chinese; fails_when=it stays; no_claim=every wording a model may use.
  test.each([
    "See my earlier answer.",
    "See my earlier answer for notice and holiday.",
    "Please refer to my previous response for the full breakdown.",
    "For more detail, see my earlier answer.",
    "(See my earlier answer.)",
    "Notice, holiday and home working are covered in my earlier answer.",
    "Details are in my earlier answer.",
    "I covered holiday in my earlier answer.",
    "As mentioned above.",
    "Covered above.",
    "居家办公的规定见上一条回答。",
    "具体数据集和消融结果可参见前一条回答。",
    "这些内容在上一条回答中已经说明。",
    "请参考前面的回答。",
    "更多信息，请参见上一条回答。",
    "如上所述。",
  ])("%s", (pointer) => {
    expect(withoutPointersBack(`${OWN}\n\n${pointer}`)).toEqual({
      markdown: OWN,
      removed: 1,
      left: 0,
    });
  });

  // protects=the same pointer inside a paragraph with other text, and any sentence that says more, stays exactly as written and is counted, a correction and a figure in Chinese numerals included; fails_when=it is cut or not counted; no_claim=none beyond protects.
  test.each([
    "Pay is 5k. See my earlier answer.",
    "Role: software engineer. Notice, holiday and home working are covered in my earlier answer.",
    "合同期三年。居家办公的规定见上一条回答。",
    "I made an error in my previous answer and the correct total excludes VAT.",
    "The notice period, as covered in my earlier answer, is three months.",
    "我在上一条回答中弄错了租期实际应为三年",
    "年假十五天见上一条回答。",
    "试用期三个月详见上一条回答",
    "押金五千元与上一条回答一致。",
    "如上所述，试用期是三个月。",
  ])("%s", (paragraph) => {
    const text = `${OWN}\n\n${paragraph}`;
    expect(withoutPointersBack(text)).toEqual({ markdown: text, removed: 0, left: 1 });
  });

  // protects=a heading, a lead-in, a list, a table, a quote, code, a bold or hard-wrapped line and a cited pointer are never taken out, whatever they say, nor a fact on a lead-in or a label; fails_when=any of it changes; no_claim=none beyond protects.
  test.each([
    "- See my earlier answer.",
    "- Notice: see my earlier answer.\n- Pay: 5k a month.",
    "## See above",
    "> See above.",
    "| Term | Where |\n|---|---|\n| Notice | See my earlier answer. |",
    "```text\nSee my earlier answer.\n```",
    "**See above.**",
    "See my earlier\nanswer.",
    "“如上所述。”",
    'The lease says: "Rent is due monthly. See above." [^2]',
    "Covered in my earlier answer.[^2]",
    "Pay is 5k a month [^2]. The other terms are:\n\n- See my earlier answer for notice.\n- Holiday is covered above.",
    "月薪 18,000 元[^2]。其余条款如下：\n\n- 通知期见上一条回答。\n- 年假见上文。",
    "Our first response is due in 24 hours.",
    "The previous answer on the form was left blank.",
  ])("%s", (written) => {
    const text = `${OWN}\n\n${written}`;
    expect(withoutPointersBack(text)).toMatchObject({ markdown: text, removed: 0 });
  });

  // protects=a lead-in or a label that carries a fact stays when the pointer under it goes; fails_when=the fact goes with the pointer; no_claim=none beyond protects.
  test.each([
    [
      "**Total: £45,000**\n\nSee my earlier answer for the workings.\n\nVAT is extra.",
      "**Total: £45,000**\n\nVAT is extra.",
    ],
    [
      "The deposit is £5,000, refundable in these cases:\n\nSee my earlier answer.",
      "The deposit is £5,000, refundable in these cases:",
    ],
    ["## Terms\n\nSee my earlier answer.\n\n## Pay\n\nSee above.", "## Terms\n\n## Pay"],
  ])("%s", (text, kept) => {
    expect(withoutPointersBack(text).markdown).toBe(kept);
  });

  // protects=text that is nothing but a pointer is given back as it was, and counted; fails_when=it comes back empty or uncounted; no_claim=none beyond protects.
  test("text that is only a pointer stays as it was", () => {
    expect(withoutPointersBack("See my earlier answer.")).toEqual({
      markdown: "See my earlier answer.",
      removed: 0,
      left: 1,
    });
  });

  // protects=a Question about an earlier Answer is told apart from one that isn't, in English and Chinese; fails_when=an ordinary request reads as one about an earlier Answer, or the other way round; no_claim=none beyond protects.
  test("a Question about an earlier Answer", () => {
    expect(asksAboutEarlier("Where did your earlier answer cover the notice period?")).toBe(true);
    expect(asksAboutEarlier("What did you say about the pension?")).toBe(true);
    expect(asksAboutEarlier("你刚才说的年假是多少天？")).toBe(true);
    expect(asksAboutEarlier("上一条回答里的年假是多少天？")).toBe(true);
    expect(asksAboutEarlier("Write a short summary of this agreement.")).toBe(false);
    expect(asksAboutEarlier("When is the first response due under the agreement?")).toBe(false);
    expect(asksAboutEarlier("请为这份合同写一个简短的摘要。")).toBe(false);
  });
});

async function setUp(script: (call: ModelCall) => ScriptedReply, chunkSize?: number) {
  const model = scriptedModel(script, { chunkSize });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "" });
  return { core, model, mind };
}

const textOf = (block: NodeJSON): string =>
  block.text ?? (block.content ?? []).map(textOf).join("");

const pageText = (blocks: readonly NodeJSON[]) => blocks.map(textOf).join("\n");

const shapeOf = (doc: ProseMirrorNode) => {
  const shape: string[] = [];
  doc.forEach((block) => {
    if (block.textContent.trim() !== "") shape.push(`${block.type.name}: ${block.textContent}`);
  });
  return shape;
};

async function written(content: string, streamInput: boolean, chunkSize = 4) {
  const { core, model, mind } = await setUp(
    ({ results }) =>
      results.length === 0
        ? { calls: [{ tool: "add_to_mind", input: { content }, streamInput }] }
        : { text: "Done." },
    chunkSize,
  );
  await askAssistant(core, { text: "Add this to my notes", mindId: mind.id });
  const client = await connectToMind(core, mind.id);
  await client.settled();
  return { shape: shapeOf(readMind(client)), told: lastResult(model) };
}

const PANEL = [
  {
    language: "English",
    question: "Summarise this agreement for my manager.",
    reply:
      "The agreement employs D. Reyes as a software engineer.\n\nNotice, holiday and home working are covered in my earlier answer.",
    inPage: "The agreement employs D. Reyes as a software engineer.",
  },
  {
    language: "Chinese",
    question: "请为这份合同写一个简短的摘要。",
    reply: "这份合同聘用李明为物流专员。\n\n居家办公的规定见上一条回答。",
    inPage: "这份合同聘用李明为物流专员。",
  },
  {
    language: "English, a correction",
    question: "Check the total again.",
    reply: "I made an error in my previous answer and the correct total excludes VAT.",
    inPage: "I made an error in my previous answer and the correct total excludes VAT.",
  },
  {
    language: "Chinese, a correction",
    question: "再核对一下租期。",
    reply: "我在上一条回答中弄错了租期，实际应为三年。",
    inPage: "我在上一条回答中弄错了租期，实际应为三年。",
  },
];

const WRITES = [
  ["See my earlier answer.\n\n## Pay\n\nPay is 5k a month.", "## Pay\n\nPay is 5k a month."],
  [
    "See my earlier answer.\n\n- Pay is 5k a month.\n- Bonus is 1k.",
    "- Pay is 5k a month.\n- Bonus is 1k.",
  ],
  [
    "See my earlier answer.\n\n| Item | Cost |\n|---|---|\n| Rent | 5k |\n\nTotal is 5k.",
    "| Item | Cost |\n|---|---|\n| Rent | 5k |\n\nTotal is 5k.",
  ],
  ["See my earlier answer.\n\n```sql\nselect 1;\n```\n\nDone.", "```sql\nselect 1;\n```\n\nDone."],
  ["详见上一条回答。\n\n- 月薪 18,000 元。\n- 年假 15 天。", "- 月薪 18,000 元。\n- 年假 15 天。"],
  ["## Terms\n\nSee my earlier answer.\n\n## Pay\n\nSee above.", "## Terms\n\n## Pay"],
  [
    "**Total: £45,000**\n\nSee my earlier answer for the workings.\n\nVAT is extra.",
    "**Total: £45,000**\n\nVAT is extra.",
  ],
  [
    "Pay is 5k a month. The other terms are:\n\n- See my earlier answer for notice.\n- Holiday is covered above.\n\nBonus is 1k.",
    "Pay is 5k a month. The other terms are:\n\n- See my earlier answer for notice.\n- Holiday is covered above.\n\nBonus is 1k.",
  ],
  [
    "Pay is 5k a month. See my earlier answer.\n\n合同写道：“如上所述。”",
    "Pay is 5k a month. See my earlier answer.\n\n合同写道：“如上所述。”",
  ],
] as const;

const CHUNKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 40];

const SPRING = "Spring tides happen at new moon and at full moon";

const TIDES = {
  name: "Tides.md",
  contents: `# Tides\n\n${SPRING}, when the Sun and the Moon pull together.\n`,
};

function citationChecks(doc: ProseMirrorNode): string[] {
  const checks: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "citation") checks.push(String(node.attrs.check));
    return true;
  });
  return checks;
}

describe("Through the assistant", { timeout: 30_000 }, () => {
  for (const each of PANEL) {
    // protects=the panel keeps the model's words, and Add to note puts them in a page without a paragraph that is only a pointer, but with a correction whole; the instructions ask for no pointers; fails_when=the panel is changed, a pure pointer goes into the page, or a correction loses words; no_claim=how often a real model writes one (eval/everyday).
    test(`the panel keeps the model's words, and the page loses only a pure pointer (${each.language})`, async () => {
      const { core, model, mind } = await setUp(() => ({ text: each.reply }));

      const answer = await askAssistant(core, { text: each.question, mindId: mind.id });

      expect(answer.text).toBe(each.reply);
      expect(pageText(pageBlocks(answer, each.question))).toBe(each.inPage);
      const system = promptOf(model)[0]?.text ?? "";
      expect(system).toContain("Never send the reader to an earlier Answer");
      expect(system).toContain("见上一条回答");
    });
  }

  // protects=asked about an earlier Answer, the page may say where it was too; fails_when=its pointer is taken out; no_claim=none beyond protects.
  test("asked about an earlier Answer, the page keeps what points to it", async () => {
    const reply = "Yes.\n\nSee my earlier answer.";
    const question = "Did your earlier answer cover the notice period?";
    const { core, mind } = await setUp(() => ({ text: reply }));

    const answer = await askAssistant(core, { text: question, mindId: mind.id });

    expect(pageText(pageBlocks(answer, question))).toBe("Yes.\nSee my earlier answer.");
  });

  for (const [content, lands] of WRITES) {
    // protects=written into a Mind, whole or streamed in chunks of 1 to 40 characters, only a paragraph that is a pointer goes, and every other Block lands as it was, in English and Chinese; fails_when=a Block is lost, moved or doubled at any chunk size; no_claim=none beyond protects.
    test(`${JSON.stringify(content)}, whole and streamed`, { timeout: 120_000 }, async () => {
      const { shape: expected } = await written(lands, false);
      const wrong: string[] = [];
      for (const [streamInput, chunk] of [
        [false, 4] as const,
        ...CHUNKS.map((size) => [true, size] as const),
      ]) {
        const { shape } = await written(content, streamInput, chunk);
        if (JSON.stringify(shape) !== JSON.stringify(expected)) {
          wrong.push(
            `${streamInput ? `streamed, chunk ${chunk}` : "whole"}: ${JSON.stringify(shape)}`,
          );
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  // protects=the model is told when a paragraph that only pointed was left out of what it wrote, and isn't when a pointer stays inside a paragraph; fails_when=it isn't told, or is told of a cut that wasn't made; no_claim=none beyond protects.
  test("the model is told only of a pointer left out", async () => {
    const cut = await written("The agreement employs D. Reyes.\n\nSee my earlier answer.", false);
    expect(cut.shape).toEqual(["paragraph: The agreement employs D. Reyes."]);
    expect(cut.told).toContain("1 sentence that only pointed to an earlier Answer was left out");
    const kept = await written("The agreement employs D. Reyes. See my earlier answer.", false);
    expect(kept.shape).toEqual([
      "paragraph: The agreement employs D. Reyes. See my earlier answer.",
    ]);
    expect(kept.told).not.toContain("only pointed to an earlier Answer");
  });

  // protects=a sentence whose source is written as its name in brackets keeps its claim and its Citation lands; fails_when=it is taken out or loses its Citation; no_claim=none beyond protects.
  test("a sentence citing a source written as text keeps its claim", async () => {
    const content =
      "Tides follow the moon.\n\nSpring tides are described in my earlier answer [Tides, p. 1].";
    const model = scriptedModel((call): ScriptedReply => {
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, quote: SPRING };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      return call.results.filter((result) => result.tool === "add_to_mind").length > 1
        ? { text: "Done." }
        : { calls: [{ tool: "add_to_mind", input: { content } }] };
    });
    const { core, mind, client } = await setUpWithDocuments(model, [TIDES]);

    await askAssistant(core, { text: "Add what the tides file says", mindId: mind.id });
    await client.settled();

    const page = readMind(client);
    expect(page.textContent).toContain("Spring tides are described in my earlier answer");
    expect(citationChecks(page)).toEqual(["found"]);
  });
});
