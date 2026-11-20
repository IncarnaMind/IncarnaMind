import { basename } from "node:path";
import type { Language } from "../../src/core/language";
import type { ChatLanguageModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../../tests/helpers/documents";

const documents = {
  en: [
    [
      "Investor meeting",
      "Our repair shop has 740 subscribers. We are raising a seed round of $800,000. These slides explain our fundraising target, the equity on offer and how long the proceeds will last.",
    ],
    [
      "Privacy notice",
      "We operate a repair shop. This notice explains which contact details we retain, how to ask for deletion and when records expire. It covers everyone who books a repair.",
    ],
    [
      "Friday estimate",
      "The kitchen remodel needs new base cabinets and a longer worktop. The fitter has allowed two days to disconnect the sink and fit the replacement.",
    ],
    [
      "Decision record",
      "For the kitchen refurbishment we chose oak cupboards and moved the sink to the window. Next week we will sign off the stone counter template.",
    ],
    [
      "Travel claim",
      "Please reimburse my rail fare for the regional choir rehearsal. The departure station was beside a kitchen showroom. Ticket and proof of payment attached.",
    ],
    [
      "Choir rehearsal",
      "Tenors will arrive at six to rehearse the final chorus. The conductor mentioned her kitchen renovation before rehearsal. Singers should learn bars 24 to 39 for Sunday.",
    ],
  ],
  "zh-CN": [
    [
      "给投资人的演示",
      "我们的修理铺已有七百多位订户。这次种子轮要融资六百万元，演示稿逐页说明拟出让的股权、募资用途和下一轮之前的现金安排。",
    ],
    [
      "隐私声明",
      "本修理铺向预约服务的人收集姓名和联系方式。本声明说明保存期限、申请删除资料的方法，以及谁可以查询预约记录。",
    ],
    [
      "施工报价",
      "厨房要重新装修。拆除旧橱柜后要找平地面，重新铺设水槽管道，再安装定制台面。报价分为人工和材料。",
    ],
    [
      "现场确认单",
      "厨房改造今天定下了橱柜颜色，水槽改到窗边。下周请石材师傅测量台面并确认灶具开孔。",
    ],
    [
      "车票报销",
      "为参加合唱团联排，申请报销往返城际车票。车站在一家厨具店旁边。附付款记录及车票。",
    ],
    [
      "排练安排",
      "本周只排最后一个乐章，男高音六点到。指挥闲聊时提到家里正装修厨房。请所有团员在周日前练熟第二十四至三十九小节。",
    ],
  ],
} as const;

function accepts(
  tags: readonly { kind: string | null; tagId: string | null }[],
  wanted: string | null,
) {
  const topics = tags.filter((tag) => !tag.kind);
  return wanted === null ? topics.length === 0 : topics.length === 1 && topics[0]?.tagId === wanted;
}

export async function hardCases(model: ChatLanguageModel, language: Language) {
  if (
    [[], [{ kind: null, tagId: "other" }], [{ kind: null, tagId: null }]].some((tags) =>
      accepts(tags, "expected"),
    ) ||
    !accepts([{ kind: null, tagId: "expected" }], "expected")
  )
    throw new Error("Invalid Tag identity control");
  const core = startCore(await createTempDataFolder(), { createChatModel: () => model });
  try {
    await core.updateSettings({ user: { language } });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "eval" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "eval" } },
      automatic: false,
    });
    const en = language === "en";
    const kitchen = await core.createTag({ name: en ? "厨房装修" : "Kitchen renovation" });
    const fundraising = await core.createTag({ name: en ? "Fundraising" : "融资" });
    const business = await core.createTag({ name: en ? "Repair shop" : "修理铺" });
    const source = await createSourceFolder();
    const write = (name: string, body: string) => writeSourceFile(source, `${name}.txt`, body);
    const [member] = await addAndProcess(core, [
      await write(
        "A0",
        en
          ? "厨房装修，更新橱柜与水槽，确定台面材料。"
          : "Kitchen renovation. Replace the cabinets, counters and sink.",
      ),
    ]);
    if (!member) throw new Error("Missing anchor Document");
    await core.addDocumentTag(member.id, kitchen.id);
    const paths = await Promise.all(documents[language].map(([name, body]) => write(name, body)));
    const wants = [fundraising.id, null, kitchen.id, kitchen.id, null, null];
    const expected = new Map(paths.map((path, i) => [basename(path).normalize(), wants[i]]));
    const docs = await addAndProcess(core, paths);
    if (docs.length !== paths.length) throw new Error("Missing hard-case Document");
    const result = await core.tagDocuments({ documentIds: docs.map((doc) => doc.id) });
    if (result.status !== "done") throw new Error(`Re-tag ended with ${result.status}`);
    if (result.taggingFailed || result.documents !== docs.length)
      throw new Error("Incomplete Re-tag");
    const review = await core.getOrganizeReview();
    return docs.map((doc) => {
      const tags = review.items.find((item) => item.documentId === doc.id)?.tags ?? [];
      const ids = tags.map((tag) => tag.tagId);
      const wanted = expected.get(basename(doc.path).normalize());
      if (wanted === undefined) throw new Error("Missing hard-case label");
      return {
        name: doc.name,
        tags: tags.map((tag) => tag.name),
        business: ids.includes(business.id),
        pass: accepts(tags, wanted),
      };
    });
  } finally {
    await core.close();
  }
}
