/**
 * A Chinese PDF's title and headings with no full stop (#3288): the Library's text keeps each on a
 * line of its own, and so do the Note's blocks and the claims a check of the file finds, whether
 * the page sets them in the size of the text under them or a size of their own.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { verificationOf } from "../../src/shared/verification";
import { sortReply } from "../helpers/claimSentences";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf, type PdfPage } from "../helpers/pdf";

const TITLE = "老旧小区加装电梯情况报告";
const HEADINGS = ["概述", "主要发现", "建议"];
// Sentences the page wraps over three lines and over two.
const FIRST_LINES = [
  "全市今年共有一百八十六个老旧小区申请加装电梯，其中已经完工的有七十四个，",
  "另有三十二个正在施工，四十个已经通过公示，其余的小区还在征求住户意见，",
  "预计明年年底以前全部完成。",
];
const SECOND_LINES = [
  "晚间平均每小时到馆的有四十六人，下午为三十一人，周末的人数高于工作日，",
  "需要继续观察到年底，再决定是否推广。",
];
const FIRST = FIRST_LINES.join("");
const SECOND = SECOND_LINES.join("");
const THIRD = "继续试行延长开放时间，并在明年第一季度复查到馆人数，公布每个社区的结果。";

const PRINTED = [TITLE, "概述", ...FIRST_LINES, "主要发现", ...SECOND_LINES, "建议", THIRD];
const PARAGRAPHS = [TITLE, "概述", FIRST, "主要发现", SECOND, "建议", THIRD];

const larger = (text: string) => text === TITLE || HEADINGS.includes(text);

const VARIANTS: [string, PdfPage][] = [
  ["all in one size", { chineseLines: PRINTED }],
  ["the title larger", { printed: [{ text: TITLE, size: 16 }], chineseLines: PRINTED.slice(1) }],
  [
    "the title and headings larger",
    { printed: PRINTED.map((text) => ({ text, size: larger(text) ? 13 : 11 })) },
  ],
];

/** A model that finds each sentence a claim, and the title and headings bare titles. */
const sortingModel = () =>
  scriptedModel(() => ({ text: "" }), {
    generate: (call) => ({
      text: sortReply(call.prompt, (text) => (larger(text) ? "no" : "claim")),
    }),
  });

describe("A Chinese PDF's headings with no full stop", { timeout: 30_000 }, () => {
  // protects=a Chinese PDF's title and headings with no full stop stay apart from the sentence under them in the Library's text, the Note and its claims, and a sentence the page wrapped stays whole (#3288); fails_when=a heading the same size as the title joins it, or the check runs a heading into the sentence under it so a claim begins with the heading
  test.each(VARIANTS)(
    "%s: each is a paragraph of its own, and no claim begins with one",
    async (_, page) => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(sortingModel()).createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const sources = await createTempDataFolder();
      // A check needs a Library to check against.
      await addAndProcess(core, [await writeSourceFile(sources, "台账.md", "加装电梯台账。")]);
      const path = await writeSourceFile(sources, "电梯报告.pdf", buildPdf([page]));

      const result = await core.verifyDocument({ path });
      if (!result.ok) throw new Error(`The report wasn't verified: ${result.reason}`);
      const { pages } = await core.readDocumentText(result.documentId);
      expect(pages.map((each) => each.text)).toEqual([PARAGRAPHS.join("\n")]);

      const client = await connectToMind(core, result.mind.id);
      await client.settled();
      const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
      expect(blocks.map((block) => block.content?.[0]?.text)).toEqual(PARAGRAPHS);

      expect(
        await core.findClaims({ requestId: crypto.randomUUID(), mindId: result.mind.id }),
      ).toEqual({ kind: "found", claims: 3 });
      await client.settled();
      expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
        FIRST,
        SECOND,
        THIRD,
      ]);
      await core.close();
    },
  );
});
