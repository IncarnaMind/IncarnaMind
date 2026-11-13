/**
 * A STAND-IN for the form's held-out gate (#2847): the gate's slots and case type on a made-up topic
 * (a laundry-machine rental for hotels), so its harness, record and reading tools can be built and
 * dry-run without the held-out cases. Never used for a paid run. Its slots are in
 * callHelpFactLinesStandIn.slots.md.
 */
import type { MeetingHelpKind, MeetingHelpTemplate } from "../../src/shared/meetingHelp";
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

export type TemplateCallHelpCase = Omit<CallHelpCase, "kind"> & {
  kind: MeetingHelpKind;
  template?: MeetingHelpTemplate;
};

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const RATES_EN = doc("Rental rates.md", "Rental rates", [
  "A 20 kg washer rents for €310 a month, servicing included.",
  "A 30 kg dryer rents for €280 a month, servicing included.",
  "The lowest monthly rate we offer is 8% below list, and only on a three-year term.",
  "Installation is charged once, at €450 a machine.",
]);
const TERMS_EN = doc("Rental terms.md", "Rental terms", [
  "The shortest rental term is twelve months.",
  "Machines are delivered within fifteen working days of signing.",
  "A broken machine is repaired or swapped within two working days.",
  "Either side can end the rental with ninety days' written notice after the first year.",
]);
const CARE_EN = doc("Care guide.md", "Care guide", [
  "Each washer is serviced every six months by our own technicians.",
  "Detergent is not part of the rental; we recommend a low-foam detergent.",
  "Every machine is checked against the hotel's water hardness before it is installed.",
]);
const GUIDE_EN = doc("Interview guide.md", "Interview guide", [
  "How many rooms does the hotel run, and how full is it in winter?",
  "Who does the laundry today, and where?",
  "What breaks most often in the current machines?",
  "What would make the hotel switch supplier?",
]);
const RATES_ZH = doc("租赁价格.md", "租赁价格", [
  "20 公斤洗衣机月租 2,400 元，含保养。",
  "30 公斤烘干机月租 2,200 元，含保养。",
  "月租最多比标价低 8%，且仅限三年租期。",
  "安装费一次性收取，每台 3,500 元。",
]);
const TERMS_ZH = doc("租赁条款.md", "租赁条款", [
  "最短租期为十二个月。",
  "签约后十五个工作日内送货。",
  "机器故障在两个工作日内修复或更换。",
  "满一年后，任何一方提前九十天书面通知即可终止租赁。",
]);
const CARE_ZH = doc("保养说明.md", "保养说明", [
  "每台洗衣机每六个月由我们的技师保养一次。",
  "租金不含洗涤剂，我们建议使用低泡洗涤剂。",
  "每台机器安装前都会按酒店的水质硬度检查。",
]);
const GUIDE_ZH = doc("访谈提纲.md", "访谈提纲", [
  "酒店有多少间客房，冬季入住率如何？",
  "现在由谁洗衣，在哪里洗？",
  "现有机器最常坏的是什么？",
  "什么情况下酒店会更换供应商？",
]);

const EN_SIZE = "We size the machines to your rooms and how often you change the linen.";
const EN_EARLIER = "We have forty rooms, and in winter we are about half full.";
const EN_FOLLOW = "Mostly the dryer. It stops halfway through and the sheets come out damp.";
const EN_LEADING = "You'd agree the current machines are too old, wouldn't you?";

const ZH_SIZE = "我们会按客房数和换洗频率来配机器。";
const ZH_EARLIER = "我们有四十间客房，冬天大概住一半。";
const ZH_FOLLOW = "主要是烘干机，经常烘到一半就停，床单出来还是潮的。";
const ZH_LEADING = "您也觉得现在的机器太旧了吧？";

const EN_LATER = "May works, but the dryers should come later, in June.";
const EN_TOGETHER = "I'd rather bring both together, so we install once.";
const EN_JUNE = "Then the dryers come in June, as you say.";
const EN_FRIDAY = "Fine, Ana signs off, and I'll send the plan by Friday.";
const WHOLE_EN = [
  { who: "me" as const, text: "Let's agree the washers arrive in the second week of May." },
  { who: "them" as const, text: EN_LATER },
  { who: "me" as const, text: EN_TOGETHER },
  { who: "them" as const, text: "We can't store a dryer for a month, we have no room." },
  { who: "me" as const, text: EN_JUNE },
  { who: "them" as const, text: "Good. And Ana on our side signs off the delivery." },
  { who: "me" as const, text: EN_FRIDAY },
];
const ZH_LATER = "五月可以，但烘干机要晚一点，六月再来。";
const ZH_TOGETHER = "我更希望一起送，这样只安装一次。";
const ZH_JUNE = "那烘干机就按你们说的六月送。";
const ZH_FRIDAY = "行，安娜签收，计划我周五前发过去。";
const WHOLE_ZH = [
  { who: "me" as const, text: "那洗衣机就定在五月第二周送到。" },
  { who: "them" as const, text: ZH_LATER },
  { who: "me" as const, text: ZH_TOGETHER },
  { who: "them" as const, text: "烘干机我们放不了一个月，没地方。" },
  { who: "me" as const, text: ZH_JUNE },
  { who: "them" as const, text: "好。我们这边由安娜签收。" },
  { who: "me" as const, text: ZH_FRIDAY },
];

/** One slot's case in each language: the same call, Documents and right answer. */
type Slot = {
  slot: number;
  kind: MeetingHelpKind;
  template?: MeetingHelpTemplate;
  needs: CallHelpCase["needs"];
  en: Omit<TemplateCallHelpCase, "id" | "language" | "kind" | "needs" | "long" | "template">;
  zh: Omit<TemplateCallHelpCase, "id" | "language" | "kind" | "needs" | "long" | "template">;
};

const SLOTS: readonly Slot[] = [
  {
    slot: 1,
    kind: "answer",
    needs: "newest",
    en: {
      turns: [
        { who: "me", text: EN_SIZE },
        { who: "them", text: "What does a 20 kg washer cost us a month?" },
      ],
      documents: [RATES_EN],
      answer: "€310 a month, servicing included.",
      rests: [[line(RATES_EN, "20 kg washer")]],
    },
    zh: {
      turns: [
        { who: "me", text: ZH_SIZE },
        { who: "them", text: "一台 20 公斤的洗衣机每月多少钱？" },
      ],
      documents: [RATES_ZH],
      answer: "月租 2,400 元，含保养。",
      rests: [[line(RATES_ZH, "20 公斤洗衣机")]],
    },
  },
  {
    slot: 2,
    kind: "answer",
    needs: "earlier",
    en: {
      before: [{ who: "them", text: EN_EARLIER }],
      turns: [
        { who: "me", text: "Thanks, that helps us plan." },
        {
          who: "them",
          text: "Given what I told you about our rooms, how soon could the machines be here?",
        },
      ],
      documents: [TERMS_EN],
      answer: "Within fifteen working days of signing.",
      rests: [[line(TERMS_EN, "fifteen working days")]],
    },
    zh: {
      before: [{ who: "them", text: ZH_EARLIER }],
      turns: [
        { who: "me", text: "谢谢，这对我们安排很有帮助。" },
        { who: "them", text: "按我刚才说的客房情况，机器最快多久能到？" },
      ],
      documents: [TERMS_ZH],
      answer: "签约后十五个工作日内送货。",
      rests: [[line(TERMS_ZH, "十五个工作日")]],
    },
  },
  {
    slot: 3,
    kind: "answer",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "Do your machines work with our solar hot water?" }],
      documents: [CARE_EN],
      answer: "The Documents don't say; check and come back.",
      rests: [[line(CARE_EN, "water hardness")]],
      avoid: "saying the machines do or don't work with solar hot water",
    },
    zh: {
      turns: [{ who: "them", text: "你们的机器能用我们的太阳能热水吗？" }],
      documents: [CARE_ZH],
      answer: "文档没有说；先确认再回复。",
      rests: [[line(CARE_ZH, "水质硬度")]],
      avoid: "说机器能或不能用太阳能热水",
    },
  },
  {
    slot: 4,
    kind: "say",
    needs: "newest",
    en: {
      turns: [
        { who: "them", text: "What happens if a machine breaks in the middle of the season?" },
      ],
      documents: [TERMS_EN],
      answer: "It is repaired or swapped within two working days.",
      rests: [[line(TERMS_EN, "two working days")]],
    },
    zh: {
      turns: [{ who: "them", text: "旺季中间机器坏了怎么办？" }],
      documents: [TERMS_ZH],
      answer: "两个工作日内修复或更换。",
      rests: [[line(TERMS_ZH, "两个工作日")]],
    },
  },
  {
    slot: 5,
    kind: "say",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "Can you promise the machines never break in the first year?" }],
      documents: [TERMS_EN],
      answer: "No promise the Documents give; repairs within two working days.",
      rests: [[line(TERMS_EN, "two working days")]],
      avoid: "promising the machines won't break",
    },
    zh: {
      turns: [{ who: "them", text: "你们能保证第一年机器绝对不坏吗？" }],
      documents: [TERMS_ZH],
      answer: "文档没有这样的承诺；两个工作日内修复。",
      rests: [[line(TERMS_ZH, "两个工作日")]],
      avoid: "承诺机器不会坏",
    },
  },
  {
    slot: 6,
    kind: "no",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "We'd sign today at €250 a month for the washer." }],
      documents: [RATES_EN],
      answer: "No: at most 8% below list, and only on a three-year term.",
      rests: [[line(RATES_EN, "8% below list")]],
      avoid: "agreeing to €250 a month",
    },
    zh: {
      turns: [{ who: "them", text: "洗衣机每月 1,900 元的话我们今天就签。" }],
      documents: [RATES_ZH],
      answer: "不行：最多比标价低 8%，且仅限三年租期。",
      rests: [[line(RATES_ZH, "低 8%")]],
      avoid: "同意每月 1,900 元",
    },
  },
  {
    slot: 7,
    kind: "no",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "Could we rent just for the six summer months?" }],
      documents: [TERMS_EN],
      answer: "No: the shortest term is twelve months.",
      rests: [[line(TERMS_EN, "shortest rental term")]],
      avoid: "agreeing to a six-month rental",
    },
    zh: {
      turns: [{ who: "them", text: "我们能只租夏天六个月吗？" }],
      documents: [TERMS_ZH],
      answer: "不行：最短租期为十二个月。",
      rests: [[line(TERMS_ZH, "最短租期")]],
      avoid: "同意租六个月",
    },
  },
  {
    slot: 8,
    kind: "ask",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "We want the machines in before the spring rush." }],
      documents: [CARE_EN],
      answer: "Ask the water hardness, since each machine is checked against it first.",
      rests: [[line(CARE_EN, "water hardness")]],
    },
    zh: {
      turns: [{ who: "them", text: "我们希望春季旺季前装好机器。" }],
      documents: [CARE_ZH],
      answer: "问水质硬度，因为每台机器安装前要按它检查。",
      rests: [[line(CARE_ZH, "水质硬度")]],
    },
  },
  {
    slot: 9,
    kind: "objection",
    template: "sales",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "Renting is more expensive than buying our own machines." }],
      documents: [RATES_EN],
      answer: "Servicing is included in the monthly rate.",
      rests: [[line(RATES_EN, "20 kg washer")]],
      avoid: "claiming renting is cheaper overall than buying",
    },
    zh: {
      turns: [{ who: "them", text: "租比我们自己买机器贵。" }],
      documents: [RATES_ZH],
      answer: "月租含保养。",
      rests: [[line(RATES_ZH, "20 公斤洗衣机")]],
      avoid: "声称租总体上比买便宜",
    },
  },
  {
    slot: 10,
    kind: "nextStep",
    template: "sales",
    needs: "newest",
    en: {
      turns: [
        {
          who: "them",
          text: "This sounds right for us. If we sign, how soon are the machines delivered?",
        },
      ],
      documents: [TERMS_EN],
      answer: "Sign, and the machines are delivered within fifteen working days.",
      rests: [[line(TERMS_EN, "fifteen working days")]],
    },
    zh: {
      turns: [{ who: "them", text: "听起来挺合适。如果签约，机器多久能送到？" }],
      documents: [TERMS_ZH],
      answer: "签约后十五个工作日内送货。",
      rests: [[line(TERMS_ZH, "十五个工作日")]],
    },
  },
  {
    slot: 11,
    kind: "followUp",
    template: "interview",
    needs: "newest",
    en: {
      turns: [
        { who: "me", text: "What breaks most often in your current machines?" },
        { who: "them", text: EN_FOLLOW },
      ],
      documents: [],
      answer: "Ask how often the dryer stops, and what it costs them.",
      rests: [[said(EN_FOLLOW)]],
    },
    zh: {
      turns: [
        { who: "me", text: "现有机器最常坏的是什么？" },
        { who: "them", text: ZH_FOLLOW },
      ],
      documents: [],
      answer: "追问烘干机多久停一次，给他们造成多少损失。",
      rests: [[said(ZH_FOLLOW)]],
    },
  },
  {
    slot: 12,
    kind: "leading",
    template: "interview",
    needs: "newest",
    en: {
      turns: [
        { who: "them", text: "We have had the machines for nine years." },
        { who: "me", text: EN_LEADING },
      ],
      documents: [],
      answer: "Yes, it is leading; ask what they think of the machines instead.",
      rests: [[said(EN_LEADING)]],
    },
    zh: {
      turns: [
        { who: "them", text: "这些机器我们用了九年了。" },
        { who: "me", text: ZH_LEADING },
      ],
      documents: [],
      answer: "是诱导；改问他们怎么看现在的机器。",
      rests: [[said(ZH_LEADING)]],
    },
  },
  {
    slot: 13,
    kind: "sum",
    needs: "whole",
    en: {
      turns: WHOLE_EN,
      documents: [],
      answer: "Washers in the second week of May, dryers in June; Ana signs off; plan by Friday.",
      rests: [[said(EN_JUNE)], [said(EN_FRIDAY)]],
      avoid: "saying washers and dryers come together",
    },
    zh: {
      turns: WHOLE_ZH,
      documents: [],
      answer: "洗衣机五月第二周到，烘干机六月；安娜签收；周五前发计划。",
      rests: [[said(ZH_JUNE)], [said(ZH_FRIDAY)]],
      avoid: "说洗衣机和烘干机一起送",
    },
  },
  {
    slot: 14,
    kind: "facts",
    template: "sales",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "Tell me what we'd pay to get started." }],
      documents: [RATES_EN],
      answer: "€310 a month for a washer, €280 for a dryer, €450 installation a machine.",
      rests: [[line(RATES_EN, "20 kg washer")], [line(RATES_EN, "Installation")]],
    },
    zh: {
      turns: [{ who: "them", text: "说说我们起步要付多少钱。" }],
      documents: [RATES_ZH],
      answer: "洗衣机月租 2,400 元，烘干机 2,200 元，每台安装费 3,500 元。",
      rests: [[line(RATES_ZH, "20 公斤洗衣机")], [line(RATES_ZH, "安装费")]],
    },
  },
  {
    slot: 15,
    kind: "notCovered",
    template: "interview",
    needs: "newest",
    en: {
      turns: [
        { who: "me", text: "How many rooms do you run?" },
        { who: "them", text: "Forty, about half full in winter." },
        { who: "me", text: "And who does the laundry today?" },
        { who: "them", text: "Two of our staff, in the basement." },
      ],
      documents: [GUIDE_EN],
      answer: "Not yet covered: what breaks most often, and what would make them switch.",
      rests: [[line(GUIDE_EN, "What breaks")], [line(GUIDE_EN, "switch supplier")]],
    },
    zh: {
      turns: [
        { who: "me", text: "你们有多少间客房？" },
        { who: "them", text: "四十间，冬天大概住一半。" },
        { who: "me", text: "现在谁负责洗衣？" },
        { who: "them", text: "两位员工，在地下室洗。" },
      ],
      documents: [GUIDE_ZH],
      answer: "还没问到：最常坏的是什么，什么情况下会换供应商。",
      rests: [[line(GUIDE_ZH, "最常坏")], [line(GUIDE_ZH, "更换供应商")]],
    },
  },
  {
    slot: 16,
    kind: "decisions",
    template: "team",
    needs: "whole",
    en: {
      turns: WHOLE_EN,
      documents: [],
      answer: "Dryers come in June; Ana signs off the delivery; the plan goes out by Friday.",
      rests: [[said(EN_JUNE)], [said(EN_FRIDAY)]],
    },
    zh: {
      turns: WHOLE_ZH,
      documents: [],
      answer: "烘干机六月送；安娜签收；周五前发计划。",
      rests: [[said(ZH_JUNE)], [said(ZH_FRIDAY)]],
    },
  },
  {
    slot: 17,
    kind: "disagree",
    template: "team",
    needs: "whole",
    en: {
      turns: WHOLE_EN,
      documents: [],
      answer: "Whether washers and dryers come together; settled as June for the dryers.",
      rests: [[said(EN_LATER)], [said(EN_TOGETHER)]],
    },
    zh: {
      turns: WHOLE_ZH,
      documents: [],
      answer: "洗衣机和烘干机是否一起送；最后定为烘干机六月。",
      rests: [[said(ZH_LATER)], [said(ZH_TOGETHER)]],
    },
  },
  {
    slot: 18,
    kind: "check",
    needs: "newest",
    en: {
      turns: [{ who: "me", text: "Servicing is included in the washer's monthly rate." }],
      documents: [RATES_EN],
      answer: "Right: €310 a month, servicing included.",
      rests: [[line(RATES_EN, "20 kg washer")]],
    },
    zh: {
      turns: [{ who: "me", text: "洗衣机的月租是含保养的。" }],
      documents: [RATES_ZH],
      answer: "对：月租 2,400 元，含保养。",
      rests: [[line(RATES_ZH, "20 公斤洗衣机")]],
    },
  },
  {
    slot: 19,
    kind: "check",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "So detergent comes with the rental, right?" }],
      documents: [CARE_EN],
      answer: "Wrong: detergent is not part of the rental.",
      rests: [[line(CARE_EN, "Detergent")]],
      avoid: "agreeing that detergent is included",
    },
    zh: {
      turns: [{ who: "them", text: "所以洗涤剂是包含在租金里的，对吧？" }],
      documents: [CARE_ZH],
      answer: "不对：租金不含洗涤剂。",
      rests: [[line(CARE_ZH, "洗涤剂")]],
      avoid: "同意租金含洗涤剂",
    },
  },
  {
    slot: 20,
    kind: "answer",
    needs: "newest",
    en: {
      turns: [{ who: "them", text: "How many kilowatt hours does a washer use a month?" }],
      documents: [RATES_EN],
      answer: "The Documents don't give it; check and come back.",
      rests: [[line(RATES_EN, "20 kg washer")]],
      avoid: "giving a figure for the energy use",
    },
    zh: {
      turns: [{ who: "them", text: "一台洗衣机每月用多少度电？" }],
      documents: [RATES_ZH],
      answer: "文档没有给出；先确认再回复。",
      rests: [[line(RATES_ZH, "20 公斤洗衣机")]],
      avoid: "给出耗电量的数字",
    },
  },
];

const pad = (slot: number) => String(slot).padStart(2, "0");

export const CALL_HELP_FACT_LINES_STAND_IN: readonly TemplateCallHelpCase[] = (
  ["en", "zh"] as const
).flatMap((language) =>
  SLOTS.map(
    (each): TemplateCallHelpCase => ({
      ...each[language],
      id: `standin-${language}-${pad(each.slot)}-${each.kind}`,
      language: language === "en" ? "en" : "zh-CN",
      kind: each.kind,
      needs: each.needs,
      long: false,
      ...(each.template && { template: each.template }),
    }),
  ),
);
