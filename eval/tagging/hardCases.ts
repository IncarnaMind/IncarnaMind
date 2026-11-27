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
  extended: { en: "Dental clinic", "zh-CN": "牙科诊所" },
} as const;

const extendedDocuments = {
  en: [
    [
      "Series A pitch",
      "Our dental clinic serves 1,900 active patients across two suburbs. We are raising a $1.4M seed-plus round to open a third location. These slides outline our fundraising target, equity terms, and 24-month runway.",
    ],
    [
      "Patient data notice",
      "This privacy notice from our dental clinic explains which patient contact records we store, how long we retain email addresses, and how to withdraw consent or request deletion.",
    ],
    [
      "Community room note",
      "The neighborhood book club meets Thursday evening at seven. Our dental clinic lent us its upstairs waiting room for the discussion. Please finish chapters six through nine beforehand.",
    ],
    [
      "Chair roster",
      "Next week's dental clinic operations: assign Dr. Park to Hygiene Bay 2, order composite resin cartridges, and sterilize the handpiece trays before the Tuesday crown bookings.",
    ],
    [
      "Monthly clinic review",
      "Our dental clinic completed 214 routine cleanings and 38 root-canal procedures in April. Chair 3 lost half a day waiting for a suction valve replacement. We are revising appointment blocks to cut wait times.",
    ],
    [
      "Roof array quote",
      "The rooftop solar installation needs fourteen 440W monocrystalline panels, aluminum rail mounts, and a hybrid inverter. The installer budgeted two days to wire the combiner box into the main breaker.",
    ],
    [
      "Inverter sign-off",
      "For our home solar installation we approved the south-slope array layout and battery wall placement. Next Friday the electrician inspects the conduit run and registers grid export.",
    ],
    [
      "Trail club bulletin",
      "Saturday hikers leave the trailhead at eight sharp. On the drive up, Elena joked about her neighbor's rooftop solar installation. Pack two litres of water and rain shells for the ridge.",
    ],
  ],
  "zh-CN": [
    [
      "投资人路演稿",
      "本牙科诊所已在两个城区服务一千九百余名复诊患者。本轮计划融资八百万元用于拓展第三家门诊，演示稿详述拟出让股权比例、资金用途及未来两年现金流安排。",
    ],
    [
      "个人信息保护声明",
      "本牙科诊所的隐私声明告知就诊人：我们收集哪些姓名与联系方式、电子档案保存多久，以及如何撤回授权或申请删除个人资料。",
    ],
    [
      "读书会场地通知",
      "社区读书会周四晚七点讨论第六至第九章。牙科诊所借给我们二楼候诊间作为聚会场地。请大家自带水杯准时到场。",
    ],
    [
      "下周诊室排班",
      "牙科诊所下周运营安排：林医生值守二号牙椅，补充光固化树脂耗材，周二上午烤瓷冠预约前完成全部手机头高温灭菌。",
    ],
    [
      "四月门诊运营小结",
      "本牙科诊所四月共完成二百一十四例洁牙和三十八例根管治疗。三号椅位因负压阀配件缺货停用半天，下月起调整复诊时段以缩短候诊时间。",
    ],
    [
      "屋顶并网报价",
      "家庭屋顶光伏安装方案包含十四块四百四十瓦单晶组件、铝合金导轨与一台混合逆变器。施工队预计两天完成汇流箱接线并接入配电箱。",
    ],
    [
      "逆变器验收单",
      "屋顶太阳能光伏安装今天敲定了南坡组件排布与储能电池挂墙位置，下周五电工验收穿线管路并提交并网发电申请。",
    ],
    [
      "徒步队周末通知",
      "周六早八点在山口准时集合。路上陈队随口聊起隔壁村屋顶装光伏的事。山脊风大，请各位带足两升饮用水与防风外套。",
    ],
  ],
} as const;

export const singletonDocuments = {
  en: [
    {
      name: "Seed_Round_Overview",
      kind: "pptx" as const,
      role: "pitch" as const,
      text: "Slide 1: Clearloom Robotics — Seed Fundraising Presentation. Slide 2: Warehouse sorting bottlenecks. Slide 3: Raising $2.5M at $12M cap; 18-month runway to commercial deployment.",
    },
    {
      name: "Investor_Memo_SeriesA",
      kind: "pdf" as const,
      role: "pitch" as const,
      text: "HARBORFLOW ENERGY — SERIES A INVESTOR BUSINESS PLAN. Seeking $9M Series A equity financing to expand grid-scale thermal storage deployments. Includes valuation summary, use of proceeds, and 3-year projections.",
    },
    {
      name: "Product_Sales_Deck",
      kind: "pptx" as const,
      role: "sales" as const,
      text: "Slide 1: Clearloom Enterprise Overview for Logistics Buyers. Slide 2: Cut pick-and-pack labor by 35%. Slide 3: Pricing tiers and 60-day pilot rollout. Slide 4: Customer testimonials.",
    },
    {
      name: "Q4_Marketing_Deck",
      kind: "pptx" as const,
      role: "sales" as const,
      text: "Slide 1: Q4 Demand Generation Review. Slide 2: Paid search and webinar conversion rates. Slide 3: Partner co-marketing calendar for winter campaigns. Slide 4: Next quarter lead goals.",
    },
    {
      name: "Lemon_Tart_Recipe",
      kind: "text" as const,
      role: "none" as const,
      text: "Meyer lemon tart recipe. Pastry: 200 g plain flour, 100 g cold butter, 60 g icing sugar, one egg yolk. Blind bake 15 minutes at 180 °C, fill with lemon curd, bake 20 minutes until just set.",
    },
    {
      name: "Parcel_Packing_Slip",
      kind: "text" as const,
      role: "none" as const,
      text: "Packing slip — Shipment #PK-9041. Carton 1 of 1. Contents: 6 × ceramic mugs (blue), 2 × linen tea towels. Checked by warehouse clerk J. Morales. No prices shown.",
    },
  ],
  "zh-CN": [
    {
      name: "天使轮融资介绍",
      kind: "pptx" as const,
      role: "pitch" as const,
      text: "第 1 页：清织机器人——天使轮融资路演稿。第 2 页：仓储分拣人力瓶颈。第 3 页：本轮拟融资 1,500 万元，投前估值 8,000 万元，资金用于量产样机与华东客户试点，支持 18 个月现金流。",
    },
    {
      name: "A轮融资计划书",
      kind: "pdf" as const,
      role: "pitch" as const,
      text: "海流储能——A 轮投资人商业计划书。计划募集人民币 4,000 万元股权融资用于扩大工业储热设备产能。附市场规模测算、股权结构、募资用途与三年财务预测。",
    },
    {
      name: "企业客户产品宣讲",
      kind: "pptx" as const,
      role: "sales" as const,
      text: "第 1 页：清织分拣方案客户推介。第 2 页：帮助物流仓降低 35% 拣货工时。第 3 页：标准版与旗舰版采购方案及 60 天试用流程。第 4 页：已上线客户案例。",
    },
    {
      name: "四季度市场活动回顾",
      kind: "pptx" as const,
      role: "sales" as const,
      text: "第 1 页：四季度市场获客工作复盘。第 2 页：信息流投放与线上研讨会线索转化率。第 3 页：冬季渠道联合推广排期。第 4 页：下季度线索目标。",
    },
    {
      name: "糖醋排骨做法",
      kind: "text" as const,
      role: "none" as const,
      text: "家常糖醋排骨菜谱：猪肋排 500 克冷水焯水去沫，冰糖炒出枣红色糖色后下排骨翻炒，加生抽两勺、陈醋三勺、料酒一勺和热水没过排骨，小火焖四十分钟大火收汁撒白芝麻。",
    },
    {
      name: "包裹装箱明细",
      kind: "text" as const,
      role: "none" as const,
      text: "发货装箱单（件号 PK-9041，共 1 箱）。箱内物品：蓝色陶瓷杯 6 只、亚麻茶巾 2 条。复核员：周敏。本单仅作收货清点，不含价格。",
    },
  ],
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
  panel: "hard" | "publisher" | "extended" = "hard",
  options: { dropPitchDeckKind?: boolean } = {},
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
    if (options.dropPitchDeckKind) {
      const pitch = (await core.listTags()).find((tag) => tag.kind === "pitch-deck");
      if (pitch) await core.deleteTag(pitch.id);
    }
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "eval" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "eval" } },
      automatic: false,
    });
    const en = language === "en";
    const subjectName =
      panel === "extended"
        ? en
          ? "光伏安装"
          : "Solar installation"
        : en
          ? "厨房装修"
          : "Kitchen renovation";
    const subjectAnchor =
      panel === "extended"
        ? en
          ? "屋顶光伏安装，确定组件排布与逆变器接线方案。"
          : "Rooftop solar installation. Mount panels and wire the hybrid inverter."
        : en
          ? "厨房装修，更新橱柜与水槽，确定台面材料。"
          : "Kitchen renovation. Replace the cabinets, counters and sink.";
    const subject = await core.createTag({ name: subjectName });
    const fundraising = await core.createTag({ name: en ? "Fundraising" : "融资" });
    const business = await core.createTag({ name: businessNames[panel][language] });
    const source = await createSourceFolder();
    const write = (name: string, body: string) => writeSourceFile(source, `${name}.txt`, body);
    const [member] = await addAndProcess(core, [await write("A0", subjectAnchor)]);
    if (!member) throw new Error("Missing anchor Document");
    await core.addDocumentTag(member.id, subject.id);
    const cases =
      panel === "hard"
        ? documents[language]
        : panel === "publisher"
          ? publisherDocuments[language]
          : extendedDocuments[language];
    const paths = await Promise.all(cases.map(([name, body]) => write(name, body)));
    const wants =
      panel === "hard"
        ? [fundraising.id, null, subject.id, subject.id, null, null]
        : panel === "publisher"
          ? [null, null, business.id, business.id]
          : [fundraising.id, null, null, business.id, business.id, subject.id, subject.id, null];
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
        expectedFundraising: wanted === fundraising.id,
        expectedSubject: wanted === subject.id,
        business: ids.includes(business.id),
        fundraising: ids.includes(fundraising.id),
        renovation: ids.includes(subject.id),
        pass: accepts(tags, wanted),
      };
    });
  } finally {
    await core.close();
  }
}
