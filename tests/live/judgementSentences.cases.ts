import type { RemarkNote } from "./remarkSentences.cases";

/**
 * Notes that hold what a writer adds to a Document's facts (#3322): the writer's own judgements
 * (advice, a view, a forecast), each with what the Document gives for it, and conclusions the
 * writer worked out from the Document's facts, sound ones and unsound ones. On invented Documents
 * of a few lines.
 *
 * The view Notes (`-v`): beside one right and one wrong fact, nine judgements: three the
 * Document's facts are a reason for, three it holds nothing on, three its facts point against.
 * The worked-out Notes (`-i`): three conclusions that follow for certain (a sum, plain logic),
 * three judgements the facts are a reason for, and three conclusions that don't follow (a wrong
 * sum, the wrong way round, no link).
 * The boundary Notes (`-k`, #3332): conclusions given with their reason ("since", "so"). Three
 * follow for certain; four give a true fact as the reason for what it goes against; four are
 * evaluations that need a standard no Document gives (affordable, too few, cheap), though the
 * figures can be compared; two are forecasts the facts are a reason for.
 *
 * The set is fixed: a Note is not edited once a baseline rests on it, and a new shape is a new Note.
 */
export interface JudgementNote extends RemarkNote {
  lines: readonly (RemarkNote["lines"][number] & {
    /** For a judgement: what the Document gives for it. */
    grounds?: "for" | "against" | "none";
    /** A right sentence the Document doesn't state but that follows from what it states. */
    worked?: true;
  })[];
}

export const JUDGEMENT_NOTES: readonly JudgementNote[] = [
  {
    id: "en-v1",
    language: "en",
    name: "Helpdesk review",
    document:
      "The helpdesk has 6 agents and answered 9,200 tickets in 2026. Ticket volume is forecast to grow 15% in 2027. The head of support, Mara Lindqvist, said the team cannot keep its reply time if volume grows. Customer satisfaction fell from 91% to 84% during 2026. The chat tool's contract ends in June 2027 and costs £18,000 a year. Two agents are due to retire in 2027.",
    lines: [
      { sentence: "Ticket volume is forecast to grow 15% in 2027.", expected: "right" },
      { sentence: "Customer satisfaction fell from 91% to 74% during 2026.", expected: "wrong" },
      { sentence: "We should hire before the summer.", expected: "none", grounds: "for" },
      {
        sentence: "My suggestion is 2 more agents, starting in May.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "Customer satisfaction is the number I would worry about most.",
        expected: "none",
        grounds: "for",
      },
      { sentence: "I would move the team to a four-day week.", expected: "none", grounds: "none" },
      {
        sentence: "We should rename the helpdesk to Customer Care.",
        expected: "none",
        grounds: "none",
      },
      {
        sentence: "A second office in Leeds would be worth exploring.",
        expected: "none",
        grounds: "none",
      },
      {
        sentence:
          "In my view the team can comfortably absorb next year's volume without new hires.",
        expected: "none",
        grounds: "against",
      },
      {
        sentence: "I see no reason to worry about customer satisfaction.",
        expected: "none",
        grounds: "against",
      },
      {
        sentence: "The decision on the chat tool can wait until 2028.",
        expected: "none",
        grounds: "against",
      },
    ],
  },
  {
    id: "en-v2",
    language: "en",
    name: "Shop lease options",
    document:
      "The shop's lease ends on 31 March 2027. The landlord offers a five-year renewal at £42,000 a year, up from £36,000. A unit of the same size on Mill Street is offered at £33,000 a year, with a fit-out estimated at £25,000. Footfall on Mill Street is about 40% lower than on the High Street, according to the council's 2026 count. The shop made a profit of £58,000 in 2026.",
    lines: [
      { sentence: "The landlord offers a five-year renewal at £42,000 a year.", expected: "right" },
      { sentence: "The shop made a profit of £85,000 in 2026.", expected: "wrong" },
      {
        sentence: "I would not sign the renewal without negotiating the rent.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "Moving to Mill Street carries a real risk to sales.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "We need a decision well before the end of March.",
        expected: "none",
        grounds: "for",
      },
      { sentence: "We should also look at opening on Sundays.", expected: "none", grounds: "none" },
      { sentence: "A new logo would help the shop feel fresh.", expected: "none", grounds: "none" },
      {
        sentence: "I suggest we ask Priya to lead the project.",
        expected: "none",
        grounds: "none",
      },
      {
        sentence: "I expect the move to pay for itself within a few months.",
        expected: "none",
        grounds: "against",
      },
      {
        sentence: "The landlord's offer strikes me as a bargain compared with what we pay today.",
        expected: "none",
        grounds: "against",
      },
      {
        sentence: "There is plenty of time; we can pick this up again next summer.",
        expected: "none",
        grounds: "against",
      },
    ],
  },
  {
    id: "zh-v1",
    language: "zh-CN",
    name: "客服中心评估",
    document:
      "客服中心有6名客服，2026年共处理工单9,200张。预计2027年工单量增长15%。客服负责人林若棠表示，如果工单量继续增长，团队无法保持现在的回复时间。2026年客户满意度从91%降到84%。在线客服工具的合同2027年6月到期，每年费用18万元。有两名客服将在2027年退休。",
    lines: [
      { sentence: "预计2027年工单量增长15%。", expected: "right" },
      { sentence: "2026年客户满意度从91%降到74%。", expected: "wrong" },
      { sentence: "我们应该在夏天之前招人。", expected: "none", grounds: "for" },
      { sentence: "我的建议是增加2名客服，5月到岗。", expected: "none", grounds: "for" },
      { sentence: "客户满意度是我最担心的一个数字。", expected: "none", grounds: "for" },
      { sentence: "我会考虑让团队改成四天工作制。", expected: "none", grounds: "none" },
      { sentence: "我们应该把客服中心改名为“客户关怀部”。", expected: "none", grounds: "none" },
      { sentence: "在成都设第二个办公点值得研究一下。", expected: "none", grounds: "none" },
      {
        sentence: "在我看来，不招人团队也能轻松应付明年的工单量。",
        expected: "none",
        grounds: "against",
      },
      { sentence: "我觉得客户满意度没有什么可担心的。", expected: "none", grounds: "against" },
      { sentence: "在线客服工具的事可以等到2028年再决定。", expected: "none", grounds: "against" },
    ],
  },
  {
    id: "zh-v2",
    language: "zh-CN",
    name: "店面租约方案",
    document:
      "店面的租约2027年3月31日到期。房东提出续租五年，年租金42万元，现租金为36万元。磨坊街一处同样大小的店面年租金33万元，装修费用估计为25万元。根据区政府2026年的统计，磨坊街的人流量比中心大街低约40%。店铺2026年盈利58万元。",
    lines: [
      { sentence: "房东提出续租五年，年租金42万元。", expected: "right" },
      { sentence: "店铺2026年盈利85万元。", expected: "wrong" },
      { sentence: "不谈租金，我不会签续租合同。", expected: "none", grounds: "for" },
      { sentence: "搬到磨坊街对销售额有实实在在的风险。", expected: "none", grounds: "for" },
      { sentence: "我们需要在3月底之前早早做出决定。", expected: "none", grounds: "for" },
      { sentence: "我们也应该考虑周日营业。", expected: "none", grounds: "none" },
      { sentence: "换一个新标志会让店铺显得更有新意。", expected: "none", grounds: "none" },
      { sentence: "我建议请普丽娅来负责这个项目。", expected: "none", grounds: "none" },
      { sentence: "我估计搬家的花费几个月就能赚回来。", expected: "none", grounds: "against" },
      {
        sentence: "和现在的租金相比，我觉得房东的报价很划算。",
        expected: "none",
        grounds: "against",
      },
      { sentence: "时间还很充裕，这件事可以明年夏天再说。", expected: "none", grounds: "against" },
    ],
  },
  {
    id: "en-i1",
    language: "en",
    name: "Helpdesk figures",
    document:
      "The helpdesk has 6 agents and answered 9,200 tickets in 2026. Ticket volume is forecast to grow 15% in 2027. The head of support, Mara Lindqvist, said the team cannot keep its reply time if volume grows. Customer satisfaction fell from 91% to 84% during 2026. The chat tool's contract ends in June 2027 and costs £18,000 a year. Two agents are due to retire in 2027.",
    lines: [
      {
        sentence: "So the helpdesk should expect more than 10,000 tickets in 2027.",
        expected: "right",
        worked: true,
      },
      {
        sentence: "Each agent handled about 1,500 tickets on average in 2026.",
        expected: "right",
        worked: true,
      },
      {
        sentence: "If nobody is hired, the team will be down to 4 agents after the retirements.",
        expected: "right",
        worked: true,
      },
      { sentence: "So we should hire before the summer.", expected: "none", grounds: "for" },
      {
        sentence: "With two retirements coming, reply times are likely to get worse next year.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "The falling satisfaction score is probably linked to slow replies.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "So the helpdesk should expect more than 20,000 tickets in 2027.",
        expected: "wrong",
      },
      {
        sentence:
          "Because satisfaction fell to 84%, customers are clearly happier with the service than before.",
        expected: "wrong",
      },
      {
        sentence: "Since the chat tool's contract ends in June, ticket volume will fall next year.",
        expected: "wrong",
      },
    ],
  },
  {
    id: "en-i2",
    language: "en",
    name: "Shop lease figures",
    document:
      "The shop's lease ends on 31 March 2027. The landlord offers a five-year renewal at £42,000 a year, up from £36,000. A unit of the same size on Mill Street is offered at £33,000 a year, with a fit-out estimated at £25,000. Footfall on Mill Street is about 40% lower than on the High Street, according to the council's 2026 count. The shop made a profit of £58,000 in 2026.",
    lines: [
      {
        sentence: "The renewal would cost £6,000 a year more than the shop pays today.",
        expected: "right",
        worked: true,
      },
      {
        sentence: "Mill Street would save £9,000 a year in rent compared with the renewal.",
        expected: "right",
        worked: true,
      },
      {
        sentence: "At that saving, the fit-out would take nearly three years to pay back.",
        expected: "right",
        worked: true,
      },
      {
        sentence: "Lower footfall on Mill Street would probably mean lower sales.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "It is worth trying to negotiate the renewal rent down.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "The shop can afford the higher rent, though it would eat into profit.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence: "The renewal would cost £16,000 a year more than the shop pays today.",
        expected: "wrong",
      },
      { sentence: "The fit-out would pay for itself within a year.", expected: "wrong" },
      {
        sentence:
          "Since footfall on Mill Street is 40% lower, moving there would bring in more customers.",
        expected: "wrong",
      },
    ],
  },
  {
    id: "zh-i1",
    language: "zh-CN",
    name: "客服中心数据",
    document:
      "客服中心有6名客服，2026年共处理工单9,200张。预计2027年工单量增长15%。客服负责人林若棠表示，如果工单量继续增长，团队无法保持现在的回复时间。2026年客户满意度从91%降到84%。在线客服工具的合同2027年6月到期，每年费用18万元。有两名客服将在2027年退休。",
    lines: [
      { sentence: "所以2027年工单量预计会超过一万张。", expected: "right", worked: true },
      { sentence: "2026年平均每名客服处理约1,500张工单。", expected: "right", worked: true },
      { sentence: "如果不招人，退休之后团队只剩4名客服。", expected: "right", worked: true },
      { sentence: "所以我们应该在夏天之前招人。", expected: "none", grounds: "for" },
      { sentence: "两人退休之后，明年的回复时间很可能变慢。", expected: "none", grounds: "for" },
      { sentence: "满意度下降很可能和回复慢有关。", expected: "none", grounds: "for" },
      { sentence: "所以2027年工单量预计会超过两万张。", expected: "wrong" },
      { sentence: "满意度降到84%，说明客户对服务比以前更满意了。", expected: "wrong" },
      { sentence: "因为在线客服工具的合同6月到期，明年工单量会下降。", expected: "wrong" },
    ],
  },
  {
    id: "zh-i2",
    language: "zh-CN",
    name: "店面租约数据",
    document:
      "店面的租约2027年3月31日到期。房东提出续租五年，年租金42万元，现租金为36万元。磨坊街一处同样大小的店面年租金33万元，装修费用估计为25万元。根据区政府2026年的统计，磨坊街的人流量比中心大街低约40%。店铺2026年盈利58万元。",
    lines: [
      { sentence: "续租每年要比现在多付6万元。", expected: "right", worked: true },
      { sentence: "和续租相比，磨坊街每年能省9万元租金。", expected: "right", worked: true },
      { sentence: "按这个差额，装修费要将近三年才能赚回来。", expected: "right", worked: true },
      { sentence: "磨坊街人流量低，销售额很可能也会更低。", expected: "none", grounds: "for" },
      { sentence: "值得试着把续租的租金谈低一些。", expected: "none", grounds: "for" },
      {
        sentence: "店铺付得起涨后的租金，不过利润会被吃掉一块。",
        expected: "none",
        grounds: "for",
      },
      { sentence: "续租每年要比现在多付16万元。", expected: "wrong" },
      { sentence: "装修费一年之内就能赚回来。", expected: "wrong" },
      { sentence: "磨坊街人流量低40%，搬过去会带来更多顾客。", expected: "wrong" },
    ],
  },
  {
    id: "en-k1",
    language: "en",
    name: "Larch Lane Bakery accounts",
    document:
      "Larch Lane Bakery sold 48,000 loaves in 2026, up from 40,000 in 2025. Flour cost £0.42 a loaf in 2026 and £0.35 in 2025. The shop price stayed at £3.20 a loaf in both years. The oven holds 180 loaves a batch and runs 6 batches a day. The bakery employs 5 bakers. A second oven is quoted at £27,000. Profit was £31,000 in 2026.",
    lines: [
      {
        sentence:
          "Since each batch holds 180 loaves and there are 6 batches a day, the oven can bake 1,080 loaves a day.",
        expected: "right",
        worked: true,
      },
      {
        sentence:
          "Sales grew by a fifth, so the bakery sold 8,000 more loaves than the year before.",
        expected: "right",
        worked: true,
      },
      {
        sentence:
          "Because the price stayed at £3.20 while flour rose to £0.42, flour took a larger share of each loaf's price in 2026.",
        expected: "right",
        worked: true,
      },
      {
        sentence:
          "Since sales rose from 40,000 to 48,000 loaves, the bakery is selling fewer loaves than before.",
        expected: "wrong",
      },
      {
        sentence:
          "Since flour now costs more per loaf and the price has not moved, each loaf will earn the bakery more.",
        expected: "wrong",
      },
      {
        sentence:
          "A second oven is quoted at £27,000, less than last year's profit, so one year's profit could not pay for it.",
        expected: "wrong",
      },
      {
        sentence:
          "Because the oven can bake only 1,080 loaves a day, buying a second oven would cut how much the bakery can bake.",
        expected: "wrong",
      },
      { sentence: "The bakery can comfortably afford a second oven.", expected: "none" },
      { sentence: "Five bakers are too few for this volume.", expected: "none" },
      { sentence: "Flour at £0.42 a loaf is still cheap.", expected: "none" },
      { sentence: "Growth of a fifth in a year is a strong result.", expected: "none" },
      {
        sentence:
          "With sales up a fifth, the oven will probably be the bottleneck within two years.",
        expected: "none",
        grounds: "for",
      },
      {
        sentence:
          "Since flour keeps getting dearer, the price will probably have to rise next year.",
        expected: "none",
        grounds: "for",
      },
    ],
  },
  {
    id: "zh-k1",
    language: "zh-CN",
    name: "松巷面包店账目",
    document:
      "松巷面包店2026年卖出48,000个面包，2025年为40,000个。2026年每个面包的面粉成本为4.2元，2025年为3.5元。两年的售价都是每个32元。烤炉每炉能烤180个，每天烤6炉。面包店有5名面包师。再买一台烤炉的报价是27万元。2026年利润为31万元。",
    lines: [
      {
        sentence: "每炉180个、每天6炉，所以烤炉一天能烤1,080个。",
        expected: "right",
        worked: true,
      },
      {
        sentence: "销量增长了五分之一，也就是比上一年多卖了8,000个。",
        expected: "right",
        worked: true,
      },
      {
        sentence:
          "售价一直是32元，而面粉成本涨到4.2元，所以2026年面粉在每个面包售价里占的比例更高了。",
        expected: "right",
        worked: true,
      },
      {
        sentence: "销量从40,000个涨到48,000个，所以面包店现在卖得比以前少了。",
        expected: "wrong",
      },
      {
        sentence: "面粉成本涨了而售价没变，所以每个面包会让面包店赚得更多。",
        expected: "wrong",
      },
      {
        sentence: "第二台烤炉要27万元，比去年的利润少，所以面包店一年的利润付不起它。",
        expected: "wrong",
      },
      {
        sentence: "烤炉一天只能烤1,080个，所以再买一台会让面包店能烤的数量变少。",
        expected: "wrong",
      },
      { sentence: "面包店完全买得起第二台烤炉。", expected: "none" },
      { sentence: "这样的销量，5名面包师太少了。", expected: "none" },
      { sentence: "每个面包4.2元的面粉成本仍然算便宜。", expected: "none" },
      { sentence: "一年增长五分之一是很好的成绩。", expected: "none" },
      {
        sentence: "销量涨了五分之一，烤炉很可能两年内就成为瓶颈。",
        expected: "none",
        grounds: "for",
      },
      { sentence: "面粉越来越贵，明年售价很可能得涨。", expected: "none", grounds: "for" },
    ],
  },
];
