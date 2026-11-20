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

const businessNames = {
  hard: { en: "Repair shop", "zh-CN": "修理铺" },
  publisher: { en: "Print studio", "zh-CN": "印刷工坊" },
} as const;

const publisherDocuments = {
  en: [
    [
      "Contact records",
      "This privacy notice from our print studio tells subscribers how long we retain their email addresses, how to withdraw permission and how to request deletion.",
    ],
    [
      "Music evening",
      "The chamber choir will rehearse its spring programme on Friday at six. The print studio has lent us the room. Bring scores for the two new songs.",
    ],
    [
      "Monday allocation",
      "Next week's print studio operations: assign two operators to the large press, buy cyan ink and set the binding line to meet the outstanding booklet orders.",
    ],
    [
      "Throughput review",
      "Our print studio completed 82 customer orders this month. The main press lost a shift waiting for rollers. We are changing how we schedule jobs to reduce turnaround.",
    ],
  ],
  "zh-CN": [
    [
      "联系方式的处理",
      "本印刷工坊的隐私声明告知订阅者，我们保留电子邮箱多久、怎样撤回授权，以及如何申请删除个人资料。",
    ],
    [
      "周五排练",
      "室内合唱团周五六点排练春季曲目。印刷工坊借给我们一间屋子。请团员带上两首新歌的乐谱。",
    ],
    [
      "周一排班",
      "印刷工坊下周的生产安排：两位师傅轮值大印机，补充青色油墨，装订线优先完成已经接下的手册订单。",
    ],
    [
      "本月生产小结",
      "印刷工坊本月交付八十二笔客户订单，主机等待滚筒配件停了一个班次。下月调整工单排序，缩短交货时间。",
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

export async function hardCases(
  model: ChatLanguageModel,
  language: Language,
  panel: "hard" | "publisher" = "hard",
) {
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
    const business = await core.createTag({ name: businessNames[panel][language] });
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
    const cases = panel === "hard" ? documents[language] : publisherDocuments[language];
    const paths = await Promise.all(cases.map(([name, body]) => write(name, body)));
    const wants =
      panel === "hard"
        ? [fundraising.id, null, kitchen.id, kitchen.id, null, null]
        : [null, null, business.id, business.id];
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
        expectedBusiness: wanted === business.id,
        business: ids.includes(business.id),
        fundraising: ids.includes(fundraising.id),
        renovation: ids.includes(kitchen.id),
        pass: accepts(tags, wanted),
      };
    });
  } finally {
    await core.close();
  }
}
