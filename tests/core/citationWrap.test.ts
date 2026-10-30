import { expect, test } from "vitest";
import {
  answerEnded,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { buildPdf } from "../helpers/pdf";

/** The sample quarterly announcement of #2110: the wrap falls inside "7 月起". */
const CHINESE_LINES = [
  "线上毛利率由上年同期的 37.5% 降至 32.1%：配送成本上升，7",
  "月起免运费门槛又下调至 40 英镑。",
];
const WRAPPED_QUOTE = "配送成本上升，7月起免运费门槛又下调至 40 英镑";

/** An English line break is a real space between words: kept, and still matched across. */
const ENGLISH_LINES = [
  "Online gross margin fell to 32.1% from 37.5% a year",
  "earlier: delivery costs rose, and the free-delivery threshold was cut to £40 in July.",
];

test("a Chinese PDF's line wrap is joined in the Passage the model reads, and a quote across it is found whole", async () => {
  let shown: ShownPassage[] = [];
  const model = citingModel({
    query: "配送成本",
    records: (passages) => {
      shown = passages;
      return [{ marker: 1, passage: passages[0]?.id, quote: WRAPPED_QUOTE }];
    },
    answer: "Delivery costs rose [^1].",
  });
  const { core } = await setUpWithDocuments(model, [
    { name: "季度公告.pdf", contents: buildPdf([{ chineseLines: CHINESE_LINES }]) },
  ]);

  const asked = await core.askInConversation({ text: "配送成本为何上升？" });
  if (!asked.asked) throw new Error("Question not asked");
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed");

  expect(shown[0]?.text).toContain("配送成本上升，7月起免运费门槛又下调至 40 英镑");
  expect(shown[0]?.text).not.toContain("7\n月");
  expect(ended.payload.citations).toHaveLength(1);
  expect(ended.payload.citations[0]).toMatchObject({ check: "found", quote: WRAPPED_QUOTE });
});

test("an English PDF keeps its line break, and a quote across it is found whole", async () => {
  let shown: ShownPassage[] = [];
  const quote = "Online gross margin fell to 32.1% from 37.5% a year earlier";
  const model = citingModel({
    query: "online gross margin",
    records: (passages) => {
      shown = passages;
      return [{ marker: 1, passage: passages[0]?.id, quote }];
    },
    answer: "Online margin fell to 32.1% [^1].",
  });
  const { core } = await setUpWithDocuments(model, [
    { name: "Q3 2026 results.pdf", contents: buildPdf([{ lines: ENGLISH_LINES }]) },
  ]);

  const asked = await core.askInConversation({ text: "What did the online gross margin fall to?" });
  if (!asked.asked) throw new Error("Question not asked");
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error("The Answer failed");

  expect(shown[0]?.text).toContain("37.5% a year\nearlier");
  expect(ended.payload.citations).toHaveLength(1);
  expect(ended.payload.citations[0]).toMatchObject({ check: "found", quote });
});
