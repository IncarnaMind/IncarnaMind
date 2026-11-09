/**
 * A User's Tag is offered for a Document only when the Document is about it, not when it merely
 * mentions it (#2339): its words against those of the Documents carrying the Tag, on this
 * computer, before anything is sent. Literal English and Chinese texts.
 */
import { describe, expect, test } from "vitest";
import { tagsAbout } from "../../src/core/tags/about";

const essays = {
  tag: { id: "essays", name: "个人随笔", description: "随手写下的散文和感想" },
  texts: [
    "秋天的傍晚，我一个人走在河边。落叶铺满了小路，风里有桂花的香气。我想起小时候和外婆一起捡栗子的日子，那时的秋天好像更长，也更安静。",
    "又到了秋天。窗外的银杏叶一片片变黄，我泡了一杯茶，坐在阳台上读一本旧书。秋天总让人想起离别和思念，也让人学会和自己相处。",
  ],
};

const points = {
  tag: {
    id: "points",
    name: "Membership points",
    description: "The membership points feature: earning and redeeming points",
  },
  texts: [
    "Weekly report: membership points. This week the membership points feature reached 12,000 members. Points earned per order rose 8%, and redemptions of points for vouchers doubled. Members who earn points order more often. Next week: points expiry reminders and a points balance page.",
  ],
};

/** Other Documents of the Library, which say how common each word is. */
const background = [
  "2026年第一季度销售报告：华东区销售额同比增长12%，线上渠道占比提升到45%。下季度重点是新品推广和渠道下沉。",
  "会议纪要：讨论了办公室搬迁的时间表，行政部负责联系物业，预算由财务部审批。",
  "租赁合同：甲方将位于浦东的仓库出租给乙方，租期三年，每月租金人民币五万元。",
  "Q3 sales report. Revenue grew 6% on the quarter, led by the north region. Margins held. Next quarter the team focuses on renewals.",
  "Board minutes. The board approved the budget and the office move. Actions: finance to report on hiring.",
  "Mutual NDA between Alder Systems and Kestrel Bio. Each party keeps the other's information confidential for three years.",
  "Lease of the Harbour Street office for five years, rent paid quarterly in advance.",
  "Project plan for the website redesign: discovery, design, build and launch, with owners and dates.",
];

describe("A User's Tag is offered only to a Document about it (#2339)", () => {
  test("a film review is not offered the Tag made for autumn essays; a new autumn essay is", () => {
    const review =
      "《流浪地球》影评：这部电影讲述了人类推动地球离开太阳系的故事。特效震撼，吴京饰演的航天员令人动容。影片的科幻设定扎实，剧情节奏紧凑，是中国科幻电影的一个里程碑。";
    const essay =
      "秋天的早晨很凉，我在公园里散步，看见落叶在风里打转。秋天的颜色让我想起故乡的田野，想起外婆做的桂花糕。";

    expect(tagsAbout(review, [essays], background)).toEqual([]);
    expect(tagsAbout(essay, [essays], background)).toEqual([essays.tag]);
  });

  test("a plan that only mentions membership points is not offered their Tag; an analysis of them is", () => {
    const plan =
      "Q3 marketing plan. Channels: social, email and search, with the budget split across six campaigns. The loyalty team will also mention membership points in the newsletter. Timeline, owners and targets for each campaign follow.";
    const analysis =
      "Membership points redemption analysis. Members redeemed 4,200 vouchers with their points this quarter. How members earn points per order, how points expire, and what the points balance page should show. Recommendations for the membership points feature.";

    expect(tagsAbout(plan, [points], background)).toEqual([]);
    expect(tagsAbout(analysis, [points], background)).toEqual([points.tag]);
  });

  test("a Tag on no Document yet goes by its name: offered where the Document says it", () => {
    const kitchen = {
      tag: { id: "kitchen", name: "Kitchen renovation", description: "Quotes and plans" },
      texts: [],
    };

    expect(
      tagsAbout("Countertop quote for the kitchen: quartz, 3 m.", [kitchen], background),
    ).toEqual([kitchen.tag]);
    expect(tagsAbout("Marathon training plan, week 6.", [kitchen], background)).toEqual([]);
  });
});
