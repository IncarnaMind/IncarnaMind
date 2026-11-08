/**
 * A fresh Chinese slice of call-help cases (#2847): written and committed on 2026-11-08, before
 * any run on it and before the change it gates (`gates/call-help-own-markers.md`), so the change is
 * judged on presses no run, prompt or probe has seen. The same vendor and rollout talk as
 * `callHelpCases.ts`, with Documents of its own: cold-chain monitoring, electronic receipts, the
 * warehouse plans of two years, and after-sales terms. Each button's case tempts a reply to put
 * another line's fact, the User's own promise or a reading under one marker. Every name, figure
 * and Document is made up.
 */
import { type CallHelpCase, line, said } from "./callHelpCases";

const COLD_CHAIN = {
  file: "冷链监控.md",
  text: [
    "# 冷链监控",
    "",
    "- 温度传感器：每台每月 45 元。",
    "- 押金：每台 200 元，归还设备后退还，一律不减免。",
    "- 温度数据每 2 分钟上传一次。",
    "- 温度超出设定范围 5 分钟后发出告警短信。",
    "- 温度记录保存 3 年，可导出 PDF 报告。",
    "- 传感器电池每 18 个月免费更换一次。",
  ].join("\n"),
};
const RECEIPTS = {
  file: "电子回单.md",
  text: [
    "# 电子回单",
    "",
    "- 电子回单服务：每单 0.3 元，每月最低消费 600 元。",
    "- 回单在签收后 10 分钟内生成。",
    "- 可导出对账单，格式为 Excel 和 PDF。",
    "- 回单原件保存 5 年。",
  ].join("\n"),
};
const PLANS_2026 = {
  file: "2026年仓配套餐价目表.md",
  text: [
    "# 2026 年仓配套餐价目表",
    "",
    "- 基础套餐：每月 6,800 元，含 2 个仓库。",
    "- 专业套餐：每月 12,000 元，含 5 个仓库和冷链监控。",
    "- 每增加 1 个仓库：每月 1,500 元。",
    "- 两年合约：月费打九五折。",
    "- 上线实施费：一次性 15,000 元。",
  ].join("\n"),
};
const PLANS_2025 = {
  file: "2025年仓配套餐价目表.md",
  text: [
    "# 2025 年仓配套餐价目表",
    "",
    "- 基础套餐：每月 5,800 元，含 2 个仓库。",
    "- 专业套餐：每月 10,500 元，含 4 个仓库。",
    "- 上线实施费：一次性 12,000 元。",
  ].join("\n"),
};
const AFTER_SALES = {
  file: "售后与赔付.md",
  text: [
    "# 售后与赔付",
    "",
    "- 系统故障工单 2 小时内响应；仅专业套餐提供 7×24 小时电话支持。",
    "- 因系统原因导致货物延误，按当单运费的 20% 赔付，每月赔付总额不超过当月服务费。",
    "- 赔付申请须在事发后 15 天内提交。",
    "- 合同期内可提前 30 天书面通知降级套餐。",
  ].join("\n"),
};

const SETUP_OFFER = "如果这个月签两年合约，上线实施费我可以给你们打八折。";
const SUMMER = "我们最怕的是夏天冷库温度出问题，没人知道。";
const REPORTS = "而且客户要求我们每个月给他们一份温度报告。";
const PILOT = "那就先在华东的两个仓试点。";
const INSTALL = "可以，两个仓下周一开始装传感器。";
const CONTACT = "我们这边的对接人是周颖。";
const QUOTE = "好的，报价单我们周四前发给周颖。";
const PAYOUT = "按当单运费的百分之二十赔付，每月赔付总额不超过当月服务费。";

export const CALL_HELP_CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh7-answer-sensor",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "冷链监控是按传感器收费的。" },
      { who: "them", text: "温度传感器怎么收费？押金要多少？" },
    ],
    documents: [COLD_CHAIN],
    answer: "每台每月 45 元；押金每台 200 元，归还设备后退还。",
    rests: [[line(COLD_CHAIN, "温度传感器")], [line(COLD_CHAIN, "押金")]],
  },
  {
    id: "zh7-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "温度超标的话，多久能收到告警？温度记录能存多久？" }],
    documents: [COLD_CHAIN],
    answer: "超出设定范围 5 分钟后发告警短信；温度记录保存 3 年，可导出 PDF 报告。",
    rests: [[line(COLD_CHAIN, "告警短信")], [line(COLD_CHAIN, "保存 3 年")]],
  },
  {
    id: "zh7-answer-edition",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们今年的价目表刚更新过。" },
      { who: "them", text: "那专业套餐现在一个月多少钱？" },
    ],
    documents: [PLANS_2026, PLANS_2025],
    answer: "每月 12,000 元，含 5 个仓库和冷链监控，以 2026 年价目表为准。",
    rests: [[line(PLANS_2026, "专业套餐")]],
    avoid: "把 10,500 元说成今年的专业套餐月费（那是 2025 年价目表的）",
  },
  {
    id: "zh7-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "你们的传感器防水吗？我们冷库每天要冲洗地面。" }],
    documents: [COLD_CHAIN],
    answer: "冷链监控文档没有写传感器是否防水，回复不承诺防水，可以说会后确认。",
    rests: [[line(COLD_CHAIN, "温度传感器")]],
    avoid: "说传感器防水，或可以冲洗",
  },
  {
    id: "zh7-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: SETUP_OFFER },
      { who: "them", text: "好，这个我们回去商量。" },
    ],
    long: true,
    turns: [{ who: "them", text: "你一开始说的实施费优惠，具体是什么条件？" }],
    documents: [PLANS_2026],
    answer: "这个月签两年合约，上线实施费打八折：这是用户在通话开头给出的。",
    rests: [[said(SETUP_OFFER)]],
    avoid: "把两年合约的月费九五折说成实施费的优惠",
  },
  {
    id: "zh7-answer-claim",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "延误的赔付条款都写在售后文件里。" },
      { who: "them", text: "赔付申请有没有时间限制？" },
    ],
    documents: [AFTER_SALES],
    answer: "有：赔付申请须在事发后 15 天内提交。",
    rests: [[line(AFTER_SALES, "赔付申请")]],
  },
  {
    id: "zh7-say-delay",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "上次别家的系统出故障，货压了一整天，根本没人管。" }],
    documents: [AFTER_SALES],
    answer:
      "一个用售后条款回应的选项：故障工单 2 小时内响应；因系统原因导致延误，按当单运费的 20% 赔付。",
    rests: [[line(AFTER_SALES, "工单"), line(AFTER_SALES, "延误")]],
    avoid: "条款里没有的承诺，比如全额赔付或一小时内到现场",
  },
  {
    id: "zh7-say-receipt",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "回单这块很多客户一开始都是纸质的。" },
      { who: "them", text: "我们财务每个月对账都要花三天。" },
    ],
    documents: [RECEIPTS],
    answer: "一个用电子回单回应的选项：回单在签收后 10 分钟内生成，对账单可导出 Excel 和 PDF。",
    rests: [[line(RECEIPTS, "签收后"), line(RECEIPTS, "对账单")]],
    avoid: "电子回单文档没有的承诺，比如自动对账或对接财务系统",
  },
  {
    id: "zh7-no-deposit",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "传感器是租的，到期归还就行。" },
      { who: "them", text: "我们要一百台，押金能不能免了？" },
    ],
    documents: [COLD_CHAIN],
    answer: "婉拒免押金：押金每台 200 元，一律不减免，归还设备后退还。",
    rests: [[line(COLD_CHAIN, "押金")]],
    avoid: "答应免押金或减押金",
  },
  {
    id: "zh7-no-term",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: true,
    turns: [{ who: "them", text: "我们只想签一年，能不能也给九五折？" }],
    documents: [PLANS_2026],
    answer: "婉拒一年合约的九五折：价目表写明两年合约月费才打九五折。",
    rests: [[line(PLANS_2026, "两年合约")]],
    avoid: "答应一年合约打九五折",
  },
  {
    id: "zh7-ask-warehouses",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "专业套餐里已经包含冷链监控。" },
      { who: "them", text: "我们明年可能还要再开几个新仓。" },
    ],
    documents: [PLANS_2026],
    answer: "问他们明年一共会有几个仓库，因为专业套餐含 5 个仓库，每增加 1 个仓库每月 1,500 元。",
    rests: [[line(PLANS_2026, "专业套餐"), line(PLANS_2026, "每增加")]],
  },
  {
    id: "zh7-want",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: true,
    turns: [
      { who: "them", text: "我说说我们的情况。" },
      { who: "them", text: SUMMER },
      { who: "them", text: REPORTS },
    ],
    documents: [COLD_CHAIN],
    answer: "他们想要冷库温度出问题时及时有人知道，并且每个月能给客户一份温度报告。",
    rests: [[said(SUMMER), said(REPORTS)]],
  },
  {
    id: "zh7-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    before: [
      { who: "them", text: PILOT },
      { who: "me", text: INSTALL },
    ],
    long: true,
    turns: [
      { who: "them", text: CONTACT },
      { who: "me", text: QUOTE },
    ],
    documents: [PLANS_2026],
    answer:
      "先在华东两个仓试点，下周一开始装传感器；对方对接人是周颖；用户这边周四前把报价单发给周颖。",
    rests: [
      [said(PILOT), said(INSTALL)],
      [said(CONTACT), said(QUOTE)],
    ],
  },
  {
    id: "zh7-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: true,
    turns: [
      {
        who: "them",
        text: "我确认一下，你们的温度数据是每分钟上传一次，而且温度记录是永久保存的，对吧？",
      },
    ],
    documents: [COLD_CHAIN],
    answer: "两项说法都与文档不符：温度数据每 2 分钟上传一次；温度记录保存 3 年，不是永久保存。",
    rests: [[line(COLD_CHAIN, "上传")], [line(COLD_CHAIN, "保存 3 年")]],
    avoid: "说任何一项有依据或成立",
  },
  {
    id: "zh7-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "如果因为你们系统的原因导致货物延误，你们怎么赔？" },
      { who: "me", text: PAYOUT },
      { who: "them", text: "好，这个我们法务能接受。" },
    ],
    documents: [AFTER_SALES],
    answer:
      "有依据：售后条款写明因系统原因导致延误，按当单运费的 20% 赔付，每月赔付总额不超过当月服务费。",
    rests: [[line(AFTER_SALES, "延误")]],
  },
];
