/**
 * A fresh slice of call-help cases for the ✓ that only the sentence check gives (#2847): written
 * and committed on 2026-11-09, before any run on it and before the gate's first run
 * (`gates/call-help-checked-marks.md`). Fifteen English presses, each with a Chinese twin of the
 * same call, Documents and answer, about an office-cleaning contract. Every case has Documents of
 * its own, which no other case reads, and its own Meeting and Note. Short calls only: the replies
 * are what is measured, not how much of the call a path reads. Every name, figure and Document is
 * made up.
 */
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const PRICES_EN = doc("Deep clean prices.md", "Deep clean prices", [
  "Weekly deep clean: £180 per floor.",
  "A contract of 12 months or more gets 8% off the weekly price.",
  "Carpet shampoo is £2 per square metre, booked separately.",
]);
const TERMS_EN = doc("Contract terms.md", "Contract terms", [
  "Either side can end the contract with 30 days' written notice.",
  "The minimum term is 6 months from the start date.",
  "Prices are reviewed once a year, in April.",
]);
const HOURS_EN = doc("Cleaning hours.md", "Cleaning hours", [
  "Cleaning runs Monday to Friday, 6 pm to 10 pm.",
  "Extra visits can be booked with 48 hours' notice.",
  "Holidays follow the client's own calendar.",
]);
const WASHROOMS_EN = doc("Washroom service.md", "Washroom service", [
  "Sanitary bins are emptied weekly.",
  "Air fresheners are refilled every month.",
]);
const PRODUCTS_EN = doc("Products.md", "Products", [
  "All our products are fragrance-free and carry the EU Ecolabel.",
  "Food preparation surfaces are cleaned with food-safe products only.",
  "Safety data sheets are sent on request.",
]);
const SECURITY_EN = doc("Security.md", "Security", [
  "Client keys are kept in a locked safe at our depot.",
  "Every cleaner is background-checked before their first shift.",
  "A lost key is replaced and the lock changed at our cost.",
]);
const DISCOUNTS_EN = doc("Discount policy.md", "Discount policy", [
  "The largest discount is 10%, and only on contracts of 24 months.",
  "Discounts never apply to extra visits.",
]);
const EXTRA_EN = doc("Extra visits.md", "Extra visits", [
  "Extra visits need 48 hours' notice.",
  "An extra visit costs £95 for up to three hours.",
]);
const QUOTES_EN = doc("Quotes.md", "Quotes", [
  "Each site is quoted separately after a walk-through.",
  "A walk-through takes about an hour and is free.",
]);
const SUPPLIES_EN = doc("Washroom supplies.md", "Washroom supplies", [
  "Washroom supplies are restocked on every visit.",
  "Hand towels and soap are included in the monthly fee.",
]);
const WINDOWS_EN = doc("Windows.md", "Windows", [
  "Interior windows are cleaned once a month, included in the fee.",
  "Exterior windows are quoted separately.",
]);
const WASTE_EN = doc("Waste collection.md", "Waste collection", [
  "General waste is collected daily.",
  "Recycling is collected on Tuesdays and Fridays.",
]);
const ONBOARDING_EN = doc("Onboarding.md", "Onboarding", [
  "A welcome pack is sent before the first visit.",
]);
const INSURANCE_EN = doc("Insurance.md", "Insurance", [
  "We carry public liability cover of £5 million.",
  "Damage must be reported to us within 7 days.",
  "Cover excludes items left on the floor overnight.",
]);
const STARTING_EN = doc("Starting.md", "Starting", [
  "A new contract starts within 10 working days of signing.",
  "A site manager visits in the first week to agree the checklist.",
]);

const OFFER_EN = "If you sign before the end of the month, the first deep clean is on us.";
const BINS_EN = "Honestly, the main thing is the staff complaints about overflowing bins.";
const MONDAYS_EN = "Every Monday morning, after the weekend.";
const START_EN = "So we start with the ground floor on the first of June.";
const QUOTE_EN = "And I'll send the revised quote by Thursday.";

const ENGLISH: readonly CallHelpCase[] = [
  {
    id: "en10-answer-price",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We price per floor, so it scales with the building." },
      { who: "them", text: "So what does the weekly deep clean cost for us?" },
    ],
    documents: [PRICES_EN],
    answer: "£180 per floor for the weekly deep clean.",
    rests: [[line(PRICES_EN, "Weekly deep clean")]],
    avoid:
      "giving the 8% discount or the carpet price as part of the weekly price, or a total the sheet doesn't give",
  },
  {
    id: "en10-answer-two",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Two things before we sign: how much notice do we have to give, and is there a minimum term?",
      },
    ],
    documents: [TERMS_EN],
    answer: "30 days' written notice, and a minimum term of 6 months.",
    rests: [[line(TERMS_EN, "30 days")], [line(TERMS_EN, "minimum term")]],
  },
  {
    id: "en10-answer-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Our teams work evenings, after your staff leave." },
      { who: "them", text: "Do you also clean at weekends?" },
    ],
    documents: [HOURS_EN],
    answer:
      "Regular cleaning runs Monday to Friday, 6 pm to 10 pm, and extra visits can be booked with 48 hours' notice; the sheet doesn't say whether those can be at weekends.",
    rests: [[line(HOURS_EN, "Monday to Friday"), line(HOURS_EN, "Extra visits")]],
    avoid: "stating as a fact that weekend visits are, or aren't, possible",
  },
  {
    id: "en10-answer-earlier",
    language: "en",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_EN },
      { who: "them", text: "That's generous, we'll keep it in mind." },
    ],
    long: false,
    turns: [
      { who: "me", text: "Shall I go through the washroom service?" },
      { who: "them", text: "Before that, what was the offer you mentioned at the start?" },
    ],
    documents: [WASHROOMS_EN],
    answer:
      "The first deep clean is free if they sign before the end of the month, as the User said earlier in the call.",
    rests: [[said(OFFER_EN)]],
    avoid: "any other discount as the User's offer",
  },
  {
    id: "en10-say-chemicals",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Our kitchen staff are worried about harsh chemicals near the food prep area.",
      },
    ],
    documents: [PRODUCTS_EN],
    answer:
      "An option that answers with the products sheet: food preparation surfaces are cleaned with food-safe products only, or the products are fragrance-free and carry the EU Ecolabel.",
    rests: [[line(PRODUCTS_EN, "Food preparation"), line(PRODUCTS_EN, "fragrance-free")]],
    avoid: "a promise the sheet doesn't make, such as using no chemicals at all",
  },
  {
    id: "en10-say-keys",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We take security seriously." },
      {
        who: "them",
        text: "Our last cleaners lost a set of keys, and it cost us a lock change.",
      },
    ],
    documents: [SECURITY_EN],
    answer:
      "An option that answers with the security sheet: a lost key is replaced and the lock changed at the cleaning company's cost, or keys are kept in a locked safe.",
    rests: [[line(SECURITY_EN, "lost key"), line(SECURITY_EN, "locked safe")]],
  },
  {
    id: "en10-no-discount",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "Can you knock twenty percent off the monthly fee?" }],
    documents: [DISCOUNTS_EN],
    answer:
      "A polite no to 20% off that keeps things moving: the largest discount is 10%, and only on a 24-month contract.",
    rests: [[line(DISCOUNTS_EN, "largest discount")]],
    avoid: "agreeing to 20%, or offering a discount the policy doesn't allow",
  },
  {
    id: "en10-no-today",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We can add visits whenever you need them." },
      {
        who: "them",
        text: "Great, can you send someone this afternoon? We have visitors tomorrow.",
      },
    ],
    documents: [EXTRA_EN],
    answer:
      "A polite no to this afternoon: extra visits need 48 hours' notice; it may offer to book the next one possible.",
    rests: [[line(EXTRA_EN, "48 hours")]],
    avoid: "promising someone this afternoon",
  },
  {
    id: "en10-ask-sites",
    language: "en",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We have three offices across town, all different sizes." },
      { who: "me", text: "Understood." },
    ],
    documents: [QUOTES_EN],
    answer:
      "A question that moves towards a walk-through of each office, since each site is quoted separately after one, and a walk-through is free.",
    rests: [[line(QUOTES_EN, "quoted separately"), line(QUOTES_EN, "about an hour")]],
  },
  {
    id: "en10-check-right",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Your sheet says you restock the washroom supplies on every visit, right?",
      },
      { who: "me", text: "Let me check." },
    ],
    documents: [SUPPLIES_EN],
    answer:
      "Their claim is supported: the sheet says washroom supplies are restocked on every visit.",
    rests: [[line(SUPPLIES_EN, "restocked")]],
  },
  {
    id: "en10-check-wrong",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "And the windows are included in the monthly fee, inside and out." },
    ],
    documents: [WINDOWS_EN],
    answer:
      "Partly wrong: interior windows are cleaned once a month and included in the fee, but exterior windows are quoted separately.",
    rests: [[line(WINDOWS_EN, "Exterior")]],
    avoid: "saying exterior windows are included in the fee",
  },
  {
    id: "en10-want-bins",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: BINS_EN },
      { who: "me", text: "How often does that happen?" },
      { who: "them", text: MONDAYS_EN },
    ],
    documents: [WASTE_EN],
    answer:
      "They want the bins dealt with: overflowing bins on Monday mornings, after the weekend, are what the staff complain about most.",
    rests: [[said(BINS_EN), said(MONDAYS_EN)]],
  },
  {
    id: "en10-sum",
    language: "en",
    kind: "sum",
    needs: "whole",
    long: false,
    turns: [
      { who: "me", text: START_EN },
      { who: "them", text: "Yes, and Ines Arlow will be our contact for access." },
      { who: "me", text: QUOTE_EN },
      { who: "them", text: "Good." },
    ],
    documents: [ONBOARDING_EN],
    answer:
      "Lines that sum up: the ground floor starts on 1 June; Ines Arlow is their contact for access; the User sends the revised quote by Thursday.",
    rests: [[said(START_EN)], [said(QUOTE_EN)]],
  },
  {
    id: "en10-answer-insurance",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "If one of your team breaks something in our office, are you covered?",
      },
    ],
    documents: [INSURANCE_EN],
    answer: "Yes: public liability cover of £5 million; damage must be reported within 7 days.",
    rests: [[line(INSURANCE_EN, "public liability")]],
  },
  {
    id: "en10-say-start",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "We need someone in place before our new office opens." }],
    documents: [STARTING_EN],
    answer:
      "An option saying a new contract starts within 10 working days of signing, or that a site manager visits in the first week.",
    rests: [[line(STARTING_EN, "10 working days"), line(STARTING_EN, "site manager")]],
    avoid: "a start date the sheet doesn't give",
  },
];

const PRICES_ZH = doc("深度保洁价格.md", "深度保洁价格", [
  "每周深度保洁：每层 1,600 元。",
  "签约 12 个月及以上，每周价格优惠 8%。",
  "地毯清洗每平方米 18 元，需另行预约。",
]);
const TERMS_ZH = doc("合同条款.md", "合同条款", [
  "任何一方提前 30 天书面通知即可终止合同。",
  "最短合同期为自起始日起 6 个月。",
  "价格每年 4 月调整一次。",
]);
const HOURS_ZH = doc("保洁时间.md", "保洁时间", [
  "保洁时间为周一至周五晚上 6 点到 10 点。",
  "加派保洁需提前 48 小时预约。",
  "节假日按客户自己的日历安排。",
]);
const WASHROOMS_ZH = doc("洗手间服务.md", "洗手间服务", [
  "卫生桶每周清空一次。",
  "空气清新剂每月补充一次。",
]);
const PRODUCTS_ZH = doc("清洁用品.md", "清洁用品", [
  "我们所有用品均为无香型，并获得欧盟生态标签。",
  "食品加工台面只使用食品级清洁用品。",
  "可应要求提供安全数据表。",
]);
const SECURITY_ZH = doc("安全管理.md", "安全管理", [
  "客户钥匙存放在我们仓库的上锁保险柜中。",
  "每位保洁员上岗前都经过背景审查。",
  "钥匙丢失由我们负责补配并更换门锁。",
]);
const DISCOUNTS_ZH = doc("折扣政策.md", "折扣政策", [
  "最高折扣为 10%，仅限 24 个月的合同。",
  "加派保洁不享受任何折扣。",
]);
const EXTRA_ZH = doc("加派保洁.md", "加派保洁", [
  "加派保洁需提前 48 小时预约。",
  "每次加派 850 元，最长三小时。",
]);
const QUOTES_ZH = doc("报价.md", "报价", [
  "每个办公点在实地查看后单独报价。",
  "实地查看约一小时，不收费。",
]);
const SUPPLIES_ZH = doc("洗手间用品.md", "洗手间用品", [
  "每次上门都会补充洗手间用品。",
  "擦手纸和洗手液包含在月费中。",
]);
const WINDOWS_ZH = doc("窗户清洁.md", "窗户清洁", [
  "室内窗户每月清洁一次，包含在月费中。",
  "室外窗户另行报价。",
]);
const WASTE_ZH = doc("垃圾清运.md", "垃圾清运", [
  "生活垃圾每天清运。",
  "可回收物每周二和周五清运。",
]);
const ONBOARDING_ZH = doc("入场安排.md", "入场安排", ["首次上门前会寄送一份欢迎资料。"]);
const INSURANCE_ZH = doc("保险.md", "保险", [
  "我们投保了 500 万元的公众责任险。",
  "损坏须在 7 天内告知我们。",
  "过夜放在地上的物品不在保障范围内。",
]);
const STARTING_ZH = doc("开始服务.md", "开始服务", [
  "新合同在签约后 10 个工作日内开始服务。",
  "现场经理在第一周上门确认清单。",
]);

const OFFER_ZH = "如果你们这个月底前签约，第一次深度保洁免费。";
const BINS_ZH = "说实话，最主要的是员工投诉垃圾桶满出来。";
const MONDAYS_ZH = "每周一早上，过完周末就这样。";
const START_ZH = "那我们 6 月 1 日先从一楼开始。";
const QUOTE_ZH = "我周四前把修改后的报价发给你们。";

const CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh10-answer-price",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们按楼层计价，所以和楼的大小挂钩。" },
      { who: "them", text: "那我们每周深度保洁要多少钱？" },
    ],
    documents: [PRICES_ZH],
    answer: "每周深度保洁每层 1,600 元。",
    rests: [[line(PRICES_ZH, "每周深度保洁")]],
    avoid: "把 8% 优惠或地毯清洗价格算进每周价格，或给出价目表没有的总价",
  },
  {
    id: "zh10-answer-two",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "签约前问两件事：我们要提前多久通知？有没有最短合同期？" }],
    documents: [TERMS_ZH],
    answer: "提前 30 天书面通知；最短合同期 6 个月。",
    rests: [[line(TERMS_ZH, "30 天")], [line(TERMS_ZH, "最短合同期")]],
  },
  {
    id: "zh10-answer-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们的团队在你们员工下班后的晚上上门。" },
      { who: "them", text: "周末也能打扫吗？" },
    ],
    documents: [HOURS_ZH],
    answer:
      "常规保洁为周一至周五晚上 6 点到 10 点，加派保洁需提前 48 小时预约；文档没有说加派能否安排在周末。",
    rests: [[line(HOURS_ZH, "周一至周五"), line(HOURS_ZH, "加派保洁")]],
    avoid: "把周末能或不能上门当作事实来说",
  },
  {
    id: "zh10-answer-earlier",
    language: "zh-CN",
    kind: "answer",
    needs: "earlier",
    before: [
      { who: "me", text: OFFER_ZH },
      { who: "them", text: "挺划算的，我们考虑一下。" },
    ],
    long: false,
    turns: [
      { who: "me", text: "要不要我介绍一下洗手间服务？" },
      { who: "them", text: "先等一下，你开头说的那个优惠是什么来着？" },
    ],
    documents: [WASHROOMS_ZH],
    answer: "如果月底前签约，第一次深度保洁免费：这是用户在通话开头说的。",
    rests: [[said(OFFER_ZH)]],
    avoid: "把其他优惠当作用户的报价",
  },
  {
    id: "zh10-say-chemicals",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "我们后厨的员工担心备餐区附近用刺激性的化学品。" }],
    documents: [PRODUCTS_ZH],
    answer:
      "一个用清洁用品文档回应的选项：食品加工台面只使用食品级清洁用品，或所有用品均为无香型并获得欧盟生态标签。",
    rests: [[line(PRODUCTS_ZH, "食品加工台面"), line(PRODUCTS_ZH, "无香型")]],
    avoid: "文档没有给出的承诺，比如完全不用化学品",
  },
  {
    id: "zh10-say-keys",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们很重视安全。" },
      { who: "them", text: "上一家保洁公司弄丢过一串钥匙，害我们换了锁。" },
    ],
    documents: [SECURITY_ZH],
    answer:
      "一个用安全管理文档回应的选项：钥匙丢失由保洁公司负责补配并更换门锁，或客户钥匙存放在上锁的保险柜中。",
    rests: [[line(SECURITY_ZH, "钥匙丢失"), line(SECURITY_ZH, "保险柜")]],
  },
  {
    id: "zh10-no-discount",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "月费能不能给我们打八折？" }],
    documents: [DISCOUNTS_ZH],
    answer: "礼貌地拒绝打八折，同时推进：最高折扣为 10%，而且仅限 24 个月的合同。",
    rests: [[line(DISCOUNTS_ZH, "最高折扣")]],
    avoid: "答应打八折，或给出折扣政策不允许的折扣",
  },
  {
    id: "zh10-no-today",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "需要的时候可以随时加派。" },
      { who: "them", text: "太好了，今天下午能派人来吗？明天有客人来访。" },
    ],
    documents: [EXTRA_ZH],
    answer: "礼貌地拒绝今天下午上门：加派保洁需提前 48 小时预约；可以提出预约最近的一次。",
    rests: [[line(EXTRA_ZH, "48 小时")]],
    avoid: "答应今天下午派人",
  },
  {
    id: "zh10-ask-sites",
    language: "zh-CN",
    kind: "ask",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们在城里有三个办公点，大小都不一样。" },
      { who: "me", text: "明白。" },
    ],
    documents: [QUOTES_ZH],
    answer: "一个推进到逐个办公点实地查看的问题：每个办公点在实地查看后单独报价，实地查看不收费。",
    rests: [[line(QUOTES_ZH, "单独报价"), line(QUOTES_ZH, "约一小时")]],
  },
  {
    id: "zh10-check-right",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "你们的资料上写着每次上门都会补充洗手间用品，对吧？" },
      { who: "me", text: "我核对一下。" },
    ],
    documents: [SUPPLIES_ZH],
    answer: "对方说得对：文档写明每次上门都会补充洗手间用品。",
    rests: [[line(SUPPLIES_ZH, "每次上门")]],
  },
  {
    id: "zh10-check-wrong",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "而且窗户也包含在月费里，里外都包括。" }],
    documents: [WINDOWS_ZH],
    answer: "部分不对：室内窗户每月清洁一次、包含在月费中，但室外窗户另行报价。",
    rests: [[line(WINDOWS_ZH, "室外窗户")]],
    avoid: "说室外窗户包含在月费中",
  },
  {
    id: "zh10-want-bins",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: BINS_ZH },
      { who: "me", text: "多久会出现一次？" },
      { who: "them", text: MONDAYS_ZH },
    ],
    documents: [WASTE_ZH],
    answer: "对方想解决垃圾桶的问题：每周一早上过完周末垃圾桶满出来，是员工投诉最多的。",
    rests: [[said(BINS_ZH), said(MONDAYS_ZH)]],
  },
  {
    id: "zh10-sum",
    language: "zh-CN",
    kind: "sum",
    needs: "whole",
    long: false,
    turns: [
      { who: "me", text: START_ZH },
      { who: "them", text: "好的，进出权限由郝宇宁对接。" },
      { who: "me", text: QUOTE_ZH },
      { who: "them", text: "好。" },
    ],
    documents: [ONBOARDING_ZH],
    answer: "几行总结：6 月 1 日先从一楼开始；郝宇宁负责进出权限；用户周四前发修改后的报价。",
    rests: [[said(START_ZH)], [said(QUOTE_ZH)]],
  },
  {
    id: "zh10-answer-insurance",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "如果你们的人在我们办公室弄坏了东西，有保险吗？" }],
    documents: [INSURANCE_ZH],
    answer: "有：投保了 500 万元的公众责任险；损坏须在 7 天内告知。",
    rests: [[line(INSURANCE_ZH, "公众责任险")]],
  },
  {
    id: "zh10-say-start",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [{ who: "them", text: "我们新办公室开业前需要有人到位。" }],
    documents: [STARTING_ZH],
    answer: "一个选项：新合同在签约后 10 个工作日内开始服务，或现场经理在第一周上门确认清单。",
    rests: [[line(STARTING_ZH, "10 个工作日"), line(STARTING_ZH, "现场经理")]],
    avoid: "给出文档没有的开始日期",
  },
];

export const CALL_HELP_MARKS: readonly CallHelpCase[] = [...ENGLISH, ...CHINESE];
