/**
 * After a call the User typed notes in, the notes filled in on a real model (#2306): each line
 * filled out in place, then the sections the notes don't cover. Held-out calls in English and
 * Chinese, written for this test and heard through the fake capture and transcriber (no
 * microphone). For each call it counts the decisions, action items and figures that appear once
 * in the note, outside "Said in the call, not in your Documents" (a list to check, which repeats
 * them by design), each cited to a transcript line that says it with that line's speaker; and the
 * tokens and what they cost. The counts, notes and costs go to INCARNAMIND_LIVE_REPORT when set.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku
 * 5.5 by default; INCARNAMIND_LIVE_CALLS picks calls by id, comma-separated).
 */
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { Core, Meeting, MeetingFill } from "../../src/core";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { costOf } from "../../src/core/cost/price";
import type { Language } from "../../src/core/language";
import { catalogModel } from "../../src/core/providers/catalog";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, readMind, writeMind } from "../helpers/minds";
import { transcribingCore } from "../helpers/transcription";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const PICKED = process.env.INCARNAMIND_LIVE_CALLS?.split(",").map((each) => each.trim());

interface Fact {
  name: string;
  kind: "decision" | "action" | "figure";
  /**
   * How it reads in the note, in the wordings a model may use: every one of them, so an action is
   * matched by what is done together with its date or person, not by a mention of its topic.
   */
  pattern: RegExp | RegExp[];
  /** The turns that say it, counted from 0: a Citation of any of them is right. */
  said: number[];
}

interface Call {
  id: string;
  language: Language;
  notes: JSONContent[];
  turns: { side: "me" | "them"; text: string }[];
  facts: Fact[];
}

const me = (text: string) => ({ side: "me" as const, text });
const them = (text: string) => ({ side: "them" as const, text });

const CALLS: Call[] = [
  {
    id: "en-print",
    language: "en",
    notes: [note("print run cost"), note("delivery to Leeds")],
    turns: [
      me(
        "Thanks for making time, Odile. I want to settle the print order for the autumn catalogue.",
      ),
      them(
        "Of course. For twelve thousand copies our quote is nineteen thousand four hundred euros.",
      ),
      me(
        "That's more than the spring run. Can you match last spring's rate of one euro fifty a copy?",
      ),
      them(
        "I can do one euro fifty-five a copy on the matte stock, which makes eighteen thousand six hundred euros.",
      ),
      me("Fine, we'll go with the matte stock at one euro fifty-five a copy."),
      them("Good. We need the final files by the ninth of February."),
      me("And let's make the delivery date to our Leeds warehouse the second of March."),
      them(
        "The second of March works. Each delivery over twenty pallets needs a dock booking at forty pounds.",
      ),
      me(
        "Understood. So: I send the final files by February ninth, you send the proof copies by February sixteenth, and Hamid books the dock slot at Leeds.",
      ),
      them("Agreed. Thanks, talk next week."),
    ],
    facts: [
      {
        name: "matte stock at €1.55 a copy, €18,600",
        kind: "decision",
        pattern: /18[,.\s]?600|1[.,]55|fifty-five/i,
        said: [3, 4],
      },
      {
        name: "delivery to Leeds on 2 March",
        kind: "decision",
        pattern: /\b(2|2nd|second)\s+(of\s+)?March|March\s+(2|2nd|second)\b/i,
        said: [6, 7],
      },
      {
        name: "dock booking £40",
        kind: "figure",
        pattern: /£\s?40\b|\b40\s*(pounds|GBP)|forty pounds/i,
        said: [7],
      },
      {
        name: "final files by 9 February",
        kind: "action",
        pattern: /\b(9|9th|ninth)\s+(of\s+)?February|February\s+(9|9th|ninth)\b/i,
        said: [5, 8],
      },
      {
        name: "proof copies by 16 February",
        kind: "action",
        pattern: [/proof/i, /\b16(th)?\b|sixteenth/i],
        said: [8],
      },
      { name: "Hamid books the dock slot", kind: "action", pattern: /Hamid/i, said: [8] },
    ],
  },
  {
    id: "en-move",
    language: "en",
    notes: [note("moving date"), note("costs")],
    turns: [
      me("Morning, Carla. I'd like to pin down the office move with your team."),
      them("Sure. We can move your forty-two desks over one weekend."),
      me("Which weekend works for you? We'd prefer the last weekend of April."),
      them("The twenty-fifth and twenty-sixth of April work, starting Saturday at seven."),
      me("Great, let's book that weekend."),
      them(
        "The move costs eleven thousand two hundred pounds, plus three hundred and fifty pounds for crate hire.",
      ),
      me("Can we drop the crate hire if we pack our own boxes?"),
      them("Yes, then it's just the eleven thousand two hundred."),
      me(
        "Okay. So Jonas labels every desk by April eighteenth, you send the floor plan by Wednesday, and I tell the landlord about the lift booking.",
      ),
      them("Sounds good. Bye for now."),
    ],
    facts: [
      {
        name: "the move on 25 and 26 April",
        kind: "decision",
        pattern: /\b25(th)?\b[^.]*April|April\s+25|twenty-fifth/i,
        said: [3, 4],
      },
      {
        name: "£11,200 for the move",
        kind: "figure",
        pattern: /11[,.\s]?200|eleven thousand two hundred|11\.2\s?k/i,
        said: [5, 7],
      },
      { name: "own boxes, no crate hire", kind: "decision", pattern: /crate/i, said: [5, 6, 7] },
      { name: "Jonas labels the desks", kind: "action", pattern: /Jonas/i, said: [8] },
      {
        name: "floor plan by Wednesday",
        kind: "action",
        pattern: [/floor plan/i, /Wednesday/i],
        said: [8],
      },
      {
        name: "landlord told of the lift booking",
        kind: "action",
        pattern: /landlord|\blift\b/i,
        said: [8],
      },
    ],
  },
  {
    id: "en-website",
    language: "en",
    notes: [note("scope and price"), note("launch"), heading(2, "Action items")],
    turns: [
      me("Hi Tomasz, thanks for joining. Let's agree the scope of the website redesign."),
      them(
        "Sure. We propose fourteen page templates and a new booking flow, for sixty-two thousand dollars.",
      ),
      me("We only need ten templates. What does that do to the price?"),
      them("With ten templates it comes to fifty-four thousand dollars, booking flow included."),
      me("Good, ten templates at fifty-four thousand dollars then."),
      them("After launch, our support retainer is nine hundred dollars a month."),
      me("Let's launch the new site on June first, before the summer bookings."),
      them("June first is tight but doable if we get your content by April tenth."),
      me(
        "Then here's what's next: Priya sends the brand guidelines on Monday, you send the revised statement of work by Thursday, and I get sign-off from our CFO, Malik, by the end of the month.",
      ),
      them("Perfect. Talk soon."),
    ],
    facts: [
      {
        name: "ten templates for $54,000",
        kind: "decision",
        pattern: /54[,.]?000|\b54\s?k\b|fifty-four thousand/i,
        said: [3, 4],
      },
      {
        name: "launch on 1 June",
        kind: "decision",
        pattern: /June\s+(1|1st|first)\b|\b(1|1st|first)\s+(of\s+)?June/i,
        said: [6, 7],
      },
      {
        name: "retainer $900 a month",
        kind: "figure",
        pattern: /\$\s?900\b|\b900\s*dollars|nine hundred/i,
        said: [5],
      },
      {
        name: "content by 10 April",
        kind: "action",
        pattern: /April\s+(10|10th|tenth)\b|\b(10|10th|tenth)\s+(of\s+)?April/i,
        said: [7],
      },
      {
        name: "Priya sends the brand guidelines",
        kind: "action",
        pattern: [/brand guidelines/i, /Priya|Monday/i],
        said: [8],
      },
      {
        name: "revised statement of work by Thursday",
        kind: "action",
        pattern: [/statement of work|\bSOW\b/i, /Thursday/i],
        said: [8],
      },
      { name: "sign-off from Malik", kind: "action", pattern: /Malik|\bCFO\b/i, said: [8] },
    ],
  },
  {
    id: "zh-venue",
    language: "zh-CN",
    notes: [note("场地费"), note("餐饮")],
    turns: [
      me("刘经理你好，我是远帆科技的周敏，今天想把年会场地定下来。"),
      them("周经理好，我们宴会厅一天的场地费是三万八千元，可以坐三百人。"),
      me("我们去年在别家只花了三万二，能不能便宜一点？"),
      them("如果你们本月底前付定金，场地费可以按三万五千元算。"),
      me("可以，那就按三万五千元定下来，年会日期定在一月十六日。"),
      them("好的。餐饮是每桌两千六百元，一共三十桌。"),
      me("投影和音响要另外收费吗？"),
      them("音响免费，投影设备每天另收一千二百元。"),
      me("明白。接下来：我这周五前把定金打过去，你们下周一前把合同发给我们，王磊负责确认菜单。"),
      them("没问题，周经理，再见。"),
    ],
    facts: [
      {
        name: "场地费三万五千元",
        kind: "decision",
        pattern: /3\.5\s*万|35[,，]?000|三万五/,
        said: [3, 4],
      },
      { name: "年会在一月十六日", kind: "decision", pattern: /1\s*月\s*16|一月十六/, said: [4] },
      { name: "每桌两千六百元", kind: "figure", pattern: /2[,，]?600|两千六|2\.6\s*千/, said: [5] },
      { name: "投影每天一千二百元", kind: "figure", pattern: /1[,，]?200|一千二/, said: [7] },
      { name: "周五前打定金", kind: "action", pattern: [/定金/, /周五/], said: [8] },
      { name: "下周一前发合同", kind: "action", pattern: [/合同/, /周一/], said: [8] },
      { name: "王磊确认菜单", kind: "action", pattern: /王磊/, said: [8] },
    ],
  },
  {
    id: "zh-supply",
    language: "zh-CN",
    notes: [note("价格"), note("交货"), heading(2, "待办")],
    turns: [
      me("赵总好，今天主要谈明年的铝材供货合同。"),
      them("好的。明年铝材的价格是每吨一万九千八百元，年供应量两千吨。"),
      me("价格比今年高了不少，能不能锁定在每吨一万九千元？"),
      them("如果签三年合同，可以锁定在每吨一万九千二百元。"),
      me("行，那就签三年，每吨一万九千二百元。"),
      them("交货方面，每批货从下单到交货需要十二天。"),
      me("我们希望第一批货在三月五日前到苏州工厂。"),
      them("三月五日可以。另外，质检不合格的批次，我们按货值的百分之三赔付。"),
      me(
        "好。那待办就是：你们下周三前把合同草稿发过来，我请法务陈静审合同，我们采购部月底前下第一批订单。",
      ),
      them("没问题，再见。"),
    ],
    facts: [
      {
        name: "签三年，每吨一万九千二百元",
        kind: "decision",
        pattern: /1\.92\s*万|19[,，]?200|一万九千二/,
        said: [3, 4],
      },
      { name: "交货需要十二天", kind: "figure", pattern: /12\s*天|十二天/, said: [5] },
      { name: "首批三月五日到苏州", kind: "decision", pattern: /3\s*月\s*5|三月五/, said: [6, 7] },
      { name: "质检不合格赔付百分之三", kind: "figure", pattern: /3\s*[%％]|百分之三/, said: [7] },
      { name: "下周三前发合同草稿", kind: "action", pattern: [/草稿/, /周三/], said: [8] },
      { name: "陈静审合同", kind: "action", pattern: /陈静/, said: [8] },
      { name: "月底前下第一批订单", kind: "action", pattern: [/订单/, /月底/], said: [8] },
    ],
  },
  // The walk that found #2306: its script and its two typed lines.
  {
    id: "walk-en",
    language: "en",
    notes: [note("Push back on the price jump"), note("Rotterdam capacity")],
    turns: [
      me(
        "Hi Marcus, thanks for joining. This is Priya Raman from Lumen Foods. I want to go over the Harbor Logistics renewal today.",
      ),
      them(
        "Hi Priya, happy to. Our proposal for next year is forty-eight thousand five hundred dollars a year, for three hundred and forty seats.",
      ),
      me(
        "Last year we paid forty-two thousand dollars. That is a big jump. Can you do a twelve percent discount if we sign for two years?",
      ),
      them(
        "I can offer ten percent on a two-year term. So the annual price would be forty-three thousand six hundred and fifty dollars.",
      ),
      me(
        "Okay. The other topic is the Rotterdam warehouse. We need it to handle two point five million units by the end of the second quarter.",
      ),
      them(
        "Rotterdam can handle that. Our operations lead, Sofia Lindqvist, will send you a capacity plan by Friday, November sixth.",
      ),
      me(
        "Great. What about late deliveries? In September we had seventeen late shipments out of nine hundred.",
      ),
      them(
        "That was a carrier problem. We have switched carriers, and our on-time rate in October was ninety-eight point four percent.",
      ),
      me(
        "Good. Then let's set the go-live date for the new contract to March fourteenth, twenty twenty-seven.",
      ),
      them(
        "March fourteenth works. I will send the revised contract to you and to your finance director, Daniel Weiss, by next Wednesday.",
      ),
      me("One more question. Is customs clearance included in the price?"),
      them(
        "Customs clearance is included for the European Union. For the United Kingdom there is an extra fee of eighty-five dollars per shipment.",
      ),
      me(
        "Understood. So the action items are: Sofia sends the capacity plan by November sixth, you send the contract by Wednesday, and I confirm the two-year term with Daniel.",
      ),
      them("That's right. Thanks Priya, talk soon."),
    ],
    facts: [
      {
        name: "go-live on 14 March 2027",
        kind: "decision",
        pattern: /March\s+(14|14th|fourteenth)\b|\b(14|14th|fourteenth)\s+(of\s+)?March/i,
        said: [8, 9],
      },
      {
        name: "UK fee of $85 a shipment",
        kind: "figure",
        pattern: /\$\s?85\b|\b85\s*dollars|eighty-five/i,
        said: [11],
      },
      {
        name: "Sofia sends the capacity plan by 6 November",
        kind: "action",
        pattern: [/capacity plan/i, /\b6(th)?\b|sixth/i],
        said: [5, 12],
      },
      {
        name: "revised contract by Wednesday",
        kind: "action",
        pattern: [/contract/i, /Wednesday/i],
        said: [9, 12],
      },
      {
        name: "the two-year term confirmed with Daniel",
        kind: "action",
        pattern: [/Daniel/i, /two-year|2-year|two years/i],
        said: [12],
      },
      {
        name: "$43,650 a year on a two-year term",
        kind: "figure",
        pattern: /43[,.]?650|forty-three thousand six hundred/i,
        said: [3],
      },
      { name: "on-time rate of 98.4%", kind: "figure", pattern: /98[.,]4/, said: [7] },
    ],
  },
  {
    id: "walk-zh",
    language: "zh-CN",
    notes: [note("报价"), note("会议室")],
    turns: [
      me("陈经理你好，我是星河科技的王丽。今天想确认一下新办公室的装修方案。"),
      them("王总你好。我们的报价是八十六万元，工期四十五天。"),
      me("我们的预算只有七十五万。能不能降到七十八万？"),
      them("如果材料换成国产品牌，可以做到七十九万五千元。"),
      me("好的。开工日期定在十一月十八日，可以吗？"),
      them("可以。我们的项目经理李明，会在下周三之前把施工图发给你。"),
      me("还有，会议室需要能坐二十四个人。"),
      them("没问题。会议室面积是六十平方米，坐二十四个人足够。"),
      me("那就这样。我下周一把盖章的合同寄给你们。"),
      them("好的，谢谢王总，再见。"),
    ],
    facts: [
      {
        name: "换国产品牌做到七十九万五千元",
        kind: "figure",
        pattern: /79\.5\s*万|79[,，]?5000|七十九万五/,
        said: [3],
      },
      {
        name: "十一月十八日开工",
        kind: "decision",
        pattern: /11\s*月\s*18|十一月十八/,
        said: [4, 5],
      },
      { name: "李明下周三前发施工图", kind: "action", pattern: [/施工图/, /周三/], said: [5] },
      { name: "下周一寄盖章的合同", kind: "action", pattern: [/合同/, /周一/], said: [8] },
      {
        name: "会议室六十平方米",
        kind: "figure",
        pattern: /60\s*(平方米|平米|㎡)|六十平/,
        said: [7],
      },
      { name: "工期四十五天", kind: "figure", pattern: /45\s*天|四十五天/, said: [1] },
    ],
  },
  {
    id: "en-offer",
    language: "en",
    notes: [note("salary"), note("start date"), heading(2, "Next steps")],
    turns: [
      me("Hi Dana, thanks for calling back about the data analyst offer."),
      them("Happy to. Ravi was hoping for seventy-eight thousand pounds."),
      me(
        "Our band tops out at seventy-two thousand, but we can add a signing bonus of four thousand.",
      ),
      them(
        "He'd accept seventy-two thousand with the four thousand bonus if he gets two days a week from home.",
      ),
      me("Two days from home is fine. Let's agree seventy-two plus the bonus."),
      them("Great. He can start on the third of August after his notice period."),
      me("August third works for us."),
      them("His current employer wants a reference from your side by the fifteenth of July."),
      me(
        "Okay, next steps: I'll send the written offer by Friday, you get Ravi's signed acceptance by July tenth, and Helen in HR sends the reference by July fifteenth.",
      ),
      them("Perfect, speak soon."),
    ],
    facts: [
      {
        name: "£72,000 salary",
        kind: "decision",
        pattern: /72[,.]?000|seventy-two thousand|\b72\s?k\b/i,
        said: [2, 3, 4],
      },
      {
        name: "£4,000 signing bonus",
        kind: "figure",
        pattern: /\b4[,.]?000\b|four thousand|\b4\s?k\b/i,
        said: [2, 3, 4],
      },
      {
        name: "two days a week from home",
        kind: "decision",
        pattern: /two days|2 days/i,
        said: [3, 4],
      },
      {
        name: "start on 3 August",
        kind: "decision",
        pattern: /August\s+(3|3rd|third)\b|\b(3|3rd|third)\s+(of\s+)?August/i,
        said: [5, 6],
      },
      {
        name: "written offer by Friday",
        kind: "action",
        pattern: [/offer/i, /Friday/i],
        said: [8],
      },
      {
        name: "signed acceptance by 10 July",
        kind: "action",
        pattern: [/accept/i, /July\s+(10|10th|tenth)\b|\b(10|10th|tenth)\s+(of\s+)?July/i],
        said: [8],
      },
      { name: "Helen sends the reference", kind: "action", pattern: /Helen/i, said: [7, 8] },
    ],
  },
  {
    id: "zh-talk",
    language: "zh-CN",
    notes: [note("预算"), note("嘉宾"), heading(2, "下一步")],
    turns: [
      me("孙老师你好，我是青禾教育的林悦，想跟你确认下个月的家长讲座。"),
      them("林老师好。讲座的报酬我们一般是每场八千元。"),
      me("我们的预算是六千，能不能按六千五算？"),
      them("六千五可以，但交通和住宿需要你们承担。"),
      me("没问题，就按六千五，交通住宿我们来订。讲座定在十二月七日下午两点。"),
      them("十二月七日下午可以。另外，我会请华东师大的周教授一起做问答环节。"),
      me("太好了。会场大概能坐一百二十位家长。"),
      them("那我需要一个无线话筒和一台投影仪。"),
      me(
        "好。下一步：我周三前把邀请函发给你，你下周五前把讲座提纲发过来，行政部的小郑负责订高铁票和酒店。",
      ),
      them("好的，到时候见。"),
    ],
    facts: [
      {
        name: "报酬六千五百元",
        kind: "decision",
        pattern: /6[,，]?500|六千五|6\.5\s*千/,
        said: [3, 4],
      },
      { name: "交通住宿由我们承担", kind: "decision", pattern: /交通/, said: [3, 4] },
      {
        name: "十二月七日下午两点",
        kind: "decision",
        pattern: /12\s*月\s*7|十二月七/,
        said: [4, 5],
      },
      { name: "会场坐一百二十位家长", kind: "figure", pattern: /120|一百二十/, said: [6] },
      { name: "周三前发邀请函", kind: "action", pattern: [/邀请函/, /周三/], said: [8] },
      { name: "下周五前发提纲", kind: "action", pattern: [/提纲/, /周五/], said: [8] },
      { name: "小郑订高铁票和酒店", kind: "action", pattern: /小郑/, said: [8] },
    ],
  },
  // Written after the prompt was settled on the calls above, and never shown to it before.
  {
    id: "held-en-lease",
    language: "en",
    notes: [note("mileage limit"), note("insurance")],
    turns: [
      me("Hi Gwen, thanks for taking the call about our van lease renewal."),
      them(
        "Of course. For the twelve vans, the new rate is six hundred and ten dollars per van per month.",
      ),
      me(
        "That's up from five hundred and eighty. Can we keep five ninety if we extend to four years?",
      ),
      them("On a four-year term I can do five ninety-five per van."),
      me("Five ninety-five on four years works. What's the mileage limit?"),
      them("Twenty-five thousand miles a year per van, and nineteen cents a mile over that."),
      me("And is insurance still bundled?"),
      them(
        "Insurance stays bundled, but the excess goes up to one thousand two hundred dollars per claim.",
      ),
      me("Alright. The new lease starts on September first."),
      them("September first is fine. I'll email the renewal paperwork by Tuesday."),
      me(
        "Thanks. So Gwen sends the paperwork by Tuesday, Omar returns the two damaged vans by August twentieth, and I sign the renewal by August twenty-fifth.",
      ),
      them("Perfect, bye."),
    ],
    facts: [
      {
        name: "$595 a van on a four-year term",
        kind: "decision",
        pattern: /595|five ninety-five|five hundred and ninety-five/i,
        said: [3, 4],
      },
      {
        name: "25,000 miles a year",
        kind: "figure",
        pattern: /25[,.]?000|twenty-five thousand/i,
        said: [5],
      },
      {
        name: "19 cents a mile over",
        kind: "figure",
        pattern: /\b19\s*cents|nineteen cents|\$0?\.19/i,
        said: [5],
      },
      {
        name: "$1,200 excess a claim",
        kind: "figure",
        pattern: /1[,.]?200|twelve hundred|one thousand two hundred/i,
        said: [7],
      },
      {
        name: "lease starts 1 September",
        kind: "decision",
        pattern: /September\s+(1|1st|first)\b|\b(1|1st|first)\s+(of\s+)?September/i,
        said: [8, 9],
      },
      {
        name: "Gwen sends the paperwork by Tuesday",
        kind: "action",
        pattern: [/paperwork/i, /Tuesday/i],
        said: [9, 10],
      },
      { name: "Omar returns the damaged vans", kind: "action", pattern: /Omar/i, said: [10] },
      {
        name: "renewal signed by 25 August",
        kind: "action",
        pattern: [
          /sign/i,
          /August\s+(25|25th|twenty-fifth)\b|\b(25|25th|twenty-fifth)\s+(of\s+)?August/i,
        ],
        said: [10],
      },
    ],
  },
  {
    id: "held-en-meetup",
    language: "en",
    notes: [note("venue"), note("speakers"), heading(2, "To do")],
    turns: [
      me("Hi Leo, let's lock in the details for the analytics meetup."),
      them(
        "Sure. The hall at Dockside holds a hundred and eighty people and costs two thousand four hundred euros for the evening.",
      ),
      me("Can we get it for two thousand if we skip their catering?"),
      them("Without catering it's two thousand one hundred euros."),
      me("Two thousand one hundred it is. We'll bring in our own food truck."),
      them("The date is still Thursday the twelfth of November?"),
      me("Yes, the twelfth of November, doors at six thirty."),
      them(
        "For speakers, Amara confirmed, and Felix needs his travel covered, about three hundred and forty euros.",
      ),
      me("Let's cover Felix's travel."),
      them("Good. I'll send the hall contract by Monday."),
      me(
        "Great. To do: you send the hall contract by Monday, I book the food truck by October thirtieth, and Nadia opens registration next week.",
      ),
      them("Sounds good. Bye."),
    ],
    facts: [
      {
        name: "the hall for €2,100 without catering",
        kind: "decision",
        pattern: /2[,.]?100|two thousand one hundred/i,
        said: [3, 4],
      },
      {
        name: "the hall holds 180",
        kind: "figure",
        pattern: /\b180\b|hundred and eighty/i,
        said: [1],
      },
      {
        name: "12 November",
        kind: "decision",
        pattern: /November\s+(12|12th|twelfth)\b|\b(12|12th|twelfth)\s+(of\s+)?November/i,
        said: [5, 6],
      },
      {
        name: "Felix's travel covered, about €340",
        kind: "decision",
        pattern: /340|three hundred and forty/i,
        said: [7, 8],
      },
      {
        name: "hall contract by Monday",
        kind: "action",
        pattern: [/contract/i, /Monday/i],
        said: [9, 10],
      },
      {
        name: "food truck booked by 30 October",
        kind: "action",
        pattern: [
          /food truck/i,
          /October\s+(30|30th|thirtieth)\b|\b(30|30th|thirtieth)\s+(of\s+)?October/i,
        ],
        said: [10],
      },
      { name: "Nadia opens registration", kind: "action", pattern: /Nadia/i, said: [10] },
    ],
  },
  {
    id: "held-zh-property",
    language: "zh-CN",
    notes: [note("物业费"), note("停车位")],
    turns: [
      me("钱经理你好，我是启明设计的高远，想谈一下明年的物业合同续签。"),
      them("高总好。明年物业费是每平方米每月九块八，比今年涨了八毛。"),
      me("涨得有点多。我们续签两年，能不能按九块二算？"),
      them("续签两年的话，可以按九块五。"),
      me("行，就按九块五，签两年。"),
      them("停车位方面，月租车位每个七百元，你们现在租了十五个。"),
      me("明年我们要多租五个，一共二十个。"),
      them("可以，但新增的五个要等三月一日以后才有。"),
      me(
        "好。那这样：你们下周二前把续签合同发给我，我们财务部张丽这个月二十五号前付押金，我下周去看一下新车位。",
      ),
      them("好的，高总，回头见。"),
    ],
    facts: [
      {
        name: "物业费按九块五签两年",
        kind: "decision",
        pattern: /9\.5\s*元|九块五|9\.50|九元五/,
        said: [3, 4],
      },
      { name: "车位每个七百元", kind: "figure", pattern: /700|七百/, said: [5] },
      { name: "车位一共二十个", kind: "decision", pattern: /二十个|20\s*个/, said: [6] },
      {
        name: "新增车位三月一日以后",
        kind: "decision",
        pattern: /3\s*月\s*1\s*日|三月一日/,
        said: [7],
      },
      { name: "下周二前发续签合同", kind: "action", pattern: [/合同/, /周二/], said: [8] },
      { name: "张丽二十五号前付押金", kind: "action", pattern: /张丽/, said: [8] },
      { name: "下周去看新车位", kind: "action", pattern: [/看/, /车位/], said: [8] },
    ],
  },
  {
    id: "held-zh-training",
    language: "zh-CN",
    notes: [note("价格"), note("排期"), heading(2, "待办事项")],
    turns: [
      me("吴老师你好，我是恒信财务的许晴，想定一下给我们团队的 Excel 培训。"),
      them("许经理好。两天的课程，三十人以内是两万四千元。"),
      me("我们有三十六个人，价格怎么算？"),
      them("超过三十人，每多一个人加六百元，三十六人就是两万七千六百元。"),
      me("能不能打个九折？"),
      them("九折可以，就是两万四千八百四十元。"),
      me("好，就按这个价格。培训安排在十一月二十日和二十一日。"),
      them("这两天可以。教室需要有投影和每人一台电脑。"),
      me(
        "没问题。待办：你这周四前把课程大纲发给我，我请行政部刘洋准备电脑，我们财务下周一付百分之三十的预付款。",
      ),
      them("好的，许经理再见。"),
    ],
    facts: [
      {
        name: "九折后两万四千八百四十元",
        kind: "decision",
        pattern: /24[,，]?840|两万四千八百四十|2\.484\s*万/,
        said: [5, 6],
      },
      { name: "每多一人加六百元", kind: "figure", pattern: /600|六百/, said: [3] },
      {
        name: "十一月二十日和二十一日",
        kind: "decision",
        pattern: /11\s*月\s*20|十一月二十/,
        said: [6, 7],
      },
      { name: "周四前发课程大纲", kind: "action", pattern: [/大纲/, /周四/], said: [8] },
      { name: "刘洋准备电脑", kind: "action", pattern: /刘洋/, said: [8] },
      {
        name: "下周一付百分之三十的预付款",
        kind: "action",
        pattern: [/预付/, /30\s*[%％]|百分之三十/],
        said: [8],
      },
    ],
  },
];

interface Usage {
  /** Each request's reply: its text, how much it reasoned, and the Tools it called. */
  replies: { text: string; reasoning: number; tools: string[]; output: number }[];
  calls: number;
  input: number;
  cached: number;
  written: number;
  output: number;
  dollars: number;
}

/** Real Anthropic models, each request's tokens counted and priced at its prompt's tier. */
function countedModels(usage: Usage) {
  const price = catalogModel("anthropic", MODEL)?.price;
  if (!price) throw new Error(`The catalog has no price for ${MODEL}.`);
  const add = (counted: {
    inputTokens: { total?: number; cacheRead?: number; cacheWrite?: number };
    outputTokens: { total?: number; reasoning?: number };
  }) => {
    const tokens = {
      inputTokens: counted.inputTokens.total ?? 0,
      cachedInputTokens: counted.inputTokens.cacheRead ?? 0,
      cacheWriteTokens: counted.inputTokens.cacheWrite ?? 0,
      outputTokens: counted.outputTokens.total ?? 0,
    };
    usage.calls++;
    usage.input += tokens.inputTokens;
    usage.cached += tokens.cachedInputTokens;
    usage.written += tokens.cacheWriteTokens;
    usage.output += tokens.outputTokens;
    usage.dollars += costOf(tokens, price, new Date(), { cacheWrites: true });
  };
  return (spec: Parameters<typeof createAiSdkChatModel>[0]) =>
    wrapLanguageModel({
      model: createAiSdkChatModel(spec),
      middleware: {
        specificationVersion: "v4",
        wrapStream: async ({ doStream }) => {
          const result = await doStream();
          const reply = { text: "", reasoning: 0, tools: [] as string[], output: 0 };
          const stream = result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                if (part.type === "text-delta") reply.text += part.delta;
                if (part.type === "tool-call") reply.tools.push(part.toolName);
                if (part.type === "finish") {
                  add(part.usage);
                  reply.reasoning = part.usage.outputTokens.reasoning ?? 0;
                  reply.output = part.usage.outputTokens.total ?? 0;
                  usage.replies.push(reply);
                }
                controller.enqueue(part);
              },
            }),
          );
          return { ...result, stream };
        },
        wrapGenerate: async ({ doGenerate }) => {
          const result = await doGenerate();
          add(result.usage);
          return result;
        },
      },
    });
}

/** A part of the note a fact can be in: a paragraph, or a list's item. */
interface Unit {
  text: string;
  ai: boolean;
  section: string | null;
  citations: { quote: string; speaker: string | null; check: string }[];
}

function unitsOf(doc: ProseMirrorNode): Unit[] {
  const units: Unit[] = [];
  let section: string | null = null;
  const unit = (node: ProseMirrorNode) => {
    let ai = false;
    const citations: Unit["citations"] = [];
    node.descendants((inside) => {
      if (inside.isText && inside.marks.some((mark) => mark.type.name === GENERATED_MARK)) {
        ai = true;
      }
      if (inside.type.name === CITATION_NODE) {
        const location = inside.attrs.location as { kind?: string; speaker?: string } | null;
        citations.push({
          quote: String(inside.attrs.quote ?? ""),
          speaker: location?.kind === "time" ? (location.speaker ?? null) : null,
          check: String(inside.attrs.check ?? ""),
        });
      }
      return true;
    });
    units.push({ text: node.textContent, ai, section, citations });
  };
  doc.forEach((block) => {
    if (block.type.name === "heading") {
      section = block.textContent;
      return;
    }
    if (block.type.name === "bulletList" || block.type.name === "orderedList") {
      block.forEach(unit);
    } else unit(block);
  });
  return units;
}

const says = (fact: Fact, text: string) =>
  (Array.isArray(fact.pattern) ? fact.pattern : [fact.pattern]).every((each) => each.test(text));

const plain = (text: string) =>
  text
    .replace(/\[[^\]]*\]/g, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

const SPEAKERS = { me: ["me", "我"], them: ["them", "对方"] } as const;

/** A Citation of a turn that says the fact, found in the Transcript, with that turn's speaker. */
function citesRightly(unit: Unit, fact: Fact, call: Call): boolean {
  return unit.citations.some((citation) => {
    if (citation.check !== "found") return false;
    const quote = plain(citation.quote);
    return fact.said.some((index) => {
      const turn = call.turns[index];
      if (!turn || quote === "") return false;
      const line = plain(turn.text);
      const speaker = citation.speaker?.toLowerCase() ?? "";
      const said = line.includes(quote) || quote.includes(line);
      return said && SPEAKERS[turn.side].some((each) => each === speaker);
    });
  });
}

async function settled(core: Core, meeting: Meeting): Promise<MeetingFill> {
  return vi.waitFor(
    async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling") {
        throw new Error(`Not yet: ${JSON.stringify(fill)}`);
      }
      return fill;
    },
    { timeout: 600_000, interval: 500 },
  );
}

async function run(call: Call) {
  const usage: Usage = {
    replies: [],
    calls: 0,
    input: 0,
    cached: 0,
    written: 0,
    output: 0,
    dollars: 0,
  };
  const dataDir = await createTempDataFolder();
  // The first line of each side goes with the moment both sources start, so they share a clock.
  const { core, record } = await transcribingCore(dataDir, {
    engine: {
      lines: ["", ...call.turns.filter((turn) => turn.side === "me").map((turn) => turn.text)],
      theirLines: [
        "",
        ...call.turns.filter((turn) => turn.side === "them").map((turn) => turn.text),
      ],
    },
    createChatModel: countedModels(usage),
  });
  await core.updateSettings({ user: { language: call.language } });
  await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
  const meeting = await core.createMeeting();
  const client = await connectToMind(core, meeting.mindId);
  writeMind(client, call.notes);
  await client.settled();
  const typed = unitsOf(readMind(client)).map((each) => each.text);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(20);
  for (const turn of call.turns) {
    record(2_000, [turn.side === "me" ? "microphone" : "system"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await core.stopMeeting(meeting.id);
  const fill = await settled(core, meeting);
  if (fill.state === "filled") {
    await vi.waitFor(() => expect(unitsOf(readMind(client)).some((each) => each.ai)).toBe(true), {
      timeout: 10_000,
    });
  }
  const doc = readMind(client);
  const units = unitsOf(doc);
  const claimsTitles = (["en", "zh-CN"] as const).map((language) =>
    translate(language, "meetings.fill.section.claims"),
  );
  const outside = units.filter((each) => each.ai && !claimsTitles.includes(each.section ?? ""));
  const inClaims = units.filter((each) => each.ai && claimsTitles.includes(each.section ?? ""));
  const scored = call.facts.map((fact) => {
    const found = outside.filter((each) => says(fact, each.text));
    return {
      fact,
      count: found.length,
      inClaims: inClaims.filter((each) => says(fact, each.text)).length,
      cited: found.length > 0 && found.every((each) => citesRightly(each, fact, call)),
    };
  });
  const uncited = units.filter((each) => each.ai && each.citations.length === 0).length;
  const transcript = (await core.listMeetings()).find((each) => each.id === meeting.id)?.transcript;
  core.close();
  return { fill, doc, typed, units, scored, uncited, usage, transcript };
}

const shownNote = (doc: ProseMirrorNode) => {
  const lines: string[] = [];
  doc.forEach((block) => {
    const ai = (node: ProseMirrorNode) => {
      let text = "";
      node.descendants((inside) => {
        if (inside.isText) {
          const generated = inside.marks.some((mark) => mark.type.name === GENERATED_MARK);
          text += generated ? `«${inside.text}»` : (inside.text ?? "");
        } else if (inside.type.name === CITATION_NODE) {
          const location = inside.attrs.location as { from?: number; speaker?: string } | null;
          const at = location?.from ?? 0;
          text += ` [${Math.floor(at / 60_000)}:${String(Math.floor((at % 60_000) / 1000)).padStart(2, "0")} ${location?.speaker ?? "?"}]`;
        }
        return true;
      });
      return text;
    };
    if (block.type.name === "heading") lines.push(`## ${ai(block)}`);
    else if (block.type.name === "bulletList" || block.type.name === "orderedList") {
      block.forEach((item) => {
        lines.push(`- ${ai(item)}`);
      });
    } else lines.push(ai(block));
  });
  return lines.join("\n");
};

const chosen = CALLS.filter((call) => !PICKED || PICKED.includes(call.id));

describe.skipIf(!KEY)(
  "Notes typed in a call, filled in on a real model (#2306)",
  {
    timeout: 900_000,
  },
  () => {
    test.each(chosen)("$id", async (call) => {
      const { fill, doc, typed, units, scored, uncited, usage } = await run(call);
      const once = scored.filter((each) => each.count === 1 && each.cited).length;
      if (REPORT) {
        const rows = scored
          .map(
            ({ fact, count, inClaims, cited }) =>
              `| ${fact.kind} | ${fact.name} | ${count} | ${cited ? "yes" : "no"} | ${inClaims} |`,
          )
          .join("\n");
        await appendFile(
          REPORT,
          [
            `## ${call.id} · ${MODEL}`,
            "",
            `Once and cited rightly: ${once} of ${call.facts.length}. AI parts without a Citation: ${uncited}. Fill: ${fill.state}${fill.problem ? ` (${fill.problem.message})` : ""}.`,
            `Tokens: ${usage.calls} requests, ${usage.input} in (${usage.cached} cached, ${usage.written} written to the cache), ${usage.output} out: $${usage.dollars.toFixed(4)}.`,
            "",
            "| Kind | Fact | Times in the note | Cited rightly | In the claims list |",
            "|---|---|---|---|---|",
            rows,
            "",
            "```",
            shownNote(doc),
            "```",
            "",
            ...(fill.state === "filled"
              ? []
              : usage.replies.flatMap((reply, index) => [
                  `Reply ${index + 1}: ${reply.output} tokens out, ${reply.reasoning} reasoning, Tools: ${reply.tools.join(", ") || "none"}.`,
                  "```",
                  reply.text.slice(0, 3000),
                  "```",
                  "",
                ])),
          ].join("\n"),
        );
      }
      expect(fill.state).toBe("filled");
      // The User's own lines, as typed, in their order.
      expect(units.filter((each) => !each.ai).map((each) => each.text)).toEqual(typed);
      expect(scored.filter((each) => each.count === 0).map((each) => each.fact.name)).toEqual([]);
    });
  },
);
