/**
 * After a call the User typed notes in, the notes filled in on a real model (#2306): each line
 * filled out in place, then the sections the notes don't cover. Held-out calls in English and
 * Chinese, written for this test and heard through the fake capture and transcriber (no
 * microphone). For each call it counts the decisions, action items and figures that appear once
 * in the note, "Said in the call, not in your Documents" included (a fact the Documents don't
 * back moves there whole), each cited to a transcript line that says it with that line's speaker;
 * the note's structure (#2306); and the tokens, the claim checks and what they cost. The counts, notes and costs go to INCARNAMIND_LIVE_REPORT when set.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku
 * 5.5 by default; INCARNAMIND_LIVE_CALLS picks calls by id, comma-separated), or with
 * INCARNAMIND_LIVE_DEEPSEEK_KEY and INCARNAMIND_LIVE_DEEPSEEK_MODEL=deepseek-flash in strict mode,
 * or INCARNAMIND_LIVE_OLLAMA_MODEL for a Local-mode check with an 8,192-token window.
 * INCARNAMIND_LIVE_USER_NAME sets the User's name in Settings › General, and nothing else: their
 * own actions are then scored by that name, and no request may hold it (#2306).
 */
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import { evalOllamaModels } from "../../eval/lib/citations";
import type { Core, Meeting, MeetingFill } from "../../src/core";
import { CITATION_NODE, GENERATED_MARK } from "../../src/core/api";
import { type Cue, readVtt } from "../../src/core/documents/formats/vtt";
import type { Language } from "../../src/core/language";
import { textWithUserName } from "../../src/core/meetings/userName";
import { catalogModel } from "../../src/core/providers/catalog";
import * as chatModels from "../../src/core/providers/models";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { checkStructuredMeetingLoader } from "../helpers/meetingFillLoader";
import {
  createRequestLedger,
  meetingFillCloud,
  startObservation,
  structuredControls,
  type V5Check,
} from "../helpers/meetingFillObservation";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, readMind, writeMind } from "../helpers/minds";
import { transcribingCore } from "../helpers/transcription";

const LOADER_PREFLIGHT = process.env.INCARNAMIND_STRUCTURED_LOADER_PREFLIGHT === "1";
const CLOUD = meetingFillCloud(process.env);
const KEY = CLOUD.key;
const LOCAL_MODEL = process.env.INCARNAMIND_LIVE_OLLAMA_MODEL;
const MODEL = LOCAL_MODEL ?? CLOUD.model ?? "claude-haiku-5-5";
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const PICKED = process.env.INCARNAMIND_LIVE_CALLS?.split(",").map((each) => each.trim());
const USER_NAME = process.env.INCARNAMIND_LIVE_USER_NAME?.trim() || null;
if (
  LOADER_PREFLIGHT &&
  [
    KEY,
    process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL,
    process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY,
    process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL,
    LOCAL_MODEL,
    process.env.INCARNAMIND_STRUCTURED_RECEIPT,
  ].some((value) => value !== undefined)
)
  throw new Error("Keyless structured loader preflight cannot use paid observation controls.");
const STRUCTURED = structuredControls(process.env);

interface Fact {
  name: string;
  kind: "decision" | "action" | "figure";
  /**
   * How it reads in the note, in the wordings a model may use: every one of them, so an action is
   * matched by what is done together with its date or person, not by a mention of its topic.
   */
  pattern: RegExp | RegExp[];
  subject?: RegExp | RegExp[];
  /** The turns that say it, counted from 0: a Citation of any of them is right. */
  said: number[];
  underLine?: string;
  /** A figure one side only stated: never a decision (#2306). */
  stated?: boolean;
  /** A term one side gave and the other accepted aloud: a decision, as its Decisions line states it (#2306). */
  accepted?: RegExp;
  /** Who it belongs to, as the notes must name them, and the ways they mustn't (#2306). */
  owner?: RegExp;
  forbid?: RegExp;
  /** A name the transcript misheard: wrong even beside the right first name (#2306). */
  misheard?: RegExp;
  /** Said by someone unnamed: the name of another person on their side must not be put on it (#2306). */
  notBy?: RegExp;
}

interface Call {
  id: string;
  language: Language;
  notes: JSONContent[];
  turns: { side: "me" | "them"; text: string }[];
  facts: Fact[];
  microphoneOnly?: boolean;
  requireSections?: boolean;
  openQuestions?: boolean;
  notDecided?: RegExp[];
  sectionHeadings?: Partial<Record<"summary" | "decisions" | "actions" | "questions", string>>;
  /** The call's topics in its order, each a heading a sensible note would give it (#2306). */
  topics?: { name: string; pattern: RegExp }[];
  /** Documents in the Note's Folder, to check its claims against. */
  documents?: { name: string; text: string }[];
  /** By name: the facts the Documents don't hold, which the claims list holds, and those they do. */
  claims?: { listed: string[]; kept: string[] };
  /** The name set in Settings › General for this call. */
  userName?: string;
  /** What the notes must say with that name set: "our" kept, and "my" as the name's possessive. */
  named?: { kept: RegExp[]; possessive: RegExp[] };
}

const me = (text: string) => ({ side: "me" as const, text });
const them = (text: string) => ({ side: "them" as const, text });

const CALLS: Call[] = [
  {
    id: "sections-en-museum",
    language: "en",
    microphoneOnly: true,
    requireSections: true,
    openQuestions: true,
    notes: [note("Museum call with Nia and Ellis: agree the display opening and next steps.")],
    turns: [
      me("Nia here. We need to settle the museum display opening and share the work."),
      me(
        "Ellis speaking. Could we open on April the fourth? The lighting inspection is still pending.",
      ),
      me("Nia again. The inspection finishes on the eighth, so the fourth is out."),
      me("Ellis here. Then we agree to open on April the nineteenth. That is the decision."),
      me("Nia here. I will send the invitation draft by Wednesday."),
      me("Ellis here. I will book the lighting inspector tomorrow."),
      me("Nia again. Jo will deliver the display labels on Friday."),
      me("Ellis here. Whether we need an evening security guard is still open."),
    ],
    facts: [
      {
        name: "open on 19 April",
        kind: "decision",
        pattern: [/April/i, /19|nineteenth/i],
        subject: /open(?:ing)?/i,
        said: [3],
      },
      {
        name: "invitation draft by Wednesday",
        kind: "action",
        pattern: [/invitation/i, /Wednesday/i, /Nia/i],
        subject: /invitation/i,
        said: [4],
      },
      {
        name: "book the lighting inspector",
        kind: "action",
        pattern: [/book/i, /inspect/i, /Ellis/i, /tomorrow/i],
        subject: /light(?:ing)?|inspect/i,
        said: [5],
      },
      {
        name: "Jo delivers the labels on Friday",
        kind: "action",
        pattern: [/label/i, /Friday/i, /\bJo\b/i],
        subject: /label/i,
        said: [6],
      },
    ],
    notDecided: [/open(?: the display)? on April (?:the )?(?:4|fourth)\b/i],
  },
  {
    id: "sections-zh-museum",
    language: "zh-CN",
    microphoneOnly: true,
    requireSections: true,
    openQuestions: true,
    notes: [note("博物馆会议，和小倪、老易：定开幕日期，分好工。")],
    turns: [
      me("我是小倪，今天定展览开幕的日期，再分一下工。"),
      me("我是老易。四月四日能开幕吗？灯光验收还没结束。"),
      me("我是小倪。验收八号才结束，四号来不及。"),
      me("我是老易，那就定四月十九日开幕，这是我们的决定。"),
      me("我是小倪，我周三前发邀请函初稿。"),
      me("我是老易，我明天预约灯光验收人员。"),
      me("小倪再补充一下，小乔周五送展签。"),
      me("我是老易，晚上要不要增加保安，还没有定。"),
    ],
    facts: [
      {
        name: "四月十九日开幕",
        kind: "decision",
        pattern: [/4\s*月\s*19|四月十九|十九日/, /开幕/],
        subject: /开幕/,
        said: [3],
      },
      {
        name: "周三发邀请函初稿",
        kind: "action",
        pattern: [/邀请/, /周三/, /小倪/],
        subject: /邀请/,
        said: [4],
      },
      {
        name: "预约灯光验收人员",
        kind: "action",
        pattern: [/预约/, /验收/, /老易/, /明天/],
        subject: /灯光|验收/,
        said: [5],
      },
      {
        name: "小乔周五送展签",
        kind: "action",
        pattern: [/展签/, /周五/, /小乔/],
        subject: /展签/,
        said: [6],
      },
    ],
    notDecided: [/(?:定|选)(?:在)?(?:四月四日|4\s*月\s*4\s*日)开幕/],
  },
  {
    id: "sections-en-workshop",
    language: "en",
    requireSections: true,
    openQuestions: true,
    sectionHeadings: { actions: "Action items" },
    notes: [note("workshop venue"), heading(2, "Action items")],
    turns: [
      me("Let's choose the venue for the repair workshop."),
      them("The library room costs ninety pounds. The school room is free, but has no benches."),
      me("We choose the library room for ninety pounds. Let's go ahead with that."),
      them("Agreed. It has space for twelve people."),
      me("Ravi will send the sign-up form on Monday."),
      them("I will collect the spare tools on Tuesday."),
      me("Mina will print the safety sheets on Thursday."),
      them("We still need to decide whether to provide lunch."),
    ],
    facts: [
      {
        name: "library room for £90",
        kind: "decision",
        pattern: [/library/i, /90|ninety/i],
        subject: /library|venue/i,
        said: [1, 2],
      },
      {
        name: "Ravi sends the sign-up form on Monday",
        kind: "action",
        pattern: [/form/i, /Monday/i, /Ravi/i],
        subject: /form/i,
        said: [4],
      },
      {
        name: "collect spare tools on Tuesday",
        kind: "action",
        pattern: [/tools/i, /Tuesday/i, /Them|other side|other party/i],
        subject: /tools/i,
        said: [5],
      },
      {
        name: "Mina prints safety sheets on Thursday",
        kind: "action",
        pattern: [/safety/i, /Thursday/i, /Mina/i],
        subject: /safety/i,
        said: [6],
      },
    ],
    notDecided: [/school room/i, /provide lunch/i],
  },
  {
    id: "sections-zh-workshop",
    language: "zh-CN",
    requireSections: true,
    openQuestions: true,
    sectionHeadings: { actions: "待办" },
    notes: [note("维修课场地"), heading(2, "待办")],
    turns: [
      me("今天定维修课的场地。"),
      them("图书馆的教室要九百元，学校教室免费，但是没有工作台。"),
      me("那就选图书馆的教室，九百元，就这么定了。"),
      them("同意，能坐十二个人。"),
      me("小罗周一发报名表。"),
      them("我周二去取备用工具。"),
      me("小米周四印安全说明。"),
      them("要不要准备午饭，还没有定。"),
    ],
    facts: [
      {
        name: "图书馆教室九百元",
        kind: "decision",
        pattern: [/图书馆/, /900|九百/],
        subject: /图书馆|场地/,
        said: [1, 2],
      },
      {
        name: "小罗周一发报名表",
        kind: "action",
        pattern: [/报名/, /周一/, /小罗/],
        subject: /报名/,
        said: [4],
      },
      {
        name: "周二取备用工具",
        kind: "action",
        pattern: [/工具/, /周二/, /对方/],
        subject: /工具/,
        said: [5],
      },
      {
        name: "小米周四印安全说明",
        kind: "action",
        pattern: [/安全/, /周四/, /小米/],
        subject: /安全/,
        said: [6],
      },
    ],
    notDecided: [/学校教室/, /准备午饭/],
  },
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

const FINAL_CALLS: Call[] = [
  {
    id: "in-place-en-ticket-launch",
    language: "en",
    requireSections: true,
    openQuestions: false,
    notes: [note("launch date"), note("UK fee")],
    turns: [
      me("Let's settle the launch date and UK fee for the ticket booking service."),
      them("We agree to launch on the twenty-second of May. That is the final date."),
      me("Agreed. The UK fee will be seven pounds per booking. That is our decision."),
      them("Lena will email the launch notice by Thursday."),
      me("I will update the fee page tomorrow."),
      them("Owen will run the checkout test on Friday."),
    ],
    facts: [
      {
        name: "launch on 22 May",
        kind: "decision",
        pattern: [/May/i, /22|twenty-second/i],
        subject: /launch|release|go[- ]?live/i,
        said: [1],
        underLine: "launch date",
      },
      {
        name: "UK fee £7 per booking",
        kind: "decision",
        pattern: [/£\s*7\b|GBP\s*7\b|\b(?:seven|7)\s*(?:pounds?|GBP)\b/i, /booking/i],
        subject: [/\bUK\b|United Kingdom/i, /fee|charge/i],
        said: [2],
        underLine: "UK fee",
      },
      {
        name: "Lena emails notice by Thursday",
        kind: "action",
        pattern: [/Lena/i, /notice/i, /Thursday/i],
        subject: /notice/i,
        said: [3],
      },
      {
        name: "Me updates fee page tomorrow",
        kind: "action",
        pattern: [/\b(?:Me|I)\b/i, /fee/i, /page/i, /tomorrow/i],
        subject: [/fee/i, /page/i],
        said: [4],
      },
      {
        name: "Owen tests checkout on Friday",
        kind: "action",
        pattern: [/Owen/i, /checkout/i, /Friday/i],
        subject: /checkout/i,
        said: [5],
      },
    ],
  },
  {
    id: "in-place-zh-ticket-launch",
    language: "zh-CN",
    requireSections: true,
    openQuestions: false,
    notes: [note("上线日期"), note("英国费用")],
    turns: [
      me("今天确定订票服务的上线日期和英国每单的费用。"),
      them("我们同意五月二十二日上线，这是最后定下的日期。"),
      me("同意。英国每笔订单收七英镑，就这样定了。"),
      them("小林周四前发上线通知。"),
      me("我明天更新费用页面。"),
      them("小欧周五测试结账流程。"),
    ],
    facts: [
      {
        name: "五月二十二日上线",
        kind: "decision",
        pattern: /五月二十二|5\s*月\s*22/,
        subject: /上线|发布/,
        said: [1],
        underLine: "上线日期",
      },
      {
        name: "英国每单七英镑",
        kind: "decision",
        pattern: [/七\s*英镑|7\s*英镑|£\s*7/, /订单|每单/],
        subject: [/英国/, /费用|收费|每单|每笔|订单/],
        said: [2],
        underLine: "英国费用",
      },
      {
        name: "小林周四发通知",
        kind: "action",
        pattern: [/小林/, /通知/, /周四/],
        subject: /通知/,
        said: [3],
      },
      {
        name: "我明天更新费用页面",
        kind: "action",
        pattern: [/我/, /明天/, /费用/, /页面/],
        subject: [/费用/, /页面/],
        said: [4],
      },
      {
        name: "小欧周五测试结账",
        kind: "action",
        pattern: [/小欧/, /周五/, /测试/, /结账/],
        subject: /结账/,
        said: [5],
      },
    ],
  },
  ...(
    [
      {
        id: "final-en-looped-room",
        language: "en",
        microphoneOnly: true,
        requireSections: true,
        openQuestions: false,
        notes: [
          note(
            "Harbour barrier call with Tom Okafor and Priya Raman: decide the crest raise and agree next steps.",
          ),
        ],
        turns: [
          me(
            "Hello Tom, hello Priya. Today we decide the crest raise for the harbour barrier and agree next steps.",
          ),
          me(
            "Tom Okafor here. The field report says raising the crest by 40 centimeters halves the expected damage.",
          ),
          me("Priya Raman here. The cost fits the budget if we phase the work over two winters."),
          me("Yes, we agree to raise the crest by 40 centimeters. That is our decision."),
          me("I will send the revised budget to the steering group by Friday."),
          me("I will book the survey boat for the December tide readings."),
          me("And I will get the engineers' cost estimate by the thirtieth, the end of the month."),
          me("Good. Thanks, everyone."),
        ],
        facts: [
          {
            name: "raise the crest by 40 cm",
            kind: "decision",
            pattern: [/crest/i, /\b40\b|forty/i],
            subject: /crest/i,
            said: [3],
          },
          {
            name: "revised budget by Friday",
            kind: "action",
            pattern: [/budget/i, /Friday/i],
            subject: /budget/i,
            said: [4],
          },
          {
            name: "survey boat booked",
            kind: "action",
            pattern: /survey boat/i,
            subject: /survey boat/i,
            said: [5],
          },
          {
            name: "engineers' cost estimate",
            kind: "action",
            pattern: /estimate/i,
            subject: /estimate/i,
            said: [6],
          },
        ],
      },
      {
        id: "final-zh-looped-room",
        language: "zh-CN",
        microphoneOnly: true,
        requireSections: true,
        openQuestions: false,
        notes: [note("防波堤会议，和汤姆、普丽娅：定加高方案，分好工")],
        turns: [
          me("汤姆、普丽娅你们好，今天要定防波堤加高的方案，再把下一步分好工。"),
          me("我是汤姆。现场报告说堤顶加高四十厘米，预计损失能减半。"),
          me("我是普丽娅。工程分两个冬天做，费用在预算之内。"),
          me("对，我们同意堤顶加高四十厘米，这就是我们的决定。"),
          me("我周五前把修改后的预算发给指导小组。"),
          me("我来订十二月测潮用的勘测船。"),
          me("我月底三十号前拿到工程师的成本估算。"),
          me("好，谢谢大家。"),
        ],
        facts: [
          {
            name: "堤顶加高四十厘米",
            kind: "decision",
            pattern: [/加高/, /40|四十/],
            subject: /堤顶|加高/,
            said: [3],
          },
          {
            name: "周五前发预算",
            kind: "action",
            pattern: [/预算/, /周五/],
            subject: /预算/,
            said: [4],
          },
          {
            name: "订勘测船",
            kind: "action",
            pattern: /勘测船|测量船/,
            subject: /勘测船|测量船/,
            said: [5],
          },
          { name: "成本估算", kind: "action", pattern: /估算/, subject: /估算/, said: [6] },
        ],
      },
    ] satisfies Call[]
  ).map((call) => ({
    ...call,
    turns: [...call.turns, ...call.turns.slice(0, 5)],
    facts: call.facts.map((fact) => ({
      ...fact,
      said: fact.said.flatMap((index) =>
        index < 5 ? [index, index + call.turns.length] : [index],
      ),
    })),
  })),
  {
    id: "final-en-launch",
    language: "en",
    requireSections: true,
    openQuestions: false,
    notes: [note("launch date")],
    turns: [
      me("Hi Sam. Let's pick the launch date for the booking app."),
      them("Marketing would like the third of March."),
      me("OK, then we launch on the third of March."),
      them(
        "Hold on. The payment provider's review takes four weeks, so we won't be approved by the third.",
      ),
      me("Then the third is off. We launch on the seventeenth of March instead."),
      them("The seventeenth leaves two weeks to spare. Agreed."),
      me("I'll tell marketing about the new date today."),
      them("And I'll submit the app for the payment review on Monday."),
    ],
    facts: [
      {
        name: "launch on 17 March",
        kind: "decision",
        pattern: [/\b17(?:th)?\b|seventeenth/i, /launch|release|go live/i],
        subject: /launch|release|go[- ]?live/i,
        said: [4, 5],
      },
      {
        name: "tell marketing today",
        kind: "action",
        pattern: [/marketing/i, /today/i],
        subject: /marketing/i,
        said: [6],
      },
      {
        name: "payment review on Monday",
        kind: "action",
        pattern: [/review/i, /Monday/i],
        subject: /review/i,
        said: [7],
      },
    ],
    notDecided: [/\b3(?:rd)?\b|third/i],
  },
  {
    id: "final-zh-launch",
    language: "zh-CN",
    requireSections: true,
    openQuestions: false,
    notes: [note("上线日期")],
    turns: [
      me("小孙你好，我们把小程序的上线日期定一下。"),
      them("市场部希望三月三日上线。"),
      me("行，那就三月三日上线。"),
      them("等一下，支付审核要四周，三月三日之前批不下来。"),
      me("那三月三日不行了。改成三月十七日上线。"),
      them("十七日还能留出两周的余量，同意。"),
      me("我今天就把新日期告诉市场部。"),
      them("我周一提交支付审核。"),
    ],
    facts: [
      {
        name: "三月十七日上线",
        kind: "decision",
        pattern: [/17\s*日|十七日|3\s*月\s*17/, /上线|发布/],
        subject: /上线|发布/,
        said: [4, 5],
      },
      {
        name: "今天告诉市场部",
        kind: "action",
        pattern: [/市场部/, /今天/],
        subject: /市场部/,
        said: [6],
      },
      {
        name: "周一提交支付审核",
        kind: "action",
        pattern: [/审核/, /周一/],
        subject: /审核/,
        said: [7],
      },
    ],
    notDecided: [/3\s*月\s*3\s*日|三月三日/],
  },
  {
    id: "final-en-cleaning",
    language: "en",
    requireSections: true,
    openQuestions: true,
    notes: [note("cleaning quotes")],
    turns: [
      me(
        "Hi Rosa, thanks for joining. I want to go over the cleaning quotes before anything is signed.",
      ),
      them(
        "Sure. BrightCo quoted one thousand one hundred pounds a month, and Clearway nine hundred and fifty.",
      ),
      me("Should we go with Clearway, since it's the cheapest?"),
      them("Maybe, but their references from the Leeds office were mixed."),
      me("If we picked BrightCo, we'd pay about eighteen hundred more a year."),
      them("Right. What if we asked Clearway for a trial month first?"),
      me("Possibly. It's hard to say yet."),
      them("Nimbus sends their quote next week."),
      me("Then I'll forward the Nimbus quote to you when it arrives."),
      them("And I'll call the Leeds office about Clearway's references."),
    ],
    facts: [
      {
        name: "forward the Nimbus quote",
        kind: "action",
        pattern: [/Nimbus/i, /forward/i],
        subject: /Nimbus/i,
        said: [8],
      },
      {
        name: "call Leeds about references",
        kind: "action",
        pattern: [/Leeds/i, /reference/i, /call|contact|ask|check with/i],
        subject: [/Leeds/i, /reference/i],
        said: [9],
      },
    ],
    notDecided: [/Clearway|BrightCo|trial/i],
  },
  {
    id: "final-zh-cleaning",
    language: "zh-CN",
    requireSections: true,
    openQuestions: true,
    notes: [note("保洁报价")],
    turns: [
      me("罗经理你好，签约之前想先把几家保洁公司的报价过一遍。"),
      them("好的。洁亮报价每月一万一千元，清风每月九千五百元。"),
      me("要不要选清风？它最便宜。"),
      them("也许吧，不过他们在杭州分公司的口碑一般。"),
      me("如果选洁亮，一年要多花一万八千元左右。"),
      them("对。要是先让清风试用一个月呢？"),
      me("也有可能。现在还说不好。"),
      them("云朵下周会把报价发过来。"),
      me("那等云朵的报价到了，我转发给你。"),
      them("我去问问杭州分公司对清风的评价。"),
    ],
    facts: [
      {
        name: "转发云朵的报价",
        kind: "action",
        pattern: [/云朵/, /转发/],
        subject: /云朵/,
        said: [8],
      },
      {
        name: "问杭州分公司",
        kind: "action",
        pattern: [/杭州/, /问|联系|咨询/],
        subject: /杭州/,
        said: [9],
      },
    ],
    notDecided: [/清风|洁亮|试用/],
  },
  {
    id: "final-en-summary",
    language: "en",
    requireSections: true,
    openQuestions: false,
    sectionHeadings: { summary: "Summary" },
    notes: [heading(2, "Summary"), note("staffing")],
    turns: [
      me("Hi Pete. Let's plan the staffing for the December market stall."),
      them("We need two people on weekdays and four on Saturdays."),
      me("Can students from the college cover the Saturdays?"),
      them("Three of them said yes, at twelve pounds an hour."),
      me("Then we hire the three students for the Saturdays."),
      them("Good. Who runs the till on weekdays?"),
      me("Hannah will run the till on weekdays."),
      them("I'll draw up the rota by Friday."),
    ],
    facts: [
      {
        name: "hire students for Saturdays",
        kind: "decision",
        pattern: [/student/i, /Saturday/i, /hire|employ|recruit|take on/i],
        subject: /student/i,
        said: [4],
      },
      {
        name: "Hannah runs the till",
        kind: "action",
        pattern: [/Hannah/i, /till/i],
        subject: /till/i,
        said: [6],
      },
      {
        name: "rota by Friday",
        kind: "action",
        pattern: [/rota/i, /Friday/i],
        subject: /rota/i,
        said: [7],
      },
    ],
  },
  {
    id: "final-zh-summary",
    language: "zh-CN",
    requireSections: true,
    openQuestions: false,
    sectionHeadings: { summary: "摘要" },
    notes: [heading(2, "摘要"), note("人手")],
    turns: [
      me("老彭好，我们排一下十二月集市摊位的人手。"),
      them("工作日要两个人，周六要四个人。"),
      me("周六能不能请学院的学生来帮忙？"),
      them("有三个学生答应了，每小时二十五元。"),
      me("那周六就请这三个学生。"),
      them("好。工作日谁来收银？"),
      me("汉娜工作日负责收银。"),
      them("我周五前把排班表做出来。"),
    ],
    facts: [
      {
        name: "周六请学生",
        kind: "decision",
        pattern: [/学生/, /周六/, /请|雇|聘|招/],
        subject: /学生/,
        said: [4],
      },
      {
        name: "汉娜工作日收银",
        kind: "action",
        pattern: [/汉娜/, /收银/],
        subject: /收银/,
        said: [6],
      },
      {
        name: "周五前做排班表",
        kind: "action",
        pattern: [/排班/, /周五/],
        subject: /排班/,
        said: [7],
      },
    ],
  },
  ...CALLS.filter((call) => call.id.endsWith("workshop")).map((call) => {
    const text = call.language === "en" ? "What we settled" : "敲定的事";
    return {
      ...call,
      id: `final-${call.language}-decisions-heading`,
      notes: [call.notes[0] ?? note(""), heading(2, text)],
      sectionHeadings: { decisions: text },
    };
  }),
];

interface ReservedFactInput {
  name: string;
  kind: Fact["kind"];
  pattern: string | string[];
  said: number[];
  underLine?: string;
  subject?: string | string[];
  stated?: true;
  accepted?: string;
  owner?: string;
  forbid?: string;
  misheard?: string;
  notBy?: string;
}

interface ReservedCallInput {
  id: string;
  language: "en" | "zh-CN";
  requireSections: true;
  openQuestions: boolean;
  notes: {
    type: "paragraph" | "heading";
    attrs?: { level: 2 };
    content: { type: "text"; text: string }[];
  }[];
  turns: Call["turns"];
  facts: ReservedFactInput[];
  sectionHeadings?: Call["sectionHeadings"];
  topics?: { name: string; pattern: string }[];
  documents?: Call["documents"];
  claims?: Call["claims"];
  userName?: string;
  named?: { kept: string[]; possessive: string[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isRegexSource = (value: unknown): value is string | string[] =>
  (typeof value === "string" && value.length > 0) ||
  (isArray(value) &&
    value.length > 0 &&
    value.every((each) => typeof each === "string" && each.length > 0));

function isReservedFact(value: unknown): value is ReservedFactInput {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      "name",
      "kind",
      "pattern",
      "said",
      "underLine",
      "subject",
      "stated",
      "accepted",
      "owner",
      "forbid",
      "misheard",
      "notBy",
    ]) &&
    typeof value.name === "string" &&
    (value.kind === "decision" || value.kind === "action" || value.kind === "figure") &&
    isRegexSource(value.pattern) &&
    isArray(value.said) &&
    value.said.length > 0 &&
    value.said.every(
      (index) => typeof index === "number" && Number.isInteger(index) && index >= 0,
    ) &&
    (value.underLine === undefined || typeof value.underLine === "string") &&
    (value.subject === undefined || isRegexSource(value.subject)) &&
    (value.stated === undefined || (value.stated === true && value.kind === "figure")) &&
    (value.accepted === undefined ||
      (typeof value.accepted === "string" &&
        value.accepted !== "" &&
        value.kind === "figure" &&
        value.stated === undefined)) &&
    (value.owner === undefined || (typeof value.owner === "string" && value.owner !== "")) &&
    (value.forbid === undefined ||
      (typeof value.forbid === "string" && value.owner !== undefined)) &&
    (value.misheard === undefined ||
      (typeof value.misheard === "string" && value.owner !== undefined)) &&
    (value.notBy === undefined ||
      (typeof value.notBy === "string" && value.notBy !== "" && value.owner === undefined))
  );
}

function isReservedCall(value: unknown): value is ReservedCallInput {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "id",
      "language",
      "requireSections",
      "openQuestions",
      "notes",
      "turns",
      "facts",
      "sectionHeadings",
      "topics",
      "documents",
      "claims",
      "userName",
      "named",
    ]) ||
    typeof value.id !== "string" ||
    (value.language !== "en" && value.language !== "zh-CN") ||
    !value.id.startsWith(value.language === "en" ? "reserved-en-" : "reserved-zh-") ||
    value.requireSections !== true ||
    typeof value.openQuestions !== "boolean"
  )
    return false;
  const { notes, turns, facts, sectionHeadings, topics, documents, claims, userName, named } =
    value;
  const names = isArray(facts) ? facts.map((fact) => (isRecord(fact) ? fact.name : null)) : [];
  const factNames = (list: unknown) =>
    isArray(list) && list.every((name) => typeof name === "string" && names.includes(name));
  const regexes = (list: unknown) =>
    isArray(list) && list.length > 0 && list.every((each) => isRegexSource(each));
  if (
    (topics !== undefined &&
      !(
        isArray(topics) &&
        topics.length > 0 &&
        topics.every(
          (topic) =>
            isRecord(topic) &&
            onlyKeys(topic, ["name", "pattern"]) &&
            typeof topic.name === "string" &&
            typeof topic.pattern === "string" &&
            topic.pattern.length > 0,
        )
      )) ||
    (documents !== undefined &&
      !(
        isArray(documents) &&
        documents.length > 0 &&
        documents.every(
          (document) =>
            isRecord(document) &&
            onlyKeys(document, ["name", "text"]) &&
            typeof document.name === "string" &&
            /^[^/\\]+\.(?:md|txt)$/.test(document.name) &&
            typeof document.text === "string",
        )
      )) ||
    (claims !== undefined &&
      !(
        isRecord(claims) &&
        onlyKeys(claims, ["listed", "kept"]) &&
        factNames(claims.listed) &&
        factNames(claims.kept)
      )) ||
    (userName !== undefined && (typeof userName !== "string" || userName.trim() === "")) ||
    (named !== undefined &&
      !(
        isRecord(named) &&
        onlyKeys(named, ["kept", "possessive"]) &&
        regexes(named.kept) &&
        regexes(named.possessive)
      )) ||
    (named !== undefined) !== (userName !== undefined)
  )
    return false;
  return (
    isArray(notes) &&
    notes.every(
      (node) =>
        isRecord(node) &&
        onlyKeys(node, ["type", "attrs", "content"]) &&
        (node.type === "paragraph" || node.type === "heading") &&
        (node.attrs === undefined ||
          (isRecord(node.attrs) && onlyKeys(node.attrs, ["level"]) && node.attrs.level === 2)) &&
        isArray(node.content) &&
        node.content.every(
          (text) =>
            isRecord(text) &&
            onlyKeys(text, ["type", "text"]) &&
            text.type === "text" &&
            typeof text.text === "string",
        ),
    ) &&
    isArray(turns) &&
    turns.every(
      (turn) =>
        isRecord(turn) &&
        onlyKeys(turn, ["side", "text"]) &&
        (turn.side === "me" || turn.side === "them") &&
        typeof turn.text === "string",
    ) &&
    isArray(facts) &&
    facts.every(isReservedFact) &&
    facts.every((fact) => fact.said.every((index) => index < turns.length)) &&
    (sectionHeadings === undefined ||
      (isRecord(sectionHeadings) &&
        onlyKeys(sectionHeadings, ["summary", "decisions", "actions", "questions"]) &&
        Object.values(sectionHeadings).every((text) => typeof text === "string")))
  );
}

function reservedRegex(source: string | string[]): RegExp | RegExp[] {
  try {
    return Array.isArray(source)
      ? source.map((each) => new RegExp(each, "i"))
      : new RegExp(source, "i");
  } catch {
    throw new Error("Invalid regex source in reserved meeting fixture.");
  }
}

async function loadReservedCalls(
  picked: readonly string[] | undefined,
  read: (file: "fill-reserved.json" | "fill-structured-reserved.json") => Promise<string> = (
    file,
  ) => readFile(new URL(file, new URL("../fixtures/meetings/", import.meta.url)), "utf8"),
): Promise<Call[]> {
  const selected = picked?.filter((id) => id.startsWith("reserved-")) ?? [];
  if (selected.length === 0) return [];
  const structured = selected.filter((id) => /^reserved-(?:en|zh)-structured-/.test(id));
  if (structured.length > 0 && structured.length !== selected.length) {
    throw new Error("Select structured or historical reserved calls, not both.");
  }
  const input: unknown = JSON.parse(
    await read(structured.length > 0 ? "fill-structured-reserved.json" : "fill-reserved.json"),
  );
  if (!isArray(input) || !input.every(isReservedCall)) {
    throw new Error("Invalid reserved meeting fixture.");
  }
  const ids = new Set(input.map((call) => call.id));
  if (ids.size !== input.length || selected.some((id) => !ids.has(id))) {
    throw new Error("Reserved meeting fixture has duplicate or missing selected ids.");
  }
  return input
    .filter((call) => selected.includes(call.id))
    .map(({ topics, named, ...call }) => ({
      ...call,
      facts: call.facts.map(
        ({ pattern, subject, accepted, owner, forbid, misheard, notBy, ...fact }) => ({
          ...fact,
          pattern: reservedRegex(pattern),
          ...(subject !== undefined && { subject: reservedRegex(subject) }),
          ...(accepted !== undefined && { accepted: new RegExp(accepted, "iu") }),
          ...(owner !== undefined && { owner: new RegExp(owner, "iu") }),
          ...(forbid !== undefined && { forbid: new RegExp(forbid, "iu") }),
          ...(misheard !== undefined && { misheard: new RegExp(misheard, "iu") }),
          ...(notBy !== undefined && { notBy: new RegExp(notBy, "iu") }),
        }),
      ),
      ...(topics && {
        topics: topics.map((topic) => ({
          name: topic.name,
          pattern: new RegExp(topic.pattern, "iu"),
        })),
      }),
      ...(named && {
        named: {
          kept: named.kept.map((source) => new RegExp(source, "iu")),
          possessive: named.possessive.map((source) => new RegExp(source, "iu")),
        },
      }),
    }));
}

type RequestLedger = ReturnType<typeof createRequestLedger>;
type Observation = Awaited<ReturnType<typeof startObservation>>;

/** A part of the note a fact can be in: a paragraph, or a list's item. */
interface Unit {
  text: string;
  ai: boolean;
  section: string | null;
  afterLine: string | null;
  citations: {
    quote: string;
    speaker: string | null;
    from: number | null;
    to: number | null;
    check: string;
  }[];
}

function unitsOf(doc: ProseMirrorNode): Unit[] {
  const units: Unit[] = [];
  let section: string | null = null;
  let afterLine: string | null = null;
  const unit = (node: ProseMirrorNode) => {
    let ai = false;
    const citations: Unit["citations"] = [];
    node.descendants((inside) => {
      if (inside.isText && inside.marks.some((mark) => mark.type.name === GENERATED_MARK)) {
        ai = true;
      }
      if (inside.type.name === CITATION_NODE) {
        const location = inside.attrs.location as {
          kind?: string;
          speaker?: string;
          from?: number;
          to?: number;
        } | null;
        citations.push({
          quote: String(inside.attrs.quote ?? ""),
          speaker: location?.kind === "time" ? (location.speaker ?? null) : null,
          from: location?.kind === "time" ? (location.from ?? null) : null,
          to: location?.kind === "time" ? (location.to ?? null) : null,
          check: String(inside.attrs.check ?? ""),
        });
      }
      return true;
    });
    units.push({ text: node.textContent, ai, section, afterLine, citations });
    if (!ai) afterLine = node.textContent;
  };
  doc.forEach((block) => {
    if (block.type.name === "heading") {
      section = block.textContent;
      afterLine = null;
      return;
    }
    if (block.type.name === "bulletList" || block.type.name === "orderedList") {
      block.forEach(unit);
    } else unit(block);
  });
  return units;
}

const SECTIONS = ["summary", "decisions", "actions", "questions", "claims"] as const;

/** Whether `text` is a pointer to where its item is written: "{topic} — see above" or "— see below". */
const pointsElsewhere = (text: string, language: Language) =>
  (["above", "below"] as const).some((direction) =>
    text
      .trim()
      .endsWith(translate(language, `meetings.fill.reference.${direction}`, { topic: "" }).trim()),
  );
/** A request that fills the notes in; every other one a fill sends checks a claim. */
const FILL_REQUEST = /Fill them in from the transcript|The User took no notes/;
/** A sentence's end: a Chinese one, or a Latin one before a space or the text's end, never a decimal point. */
const SENTENCE_END = /[.!?](?=\s|$)|[。！？]/gu;
const sentencesIn = (text: string) => {
  const ends = [...text.trim().matchAll(SENTENCE_END)];
  const last = ends.at(-1);
  const tail = last ? text.trim().slice(last.index + last[0].length) : text;
  return ends.length + (tail.trim() === "" ? 0 : 1);
};

/** A part of the note under one heading, as the User reads it: its lines and bullets in order. */
interface NotePart {
  heading: string;
  generated: boolean;
  /** `typedAbove`: a line the User typed comes earlier under the same heading. */
  items: { text: string; bullet: boolean; ai: boolean; cited: boolean; typedAbove: boolean }[];
}

function partsOf(doc: ProseMirrorNode): NotePart[] {
  const generated = (node: ProseMirrorNode) => {
    let ai = false;
    node.descendants((inside) => {
      if (inside.isText && inside.marks.some((mark) => mark.type.name === GENERATED_MARK))
        ai = true;
      return !ai;
    });
    return ai;
  };
  const cited = (node: ProseMirrorNode) => {
    let found = false;
    node.descendants((inside) => {
      if (inside.type.name === CITATION_NODE && inside.attrs.check === "found") found = true;
      return !found;
    });
    return found;
  };
  const item = (node: ProseMirrorNode, bullet: boolean) => ({
    text: node.textContent,
    bullet,
    ai: generated(node),
    cited: cited(node),
    typedAbove: current.items.some((each) => !each.ai),
  });
  let current: NotePart = { heading: "", generated: false, items: [] };
  const parts = [current];
  doc.forEach((block) => {
    if (block.type.name === "heading") {
      current = { heading: block.textContent, generated: generated(block), items: [] };
      parts.push(current);
    } else if (block.type.name === "bulletList" || block.type.name === "orderedList") {
      block.forEach((listItem) => {
        current.items.push(item(listItem, true));
      });
    } else current.items.push(item(block, false));
  });
  return parts;
}

/**
 * The note's shape (#2306): Summary first, a few sentences; then the call's topics, each a heading
 * with cited bullets and no pointers; the sections only when the call had some, as bullets; and
 * the claims list only with Documents to check, holding the facts they don't.
 */
function structureOf(doc: ProseMirrorNode, call: Call) {
  const titles = Object.fromEntries(
    SECTIONS.map((section) => [
      section,
      call.sectionHeadings?.[section as keyof NonNullable<Call["sectionHeadings"]>] ??
        translate(call.language, `meetings.fill.section.${section}`),
    ]),
  ) as Record<(typeof SECTIONS)[number], string>;
  const sectionTitles = new Set(Object.values(titles));
  const typedHeadings = call.notes.flatMap((node) =>
    node.type === "heading" ? [(node.content ?? []).map((each) => each.text ?? "").join("")] : [],
  );
  const parts = partsOf(doc);
  const ai = (part: NotePart | undefined) => part?.items.filter((each) => each.ai) ?? [];
  const part = (section: (typeof SECTIONS)[number]) =>
    parts.find((each) => each.heading === titles[section]);
  // What the User typed comes first, filled in; of what the fill adds under its own headings,
  // Summary leads, unless the User's own heading hosts it.
  const firstAdded = parts.find((each) => each.generated && ai(each).length > 0);
  const summary = ai(part("summary"));
  const topics = parts.filter(
    (each) =>
      each.heading !== "" &&
      !sectionTitles.has(each.heading) &&
      (each.generated ||
        (typedHeadings.includes(each.heading) && ai(each).some((item) => item.bullet))),
  );
  const topicItems = topics.flatMap((each) => ai(each));
  const isPointer = (text: string) => pointsElsewhere(text, call.language);
  const listed = ai(part("claims"));
  const named = (names: readonly string[] | undefined) =>
    (names ?? []).filter((name) => {
      const fact = call.facts.find((each) => each.name === name);
      return fact !== undefined && listed.some((item) => says(fact, item.text));
    });
  const sectionItems = (["decisions", "actions", "questions", "claims"] as const).flatMap(
    (section) => ai(part(section)),
  );
  return {
    summaryFirst:
      call.sectionHeadings?.summary !== undefined || firstAdded?.heading === titles.summary,
    summaryParts: summary.length,
    summarySentences: summary[0] ? sentencesIn(summary[0].text) : 0,
    summaryCited: summary.length > 0 && summary.every((item) => item.cited && !item.bullet),
    topics: topics.map((each) => each.heading),
    // A topic that was all decisions or tasks shows in those sections, not under a heading of its own.
    topicsMissing: (call.topics ?? [])
      .filter(
        (topic) =>
          !topics.some((each) => topic.pattern.test(each.heading)) &&
          !sectionItems.some((item) => topic.pattern.test(item.text)),
      )
      .map((topic) => topic.name),
    topicItems: topicItems.length,
    topicSentences: topicItems.map((item) => sentencesIn(item.text)),
    // What fills in a typed line under the User's heading stays a paragraph under it.
    topicNotBullets: topicItems.filter((item) => !item.bullet && !item.typedAbove).length,
    topicUncited: topicItems.filter((item) => !item.cited).length,
    topicPointers: topicItems.filter((item) => isPointer(item.text)).length,
    sectionNotBullets: sectionItems.filter((item) => !item.bullet).length,
    sectionUncited: sectionItems.filter((item) => !item.cited).length,
    emptyHeadings: parts
      .filter((each) => each.generated && ai(each).length === 0)
      .map((each) => each.heading),
    claimsList: listed.length,
    claimsPointers: listed.filter((item) => isPointer(item.text)).length,
    claimsListed: named(call.claims?.listed),
    claimsKeptListed: named(call.claims?.kept),
  };
}

const says = (fact: Fact, text: string) =>
  (Array.isArray(fact.pattern) ? fact.pattern : [fact.pattern]).every((each) => each.test(text));

const namesSubject = (fact: Fact, text: string) => {
  const subject = fact.subject ?? fact.pattern;
  return (Array.isArray(subject) ? subject : [subject]).every((each) => each.test(text));
};

const machineAddresses = (text: string) =>
  [...text.matchAll(/(?<![A-Za-z0-9_])(?:P\d+_F\d+|F\d+|[LH]\d+)(?![A-Za-z0-9_])/gi)].length;

function machineAddressLeaks(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.descendants((inside) => {
      if (inside.isText) {
        text += inside.marks.some((mark) => mark.type.name === GENERATED_MARK)
          ? (inside.text ?? "")
          : " ";
      }
      return true;
    });
    count += machineAddresses(text);
    return false;
  });
  return count;
}

const parts = (fact: Fact) => (Array.isArray(fact.pattern) ? fact.pattern : [fact.pattern]);
const matchCount = (pattern: RegExp, text: string) =>
  [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`))].length;

// Component-match minima miss partial/anaphoric repeats; an independent raw audit is still required.
const occurrences = (fact: Fact, text: string) =>
  Math.min(...parts(fact).map((pattern) => matchCount(pattern, text)));

/** A fact the fixtures score as the User's own action, written in the first person. */
const OWN_ACTION = /\bin the first person\b|以第一人称/;

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The call scored with the User's name set in Settings (#2306): each of their own actions must
 * name them by it, or keep we (我们) where the fixture already took we for that action, a
 * commitment of the User's side. It is wrong with I, me or my (我, but not 我们 or 我方), the token
 * in any form, "the User" (用户), or a word the fixture already turned down for it other than the
 * name. Every other fact is scored as before.
 */
function namedCall(call: Call, name: string): Call {
  const facts = call.facts.map((fact) => {
    if (!OWN_ACTION.test(fact.name)) return fact;
    const patterns = parts(fact);
    const owner = patterns.findIndex((each) => /\\bI\\b|我\(/.test(each.source));
    const firstPerson = patterns[owner];
    if (!firstPerson) throw new Error(`${call.id}: "${fact.name}" has no first-person owner.`);
    const turnedDown = (/^\(\?<!\\b\(\?:([^)]*)\)/.exec(firstPerson.source)?.[1]?.split("|") ?? [])
      .filter((word) => word.toLowerCase() !== name.toLowerCase())
      .map((word) => `\\b(?:${word})\\b`);
    const wrong =
      call.language === "en"
        ? [...turnedDown, "\\bI\\b(?![./-])", "\\b(?:me|my|mine|myself)\\b", "\\bthe\\s+User\\b"]
        : ["我(?![们方])", "用户"];
    const we = call.language === "en" ? "\\bwe\\b" : "我们(?!的)";
    const owners = [
      call.language === "en" ? `\\b${literally(name)}\\b` : literally(name),
      ...(firstPerson.test(call.language === "en" ? "we send it" : "我们发") ? [we] : []),
    ];
    const owned = new RegExp(
      `^(?![\\s\\S]*(?:${[...wrong, "[{}｛｝]"].join("|")}))[\\s\\S]*(?:${owners.join("|")})`,
      "iu",
    );
    return { ...fact, pattern: patterns.map((each, index) => (index === owner ? owned : each)) };
  });
  return { ...call, facts };
}

/** What a model wrote in a reply, whole: its raw record holds its reasoning in streamed pieces. */
const writtenIn = (raw: string): string[] => [
  raw,
  [...raw.matchAll(/\{"type":"reasoning(?:-delta)?","text":("(?:[^"\\]|\\.)*")\}/g)]
    .map((match) => String(JSON.parse(match[1] ?? '""')))
    .join(""),
];

/**
 * Of the requests a call made, how many held the User's `name`, and where it was outside words the
 * call itself said or the model wrote (`said`): the app's own words never carry it.
 */
function nameInRequests(prompts: readonly string[], name: string, said: readonly string[]) {
  const sources = said.flatMap((text) => [text, JSON.stringify(text).slice(1, -1)]);
  const outside: string[] = [];
  for (const prompt of prompts) {
    for (let at = prompt.indexOf(name); at >= 0; at = prompt.indexOf(name, at + name.length)) {
      const before = prompt.slice(Math.max(0, at - 12), at + name.length);
      const after = prompt.slice(at, at + name.length + 12);
      if (!sources.some((source) => source.includes(before) || source.includes(after)))
        outside.push(prompt.slice(Math.max(0, at - 60), at + name.length + 60));
    }
  }
  return {
    requests: prompts.length,
    holding: prompts.filter((prompt) => prompt.includes(name)).length,
    outside: outside.length,
    outsideAt: outside.slice(0, 5),
  };
}

/** Tokens, or stray braces of one, left in the AI text of the note: none may show (#2306). */
const rawTokens = (units: readonly Unit[]) =>
  units
    .filter((unit) => unit.ai)
    .reduce(
      (sum, unit) => sum + (unit.text.match(/[{｛]+[^{}｛｝]*[}｝]+|[{}｛｝]/gu)?.length ?? 0),
      0,
    );

test("meeting scores count repeated facts inside one paragraph, not just matching paragraphs", () => {
  const fact: Fact = {
    name: "raise the crest by 40 cm",
    kind: "decision",
    pattern: [/crest/i, /40|forty/i],
    said: [0],
  };
  expect(occurrences(fact, "Raise the crest by 40 centimetres.")).toBe(1);
  expect(
    occurrences(
      fact,
      'Raise the crest by 40 centimetres. They agreed to "raise the crest by forty centimetres".',
    ),
  ).toBe(2);
  expect(occurrences(fact, "Raise the crest by forty centimetres; the crest is damaged.")).toBe(1);
  expect(occurrences(fact, "The crest is damaged.")).toBe(0);
});

test.each(["en", "zh-CN"] as const)(
  "meeting scores disclose the occurrence-min blind spot for anaphoric repeats (%s)",
  (language) => {
    const fact: Fact = {
      name: "crest raise",
      kind: "decision",
      pattern: language === "en" ? [/crest/i, /40|forty/i] : [/堤顶/, /40|四十/],
      subject: language === "en" ? /crest/i : /堤顶/,
      said: [0],
    };
    const repeated =
      language === "en"
        ? "Raise the crest by 40 cm. We agree to raise it by 40 cm."
        : "堤顶加高四十厘米。同意将其加高四十厘米。";
    expect(occurrences(fact, repeated)).toBe(1);
    const reference = language === "en" ? "Crest raise — details above." : "堤顶加高，详见上文。";
    expect(namesSubject(fact, reference)).toBe(true);
    expect(occurrences(fact, reference)).toBe(0);
  },
);

test("meeting scores give every section-gated development fact an explicit subject", () => {
  for (const call of [...CALLS, ...FINAL_CALLS].filter((call) => call.requireSections)) {
    for (const fact of call.facts) {
      expect(fact.subject, `${call.id}: ${fact.name}`).toBeDefined();
    }
  }
});

test("meeting scores fall back to full patterns for older facts without subjects", () => {
  const fact: Fact = {
    name: "older fact",
    kind: "decision",
    pattern: [/launch/i, /May/i],
    said: [0],
  };
  expect(namesSubject(fact, "Launch in May")).toBe(true);
  expect(namesSubject(fact, "Launch — see above")).toBe(false);
});

test.each(["en", "zh-CN"] as const)(
  "meeting scores count machine addresses in prose, not ordinary words (%s)",
  (language) => {
    const leaked =
      language === "en"
        ? "Launch: see L1 and H2. Fee: [L12], (H34), L1+, l3/h4. Facts: F1, P1_F1, [P2_F10], f3/p4_f5."
        : "上线见L1和H2。费用：[L12]、（H34）、L1+、l3/h4。事实：F1、P1_F1、[P2_F10]、f3/p4_f5。";
    expect(machineAddresses(leaked)).toBe(12);
    expect(
      machineAddresses(
        language === "en"
          ? "Launch details above. XL1, H2O, LH2, L12plan, x_H2, XF1, F1score, P1_F1plan, x_P1_F1, 40 cm."
          : "上线详情见上文。XL1、H2O、LH2、L12plan、x_H2、XF1、F1score、P1_F1plan、x_P1_F1、四十厘米。",
      ),
    ).toBe(0);
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores count addresses only in generated rendered text, including headings and lists (%s)",
  (language) => {
    const generated = (text: string, bold = false): JSONContent => ({
      type: "text",
      text,
      marks: [{ type: GENERATED_MARK }, ...(bold ? [{ type: "bold" }] : [])],
    });
    const doc = getSchema(noteExtensions()).nodeFromJSON({
      type: "doc",
      content: [
        note("L99 H99 F99 P99_F99"),
        heading(2, "H88"),
        {
          type: "heading",
          attrs: { level: 2 },
          content: [generated(language === "en" ? "See H2" : "见H2")],
        },
        {
          type: "paragraph",
          content: [
            generated(language === "en" ? "See L" : "见L"),
            generated("12", true),
            {
              type: CITATION_NODE,
              attrs: { quote: "L77 H77 F77 P77_F77", check: "found" },
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            generated(language === "en" ? "See P1_" : "见P1_"),
            generated("F2", true),
            generated(" F3"),
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [generated("H3 P2_F1")] }],
            },
          ],
        },
      ],
    });
    expect(machineAddressLeaks(doc)).toBe(6);
  },
);

test("meeting scores' development calls contain no spoken machine addresses", () => {
  for (const call of [...CALLS, ...FINAL_CALLS]) {
    expect(machineAddresses(call.turns.map((turn) => turn.text).join("\n")), call.id).toBe(0);
  }
});

const plain = (text: string) =>
  text
    .replace(/\[[^\]]*\]/g, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

function hasGeneratedOverview(summary: readonly Unit[], replies: readonly string[]): boolean {
  const overviewText = (text: string) => {
    const body = text.replace(/\[\^\d+\]/g, "").trim();
    if (/^(?:`|~{3}|\{|\[|"(?:[^"\\]|\\.)*"$)/.test(body)) return null;
    const normalized = plain(body);
    return /[\p{L}\p{N}]/u.test(normalized) ? normalized : null;
  };
  const overviews = replies.flatMap((reply) => {
    const lines = reply.split(/\r?\n/);
    const visible = unfencedLines(lines);
    const markers = visible.flatMap((line, index) =>
      line?.startsWith("### ") ? [{ marker: line.slice(4).trim(), index }] : [],
    );
    return markers.flatMap(({ marker, index }, position) => {
      const next = markers[position + 1];
      if (/^(?:SUMMARY(?: H\d+)?|H\d+ SUMMARY)$/i.test(marker)) {
        const first = visible
          .slice(index + 1, next?.index)
          .find((line) => line !== null && line.trim() !== "");
        const text = first === undefined || first === null ? null : overviewText(first);
        return text === null ? [] : [text];
      }
      if (marker !== "OVERVIEW" || next?.marker !== "END OVERVIEW") return [];
      const block = lines.slice(index + 1, next.index).join("\n");
      const framed = /^\s*```json[ \t]*\n([\s\S]*?)\n```[ \t]*\n([\s\S]*)$/.exec(block);
      if (!framed) return [];
      let metadata: unknown;
      try {
        metadata = JSON.parse(framed[1] ?? "");
      } catch {
        return [];
      }
      if (
        !isRecord(metadata) ||
        !onlyKeys(metadata, ["citations"]) ||
        !isArray(metadata.citations) ||
        metadata.citations.length === 0 ||
        !metadata.citations.every(
          (citation) => typeof citation === "number" && Number.isInteger(citation) && citation > 0,
        )
      )
        return [];
      const body = (framed[2] ?? "").trim();
      if (/^ {0,3}(?:`{3,}|~{3,})/m.test(body)) return [];
      const paragraph = body.split(/\n\s*\n/)[0] ?? "";
      if (!metadata.citations.some((citation) => paragraph.includes(`[^${citation}]`))) return [];
      const text = overviewText(paragraph);
      return text === null ? [] : [text];
    });
  });
  return summary.some((unit) => {
    const text = overviewText(unit.text);
    return (
      unit.ai &&
      text !== null &&
      overviews.includes(text) &&
      unit.citations.some((citation) => citation.check === "found")
    );
  });
}

function unfencedLines(lines: readonly string[]): (string | null)[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const delimiter = marker?.[1];
    if (fence !== null) {
      if (
        delimiter !== undefined &&
        delimiter[0] === fence[0] &&
        delimiter.length >= fence.length &&
        marker?.[2]?.trim() === ""
      )
        fence = null;
      return null;
    }
    if (delimiter) {
      fence = delimiter;
      return null;
    }
    return line;
  });
}

const SPEAKERS = { me: ["me", "我"], them: ["them", "对方"] } as const;

/** A Citation of a turn that says the fact, found in the Transcript, with that turn's speaker. */
function citesRightly(unit: Unit, fact: Fact, call: Call, cues: readonly Cue[]): boolean {
  return unit.citations.some((citation) => {
    if (citation.check !== "found" || citation.from === null || !Number.isFinite(citation.from))
      return false;
    const quote = plain(citation.quote);
    const cue = cues.find(
      (cue) =>
        cue.startMs === citation.from &&
        cue.endMs === citation.to &&
        cue.speaker?.toLowerCase() === citation.speaker?.toLowerCase(),
    );
    if (!cue) return false;
    return fact.said.some((index) => {
      const turn = call.turns[index];
      if (!turn || quote === "") return false;
      const line = plain(turn.text);
      const heard = plain(cue.text);
      const speaker = citation.speaker?.toLowerCase() ?? "";
      const said =
        (line.includes(quote) || quote.includes(line)) &&
        (line.includes(heard) || heard.includes(line));
      return (
        said &&
        (call.microphoneOnly
          ? speaker === "speaker ?"
          : SPEAKERS[turn.side].some((each) => each === speaker))
      );
    });
  });
}

/**
 * Where a fact is written: a unit that says all of it, or, for a decision, a
 * run of consecutive units in one place (one section, after the same line) that each say some of its
 * parts and together say all of them. A run counts as often as its most repeated part, so a part
 * written twice is a duplicate; a unit naming the call's rejected option is never in a run.
 */
function placements(
  fact: Fact,
  units: readonly Unit[],
  call: Call,
  cues: readonly Cue[],
): { count: number; inPlace: boolean; cited: boolean } {
  // A decision or an action is written whole in its section; the typed line it answers then has
  // a short pointer citing the same turn (#2306).
  const isPointer = (unit: Unit) => pointsElsewhere(unit.text, call.language);
  const found = units
    .filter((unit) => unit.ai && says(fact, unit.text))
    .map((unit) => ({ units: [unit], count: occurrences(fact, unit.text) }));
  if (fact.kind === "decision") {
    let run: Unit[] = [];
    const close = () => {
      const text = run.map((unit) => unit.text).join("\n");
      if (run.length > 1 && says(fact, text))
        found.push({
          units: run,
          count: Math.max(...parts(fact).map((pattern) => matchCount(pattern, text))),
        });
      run = [];
    };
    for (const unit of units) {
      // A pointer names its fact's topic, and is never a part of it.
      const isPart =
        unit.ai &&
        !isPointer(unit) &&
        !says(fact, unit.text) &&
        parts(fact).some((pattern) => pattern.test(unit.text)) &&
        !call.notDecided?.some((pattern) => pattern.test(unit.text));
      const previous = run.at(-1);
      if (
        previous &&
        (!isPart || unit.section !== previous.section || unit.afterLine !== previous.afterLine)
      )
        close();
      if (isPart) run.push(unit);
    }
    close();
  }
  const pointed = units.some(
    (unit) =>
      unit.ai &&
      unit.afterLine === fact.underLine &&
      isPointer(unit) &&
      citesRightly(unit, fact, call, cues),
  );
  return {
    count: found.reduce((sum, each) => sum + each.count, 0),
    inPlace:
      fact.underLine === undefined ||
      found.some((each) => each.units[0]?.afterLine === fact.underLine) ||
      (fact.kind !== "figure" && found.length > 0 && pointed),
    cited:
      found.length > 0 &&
      found.every((each) => each.units.every((unit) => citesRightly(unit, fact, call, cues))),
  };
}

function actionSectionCounts(
  units: readonly Unit[],
  title: string,
  call: Call,
  cues: readonly Cue[],
): { actionsSection: number; actionsInSection: number } {
  const actions = units.filter((unit) => unit.ai && unit.section === title);
  return {
    actionsSection: actions.length,
    actionsInSection: call.facts.filter(
      (fact) =>
        fact.kind === "action" &&
        actions.some(
          (unit) =>
            plain(unit.text) !== "" &&
            (fact.subject === undefined || namesSubject(fact, unit.text)) &&
            citesRightly(unit, fact, call, cues),
        ),
    ).length,
  };
}

test.each(["en", "zh-CN"] as const)(
  "meeting scores require every action's cited task reference even when full facts are in place (%s)",
  (language) => {
    const call: Call = {
      id: "actions-section-scorer-only",
      language,
      requireSections: true,
      notes: [],
      turns:
        language === "en"
          ? [
              me("Arun will send the budget on Friday."),
              them("I will book the survey boat on Monday."),
              me("Cora will get the cost estimate on Tuesday."),
            ]
          : [me("阿伦周五发预算。"), them("我周一订勘测船。"), me("小柯周二拿到成本估算。")],
      facts: [
        {
          name: "budget",
          kind: "action",
          pattern: language === "en" ? [/budget/i, /Arun/i, /Friday/i] : [/预算/, /阿伦/, /周五/],
          subject: /budget|预算/i,
          said: [0],
        },
        {
          name: "survey boat",
          kind: "action",
          pattern:
            language === "en" ? [/survey boat/i, /\bI\b/, /Monday/i] : [/勘测船/, /我/, /周一/],
          subject: language === "en" ? [/survey/i, /boat/i] : /勘测船/,
          said: [1],
        },
        {
          name: "cost estimate",
          kind: "action",
          pattern:
            language === "en" ? [/estimate/i, /Cora/i, /Tuesday/i] : [/估算/, /小柯/, /周二/],
          subject: /estimate|估算/i,
          said: [2],
        },
      ],
    };
    const title = language === "en" ? "Next steps" : "下一步";
    const texts =
      language === "en"
        ? ["Budget — details above.", "Survey boat — see above.", "Cost estimate — details above."]
        : ["预算，详见上文。", "勘测船，见上文。", "成本估算，详见上文。"];
    const cues: Cue[] = call.turns.map((turn, index) => ({
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
      text: turn.text,
      speaker: turn.side === "me" ? "Me" : "Them",
    }));
    const inPlace: Unit[] = cues.map((cue) => ({
      text: cue.text,
      ai: true,
      section: null,
      afterLine: "typed task",
      citations: [
        {
          quote: cue.text,
          from: cue.startMs,
          to: cue.endMs,
          speaker: cue.speaker ?? null,
          check: "found",
        },
      ],
    }));
    const references = inPlace.map((unit, index) => ({
      ...unit,
      text: texts[index] ?? "",
      section: title,
      afterLine: null,
    }));
    for (const [index, fact] of call.facts.entries()) {
      const full = inPlace[index];
      const reference = references[index];
      if (!full || !reference) throw new Error("The synthetic action's units are missing.");
      expect(says(fact, full.text)).toBe(true);
      expect(citesRightly(full, fact, call, cues)).toBe(true);
      expect(namesSubject(fact, reference.text)).toBe(true);
      expect(says(fact, reference.text)).toBe(false);
      expect(occurrences(fact, reference.text)).toBe(0);
      expect(machineAddresses(reference.text)).toBe(0);
    }
    const counts = (extra: Unit[]) =>
      actionSectionCounts([...inPlace, ...extra], title, call, cues);
    expect(counts([])).toEqual({ actionsSection: 0, actionsInSection: 0 });
    expect(counts(references.slice(0, 1))).toEqual({ actionsSection: 1, actionsInSection: 1 });
    expect(
      counts(references.map((unit) => ({ ...unit, citations: inPlace[0]?.citations ?? [] }))),
    ).toEqual({ actionsSection: 3, actionsInSection: 1 });
    expect(counts(references)).toEqual({ actionsSection: 3, actionsInSection: 3 });
    expect(
      counts(references.map((unit, index) => ({ ...unit, text: texts[(index + 1) % 3] ?? "" }))),
    ).toEqual({ actionsSection: 3, actionsInSection: 0 });
    expect(counts(references.map((unit) => ({ ...unit, ai: false })))).toEqual({
      actionsSection: 0,
      actionsInSection: 0,
    });
    expect(counts(references.map((unit) => ({ ...unit, section: "other section" })))).toEqual({
      actionsSection: 0,
      actionsInSection: 0,
    });
    const noActions = { ...call, facts: [] };
    expect(actionSectionCounts([], title, noActions, cues)).toEqual({
      actionsSection: 0,
      actionsInSection: 0,
    });
    expect(actionSectionCounts(references, title, noActions, cues)).toEqual({
      actionsSection: 3,
      actionsInSection: 0,
    });
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores allow nonempty cited action references without optional subjects, pending raw-topic audit (%s)",
  (language) => {
    const fact: Fact = {
      name: "budget",
      kind: "action",
      pattern: language === "en" ? [/budget/i, /Arun/i, /Friday/i] : [/预算/, /阿伦/, /周五/],
      said: [0],
    };
    const text = language === "en" ? "Arun will send the budget on Friday." : "阿伦周五发预算。";
    const call: Call = {
      id: "optional-action-subject-scorer-only",
      language,
      requireSections: true,
      notes: [],
      turns: [me(text)],
      facts: [fact],
    };
    const cues: Cue[] = [{ startMs: 0, endMs: 1_000, text, speaker: "Me" }];
    const title = language === "en" ? "Actions" : "待办";
    const unit: Unit = {
      text: language === "en" ? "Budget — details above." : "预算，详见上文。",
      ai: true,
      section: title,
      afterLine: null,
      citations: [{ quote: text, from: 0, to: 1_000, speaker: "Me", check: "found" }],
    };
    const covered = (candidate: Unit) =>
      actionSectionCounts([candidate], title, call, cues).actionsInSection;
    expect(namesSubject(fact, unit.text)).toBe(false);
    expect(covered(unit)).toBe(1);
    expect(occurrences(fact, unit.text)).toBe(0);
    for (const text of ["", " ", "—。!", "[^1]"]) {
      expect(covered({ ...unit, text })).toBe(0);
    }
    expect(covered({ ...unit, citations: [] })).toBe(0);
    for (const invalid of [
      { check: "not-found" },
      { from: 2_000 },
      { to: 2_000 },
      { speaker: "Them" },
      { quote: "unrelated quote" },
    ]) {
      expect(
        covered({
          ...unit,
          citations: unit.citations.map((citation) => ({ ...citation, ...invalid })),
        }),
      ).toBe(0);
    }
    expect(
      covered({
        ...unit,
        text: language === "en" ? "Unrelated task — see above." : "别的任务，见上文。",
      }),
    ).toBe(1);
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores require nonempty actual raw overview text with a found citation (%s)",
  (language) => {
    const text =
      language === "en"
        ? "The call settled staffing and the next steps."
        : "会议敲定了人手安排和后续工作。";
    const unit: Unit = {
      text,
      ai: true,
      section: language === "en" ? "Summary" : "摘要",
      afterLine: null,
      citations: [{ quote: text, from: 0, to: 1_000, speaker: "Me", check: "found" }],
    };
    for (const marker of ["SUMMARY", "SUMMARY H2", "H2 SUMMARY"]) {
      expect(hasGeneratedOverview([unit], [`### ${marker}\n\n${text} [^1]\n`])).toBe(true);
    }
    for (const empty of ["", "[^1]", "[^1] [^2]", "—。! [^1]", "\u200b [^1]"]) {
      const reply = `### SUMMARY\n${empty}\n`;
      expect(hasGeneratedOverview([{ ...unit, text: empty }], [reply])).toBe(false);
      expect(hasGeneratedOverview([{ ...unit, text: "" }], [reply])).toBe(false);
      expect(hasGeneratedOverview([unit], [reply])).toBe(false);
    }
    const reply = `### SUMMARY\n${text} [^1]\n`;
    expect(hasGeneratedOverview([{ ...unit, text: "" }], [reply])).toBe(false);
    expect(hasGeneratedOverview([{ ...unit, citations: [] }], [reply])).toBe(false);
    expect(
      hasGeneratedOverview(
        [
          {
            ...unit,
            citations: unit.citations.map((citation) => ({ ...citation, check: "not-found" })),
          },
        ],
        [reply],
      ),
    ).toBe(false);
    const detail = language === "en" ? "Budget details are above." : "预算详情见上文。";
    expect(hasGeneratedOverview([{ ...unit, text: detail }], [reply])).toBe(false);
    expect(
      hasGeneratedOverview([{ ...unit, text: detail }], [`### SUMMARY\n[^1]\n${detail} [^2]\n`]),
    ).toBe(false);
    expect(hasGeneratedOverview([unit], [`### ACTIONS\n${text} [^1]\n`])).toBe(false);
  },
);

test.each([
  ["The cups cost 8.4 pence. Lids are 2.9 pence each.", 2],
  ["合同总价18.6万元。付款分三笔。", 2],
  ["One sentence without a stop", 1],
  ["", 0],
])("meeting scores count %j as %i sentences, never splitting at a decimal point", (text, count) => {
  expect(sentencesIn(text)).toBe(count);
});

test("meeting scores accept the literal production OVERVIEW frame", () => {
  const reply = [
    "### OVERVIEW",
    "```json",
    '{"citations":[2]}',
    "```",
    "The call covered review planning. [^2]",
    "### END OVERVIEW",
  ].join("\n");
  const unit: Unit = {
    text: "The call covered review planning.",
    ai: true,
    section: "Summary",
    afterLine: null,
    citations: [
      {
        quote: "The call covered review planning.",
        from: 0,
        to: 1_000,
        speaker: "Me",
        check: "found",
      },
    ],
  };
  expect(hasGeneratedOverview([unit], [reply])).toBe(true);
});

test.each(["en", "zh-CN"] as const)(
  "meeting scores require cited prose outside closed OVERVIEW metadata and framing (%s)",
  (language) => {
    const text =
      language === "en"
        ? "The call settled staffing and the next steps."
        : "会议敲定了人手安排和后续工作。";
    const unit: Unit = {
      text,
      ai: true,
      section: language === "en" ? "Summary" : "摘要",
      afterLine: null,
      citations: [{ quote: text, from: 0, to: 1_000, speaker: "Me", check: "found" }],
    };
    const metadata = '```json\n{"citations":[7]}\n```';
    const frame = (body: string) => `### OVERVIEW\n${metadata}\n${body}\n### END OVERVIEW`;
    const reply = frame(`${text} [^7]`);
    expect(hasGeneratedOverview([unit], [reply])).toBe(true);
    expect(hasGeneratedOverview([unit], [reply.replaceAll("\n", "\r\n")])).toBe(true);
    expect(machineAddresses(unit.text)).toBe(0);
    const wrapped = text.replace(language === "en" ? "staffing" : "人手", "$&\n");
    expect(hasGeneratedOverview([unit], [frame(`${wrapped} [^7]`)])).toBe(true);
    for (const empty of ["", "[^7]", "[^7] [^8]", "—。! [^7]", "\u200b [^7]"]) {
      const raw = frame(empty);
      expect(hasGeneratedOverview([{ ...unit, text: empty }], [raw])).toBe(false);
      expect(hasGeneratedOverview([unit], [raw])).toBe(false);
    }
    for (const invalid of [
      frame(`${text} [^8]`),
      frame(text),
      frame(`\`${text}\` [^7]`),
      frame(`${JSON.stringify(text)} [^7]`),
      frame(`\`\`\`text\n${text} [^7]\n\`\`\``),
      frame(`[^7]\n\n${text} [^7]`),
      reply.replace("### END OVERVIEW", ""),
      reply.replace("### END OVERVIEW", "### ENDOVERVIEW"),
      reply.replace("### END OVERVIEW", "### END P1_F1"),
      reply.replace(metadata, '```json\n{"citations":[]}\n```'),
      reply.replace(metadata, '```json\n{"citations":["7"]}\n```'),
      reply.replace(metadata, '```json\n{"citations":[0]}\n```'),
      reply.replace(metadata, '```json\n{"citations":[7]\n```'),
      `### OVERVIEW\n\`\`\`json\n{"citations":[7]}\n### END OVERVIEW\n\`\`\`\n${text} [^7]`,
      `### OVERVIEW\n${metadata}\n\`\`\`text\n${text} [^7]\n### END OVERVIEW\n\`\`\``,
      `### OVERVIEW\n${metadata}\n\`\`\`text\n${text} [^7]\n### END OVERVIEW\n\`\`\`\n### END OVERVIEW`,
    ]) {
      expect(hasGeneratedOverview([unit], [invalid])).toBe(false);
    }
    for (const candidate of [
      { ...unit, text: "" },
      { ...unit, text: language === "en" ? "Details are above." : "详情见上文。" },
      { ...unit, ai: false },
      { ...unit, citations: [] },
      {
        ...unit,
        citations: unit.citations.map((citation) => ({ ...citation, check: "not-found" })),
      },
    ]) {
      expect(hasGeneratedOverview([candidate], [reply])).toBe(false);
    }
    const fact = [
      "### FACT P1_F1",
      "```json",
      JSON.stringify({
        topic: text,
        citations: [7],
        lines: ["L1"],
        sections: ["actions"],
        claim: false,
        supersedes: [],
      }),
      "```",
      `${text} [^7]`,
      "### END P1_F1",
    ].join("\n");
    expect(hasGeneratedOverview([unit], [fact])).toBe(false);
    expect(hasGeneratedOverview([unit], [fact, reply])).toBe(true);
    expect(
      hasGeneratedOverview([unit], [frame(JSON.stringify({ purpose: text, citations: [7] }))]),
    ).toBe(false);
    for (const marker of ["SUMMARY", "OVERVIEW"]) {
      const fenced = `\`\`\`text\n### ${marker}\n${metadata}\n${text} [^7]\n### END OVERVIEW\n\`\`\``;
      expect(hasGeneratedOverview([unit], [fenced])).toBe(false);
      expect(
        hasGeneratedOverview([unit], [`### SUMMARY\n\`\`\`json\n${JSON.stringify(text)}\n\`\`\``]),
      ).toBe(false);
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores require a decision topic as well as its saved cue (%s)",
  (language) => {
    const call = FINAL_CALLS.find(
      (each) => each.id === `in-place-${language === "en" ? "en" : "zh"}-ticket-launch`,
    );
    if (!call) throw new Error("The ticket-launch call is missing.");
    const references =
      language === "en"
        ? ["Launch date — details above.", "UK fee — see the agreed detail above."]
        : ["上线日期，详见上文。", "英国费用，见上文已定内容。"];
    const cues: Cue[] = call.turns.map((turn, index) => ({
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
      text: turn.text,
      speaker: turn.side === "me" ? "Me" : "Them",
    }));
    for (const [index, fact] of call.facts.filter((fact) => fact.kind === "decision").entries()) {
      const cue = cues[fact.said[0] ?? -1];
      const reference = references[index];
      if (!cue || !reference) throw new Error("The decision scorer's cue or topic is missing.");
      const unit: Unit = {
        text: reference,
        ai: true,
        section: "Decisions",
        afterLine: null,
        citations: [
          {
            quote: cue.text,
            from: cue.startMs,
            to: cue.endMs,
            speaker: cue.speaker ?? null,
            check: "found",
          },
        ],
      };
      const accepted = (candidate: Unit) =>
        namesSubject(fact, candidate.text) && citesRightly(candidate, fact, call, cues);
      expect(accepted(unit)).toBe(true);
      expect(says(fact, reference)).toBe(false);
      expect(occurrences(fact, reference)).toBe(0);
      expect(machineAddresses(reference)).toBe(0);
      for (const text of [
        "",
        " ",
        language === "en" ? "See above." : "见上文。",
        language === "en" ? "As agreed, details above." : "已商定，详情见上文。",
        references[1 - index] ?? "",
      ]) {
        const decoy = { ...unit, text };
        expect(citesRightly(decoy, fact, call, cues)).toBe(true);
        expect(accepted(decoy), text).toBe(false);
      }
      expect(namesSubject(fact, reference)).toBe(true);
      expect(accepted({ ...unit, citations: [] })).toBe(false);
      const wrongCue = cues[0];
      if (!wrongCue) throw new Error("The wrong-cue decoy is missing.");
      expect(
        accepted({
          ...unit,
          citations: [
            {
              quote: wrongCue.text,
              from: wrongCue.startMs,
              to: wrongCue.endMs,
              speaker: wrongCue.speaker ?? null,
              check: "found",
            },
          ],
        }),
      ).toBe(false);
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores reject the right words at the wrong cue (%s)",
  (language) => {
    const budget = language === "en" ? "I will send the budget on Friday." : "我会在周五发预算。";
    const estimate =
      language === "en"
        ? "I will send the engineers' estimate on Monday."
        : "我会在周一发工程师的估价。";
    const quote = language === "en" ? "I will" : "我会";
    const fact: Fact = { name: "estimate", kind: "action", pattern: /estimate|估价/, said: [1] };
    const call: Call = {
      id: "citation-cue-score",
      language,
      notes: [],
      turns: [me(budget), me(estimate)],
      facts: [fact],
      microphoneOnly: true,
    };
    const cues: Cue[] = [
      { startMs: 1_000, endMs: 2_000, text: budget, speaker: "Speaker ?" },
      { startMs: 7_000, endMs: 8_000, text: estimate, speaker: "Speaker ?" },
    ];
    const citation: Unit["citations"][number] = {
      quote,
      speaker: "Speaker ?",
      from: 1_000,
      to: 2_000,
      check: "found",
    };
    const unit: Unit = {
      text: estimate,
      ai: true,
      section: null,
      afterLine: null,
      citations: [citation],
    };
    expect(citesRightly(unit, fact, call, cues)).toBe(false);
    const selected = { ...citation, from: 7_000, to: 8_000 };
    expect(citesRightly({ ...unit, citations: [selected] }, fact, call, cues)).toBe(true);
    for (const invalid of [
      { to: 9_000 },
      { to: null },
      { speaker: "Me" },
      { check: "not-found" },
      { quote: budget },
    ]) {
      expect(
        citesRightly({ ...unit, citations: [{ ...selected, ...invalid }] }, fact, call, cues),
      ).toBe(false);
    }
  },
);

function splitDecision(language: "en" | "zh-CN") {
  const en = language === "en";
  const turns = en
    ? [
        them("The oak floor would be 18,000 pounds, so we turned it down."),
        me("Settled: the budget is 12,000 pounds and the work is done by May 20."),
      ]
    : [
        them("实木地板要十八万元，这个方案否了。"),
        me("就这么定：预算十二万元，五月二十日前完工。"),
      ];
  const fact: Fact = {
    name: "budget and deadline",
    kind: "decision",
    pattern: en ? [/12,000 pounds/i, /May 20/i] : [/十二万元/, /五月二十日/],
    subject: en ? /budget/i : /预算/,
    said: [1],
    underLine: en ? "budget and deadline" : "预算和工期",
  };
  const call: Call = {
    id: "split-decision-scorer-only",
    language,
    notes: [],
    turns,
    facts: [fact],
    notDecided: [en ? /18,000/ : /十八万/],
  };
  const cues: Cue[] = turns.map((turn, index) => ({
    startMs: index * 1_000,
    endMs: (index + 1) * 1_000,
    text: turn.text,
    speaker: turn.side === "me" ? "Me" : "Them",
  }));
  const unit = (text: string, turn = 1): Unit => {
    const cue = cues[turn];
    if (!cue) throw new Error("The split decision's cue is missing.");
    return {
      text,
      ai: true,
      section: null,
      afterLine: fact.underLine ?? null,
      citations: [
        {
          quote: cue.text,
          from: cue.startMs,
          to: cue.endMs,
          speaker: cue.speaker ?? null,
          check: "found",
        },
      ],
    };
  };
  const text = en
    ? {
        budget: "The budget is 12,000 pounds.",
        deadline: "The work is done by May 20.",
        whole: "Budget 12,000 pounds, done by May 20.",
        rejected: "Not the 18,000-pound oak floor: the budget is 12,000 pounds.",
        unrelated: "The yard has parking.",
      }
    : {
        budget: "预算定在十二万元。",
        deadline: "五月二十日前完工。",
        whole: "预算十二万元，五月二十日前完工。",
        rejected: "不做十八万元的实木地板，预算十二万元。",
        unrelated: "院子里有停车位。",
      };
  const score = (units: Unit[]) => placements(fact, units, call, cues);
  return { fact, call, cues, unit, text, score };
}

test.each(["en", "zh-CN"] as const)(
  "meeting scores accept a decision split over consecutive cited units in one place, each part once (%s)",
  (language) => {
    const { fact, unit, text, score } = splitDecision(language);
    expect(says(fact, text.budget)).toBe(false);
    expect(says(fact, text.deadline)).toBe(false);
    const placed = { count: 1, inPlace: true, cited: true };
    expect(score([unit(text.budget), unit(text.deadline)])).toEqual(placed);
    expect(score([unit(text.deadline), unit(text.budget)])).toEqual(placed);
    expect(score([unit(text.whole)])).toEqual(placed);
    const inSection = (each: Unit): Unit => ({ ...each, section: "Decisions", afterLine: null });
    expect(score([inSection(unit(text.budget)), inSection(unit(text.deadline))])).toEqual({
      count: 1,
      inPlace: false,
      cited: true,
    });
  },
);

test.each(["en", "zh-CN"] as const)(
  "a decision written whole in its section is in place when its typed line points to it, citing the same turn (%s)",
  (language) => {
    const { unit, text, score } = splitDecision(language);
    const inSection = (each: Unit): Unit => ({ ...each, section: "Decisions", afterLine: null });
    const pointer = language === "en" ? "Budget — see below" : "预算，详见下文";
    const unrelated = language === "en" ? "The van is booked." : "车已经订好了。";
    expect(score([unit(pointer), inSection(unit(text.whole))])).toEqual({
      count: 1,
      inPlace: true,
      cited: true,
    });
    expect(score([unit(pointer, 0), inSection(unit(text.whole))]).inPlace).toBe(false);
    expect(score([unit(pointer)]).inPlace).toBe(false);
    expect(score([unit(unrelated), inSection(unit(text.whole))]).inPlace).toBe(false);
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores reject a split decision with a part missing or twice, a wrong Citation, another place or the rejected option (%s)",
  (language) => {
    const { fact, call, cues, unit, text, score } = splitDecision(language);
    const missing = { count: 0, inPlace: false, cited: false };
    expect(score([unit(text.budget)])).toEqual(missing);
    expect(score([unit(text.budget), unit(text.budget), unit(text.deadline)]).count).toBe(2);
    expect(score([unit(text.whole), unit(text.budget), unit(text.deadline)]).count).toBe(2);
    expect(score([unit(text.budget), unit(text.deadline, 0)])).toEqual({
      count: 1,
      inPlace: true,
      cited: false,
    });
    expect(score([unit(text.rejected), unit(text.deadline)])).toEqual(missing);
    expect(score([unit(text.budget), unit(text.unrelated), unit(text.deadline)])).toEqual(missing);
    expect(score([unit(text.budget), { ...unit(text.deadline), section: "Summary" }])).toEqual(
      missing,
    );
    expect(score([unit(text.budget), { ...unit(text.deadline), afterLine: "other line" }])).toEqual(
      missing,
    );
    expect(score([{ ...unit(text.budget), ai: false }, unit(text.deadline)])).toEqual(missing);
    expect(
      placements({ ...fact, kind: "action" }, [unit(text.budget), unit(text.deadline)], call, cues),
    ).toEqual(missing);
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores require the action's owner (%s)",
  (language) => {
    const call = CALLS.find(
      (each) => each.id === `sections-${language === "en" ? "en" : "zh"}-workshop`,
    );
    const fact = call?.facts.find((each) => each.kind === "action");
    if (!fact) throw new Error("The workshop's form action is missing.");
    const correct =
      language === "en" ? "Send the sign-up form on Monday — Ravi" : "周一发报名表 — 小罗";
    const wrong =
      language === "en" ? "Send the sign-up form on Monday — Mina" : "周一发报名表 — 小米";
    expect(says(fact, correct)).toBe(true);
    expect(says(fact, wrong)).toBe(false);
  },
);

test.each(["en", "zh-CN"] as const)(
  "meeting scores accept a terse fee answer under its required typed line (%s)",
  (language) => {
    const call = FINAL_CALLS.find(
      (each) => each.id === `in-place-${language === "en" ? "en" : "zh"}-ticket-launch`,
    );
    const fact = call?.facts.find((each) => each.name.includes(language === "en" ? "fee" : "每单"));
    if (!fact?.underLine) throw new Error("The in-place fee expectation is missing.");
    expect(says(fact, language === "en" ? "£7 per booking" : "每单七英镑")).toBe(true);
    expect(says(fact, language === "en" ? "7 euros per booking" : "每单七欧元")).toBe(false);
    expect(says(fact, language === "en" ? "£8 per booking" : "每单八英镑")).toBe(false);
  },
);

function reservedSample(language: "en" | "zh-CN"): ReservedCallInput {
  return {
    id: language === "en" ? "reserved-en-scorer-only" : "reserved-zh-scorer-only",
    language,
    requireSections: true,
    openQuestions: false,
    notes: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
      { type: "paragraph", content: [{ type: "text", text: "  staffing 人手\nunchanged  " }] },
    ],
    turns: [
      me("Hire students on Saturday. 周六请学生。"),
      them("I will send the rota. 我发排班表。"),
    ],
    facts: [
      {
        name: "student staffing",
        kind: "decision",
        pattern: ["STUDENT|学生", "Saturday|周六"],
        subject: language === "en" ? "STUDENT" : ["学生"],
        said: [0],
        underLine: "  staffing 人手\nunchanged  ",
      },
      { name: "rota", kind: "action", pattern: "ROTA|排班", said: [1] },
    ],
    sectionHeadings: {
      summary: "Summary",
      decisions: "Settled",
      actions: "Next steps",
      questions: "Unknowns",
    },
  };
}

test("meeting scores never read reserved fixtures without an explicit reserved selection", async () => {
  const read = vi.fn(async () => {
    throw new Error("No fixture should be read.");
  });
  for (const picked of [undefined, [], ["sections-en-museum"], ["final-zh-launch", ""]]) {
    expect(await loadReservedCalls(picked, read)).toEqual([]);
  }
  expect(read).not.toHaveBeenCalled();
});

test.each(["en", "zh-CN"] as const)(
  "meeting scores load only selected synthetic reserved calls without changing their raw input (%s)",
  async (language) => {
    const sample = reservedSample(language);
    const raw = [sample, reservedSample(language === "en" ? "zh-CN" : "en")];
    const before = structuredClone(raw);
    const read = vi.fn(async () => JSON.stringify(raw));
    const calls = await loadReservedCalls(["sections-en-museum", sample.id], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("fill-reserved.json");
    expect(raw).toEqual(before);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    const fact = call?.facts[0];
    const action = call?.facts[1];
    if (!call || !fact || !action) throw new Error("The synthetic loader result is missing.");
    expect(call.id).toBe(sample.id);
    expect(call.language).toBe(language);
    expect(call.notes).toEqual(sample.notes);
    expect(call.turns).toEqual(sample.turns);
    expect(call.sectionHeadings).toEqual(sample.sectionHeadings);
    expect(call.requireSections).toBe(true);
    expect(call.openQuestions).toBe(false);
    expect(call.microphoneOnly).toBeUndefined();
    expect(fact.said).toEqual([0]);
    expect(fact.underLine).toBe(sample.facts[0]?.underLine);
    expect(says(fact, "students on saturday 学生周六")).toBe(true);
    expect(namesSubject(fact, language === "en" ? "Students — see above" : "学生，见上文")).toBe(
      true,
    );
    expect(says(action, "rota 排班表")).toBe(true);
    for (const pattern of [fact.pattern, fact.subject, action.pattern].flat()) {
      if (!pattern) throw new Error("The synthetic regex is missing.");
      expect(pattern.flags).toBe("i");
    }
  },
);

test("meeting scores route all selected synthetic structured calls to the fixed fresh fixture", async () => {
  const samples = (["en", "zh-CN"] as const).flatMap((language) =>
    [1, 2, 3].map((index) => ({
      ...reservedSample(language),
      id: `reserved-${language === "en" ? "en" : "zh"}-structured-scorer-only-${index}`,
    })),
  );
  const read = vi.fn(async () => JSON.stringify(samples));
  const calls = await loadReservedCalls(
    samples.map((sample) => sample.id),
    read,
  );
  expect(read).toHaveBeenCalledExactlyOnceWith("fill-structured-reserved.json");
  expect(calls.map((call) => call.id)).toEqual(samples.map((sample) => sample.id));
  for (const sample of samples) {
    read.mockClear();
    expect(await loadReservedCalls([sample.id], read)).toHaveLength(1);
    expect(read).toHaveBeenCalledExactlyOnceWith("fill-structured-reserved.json");
  }
});

test("meeting scores reject mixed historical and structured selections before any read", async () => {
  const historical = reservedSample("en");
  const read = vi.fn(async () => JSON.stringify([historical]));
  for (const selected of [
    [historical.id, "reserved-zh-structured-scorer-only"],
    ["reserved-en-structured-scorer-only", historical.id],
  ]) {
    await expect(loadReservedCalls(selected, read)).rejects.toThrow("not both");
  }
  expect(read).not.toHaveBeenCalled();
});

test.each<{ name: string; invalid: (sample: ReservedCallInput) => unknown }>([
  { name: "non-array root", invalid: () => ({}) },
  { name: "non-object call", invalid: () => [null] },
  { name: "non-string id", invalid: (sample) => [{ ...sample, id: 1 }] },
  { name: "non-reserved id", invalid: (sample) => [{ ...sample, id: "sections-en-sample" }] },
  { name: "mismatched language prefix", invalid: (sample) => [{ ...sample, language: "zh-CN" }] },
  { name: "unsupported language", invalid: (sample) => [{ ...sample, language: "fr" }] },
  { name: "ungated call", invalid: (sample) => [{ ...sample, requireSections: false }] },
  { name: "missing openQuestions", invalid: (sample) => [{ ...sample, openQuestions: undefined }] },
  { name: "non-boolean openQuestions", invalid: (sample) => [{ ...sample, openQuestions: "no" }] },
  { name: "unexpected microphoneOnly", invalid: (sample) => [{ ...sample, microphoneOnly: true }] },
  { name: "non-array notes", invalid: (sample) => [{ ...sample, notes: {} }] },
  {
    name: "unsupported note type",
    invalid: (sample) => [{ ...sample, notes: [{ type: "image" }] }],
  },
  {
    name: "wrong heading level",
    invalid: (sample) => [{ ...sample, notes: [{ ...sample.notes[0], attrs: { level: 3 } }] }],
  },
  {
    name: "non-text content",
    invalid: (sample) => [
      { ...sample, notes: [{ type: "paragraph", content: [{ type: "citation" }] }] },
    ],
  },
  {
    name: "non-string note text",
    invalid: (sample) => [
      { ...sample, notes: [{ type: "paragraph", content: [{ type: "text", text: 1 }] }] },
    ],
  },
  { name: "non-array turns", invalid: (sample) => [{ ...sample, turns: {} }] },
  {
    name: "unsupported turn side",
    invalid: (sample) => [{ ...sample, turns: [{ side: "other", text: "x" }] }],
  },
  {
    name: "non-string turn text",
    invalid: (sample) => [{ ...sample, turns: [{ side: "me", text: 1 }] }],
  },
  { name: "non-array facts", invalid: (sample) => [{ ...sample, facts: {} }] },
  {
    name: "non-string fact name",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], name: 1 }] }],
  },
  {
    name: "unsupported fact kind",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], kind: "opinion" }] }],
  },
  {
    name: "claims naming no fact",
    invalid: (sample) => [{ ...sample, claims: { listed: ["Not a fact"], kept: [] } }],
  },
  {
    name: "a Document named with a path",
    invalid: (sample) => [{ ...sample, documents: [{ name: "../quote.md", text: "x" }] }],
  },
  {
    name: "named checks without a Settings name",
    invalid: (sample) => [{ ...sample, named: { kept: ["our"], possessive: ["x"] } }],
  },
  {
    name: "a topic with no pattern",
    invalid: (sample) => [{ ...sample, topics: [{ name: "Pricing", pattern: "" }] }],
  },
  {
    name: "non-string regex",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], pattern: 1 }] }],
  },
  {
    name: "empty regex array",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], pattern: [] }] }],
  },
  {
    name: "empty regex source",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], pattern: "" }] }],
  },
  {
    name: "mixed regex array",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], pattern: ["x", 1] }] }],
  },
  {
    name: "invalid regex source",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], pattern: "[" }] }],
  },
  {
    name: "invalid subject type",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], subject: [1] }] }],
  },
  {
    name: "invalid subject regex",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], subject: ["["] }] }],
  },
  {
    name: "non-string underLine",
    invalid: (sample) => [{ ...sample, facts: [{ ...sample.facts[0], underLine: 1 }] }],
  },
  ...[
    { name: "non-array cue indices", said: "0" },
    { name: "missing cue indices", said: [] },
    { name: "non-integer cue index", said: [0.5] },
    { name: "negative cue index", said: [-1] },
    { name: "non-number cue index", said: ["0"] },
    { name: "out-of-range cue index", said: [2] },
  ].map(({ name, said }) => ({
    name,
    invalid: (sample: ReservedCallInput) => [{ ...sample, facts: [{ ...sample.facts[0], said }] }],
  })),
  {
    name: "non-object section headings",
    invalid: (sample) => [{ ...sample, sectionHeadings: [] }],
  },
  {
    name: "non-string section heading",
    invalid: (sample) => [{ ...sample, sectionHeadings: { summary: 1 } }],
  },
  {
    name: "unknown section",
    invalid: (sample) => [{ ...sample, sectionHeadings: { other: "x" } }],
  },
])("meeting scores reject invalid synthetic reserved fixture: $name", async ({ invalid }) => {
  const sample = reservedSample("en");
  await expect(
    loadReservedCalls([sample.id], async () => JSON.stringify(invalid(sample))),
  ).rejects.toThrow();
});

test("meeting scores reject duplicate or absent selected reserved ids and malformed JSON", async () => {
  const sample = reservedSample("en");
  await expect(
    loadReservedCalls([sample.id], async () => JSON.stringify([sample, sample])),
  ).rejects.toThrow("duplicate or missing");
  await expect(
    loadReservedCalls(["reserved-en-absent"], async () => JSON.stringify([sample])),
  ).rejects.toThrow("duplicate or missing");
  await expect(loadReservedCalls([sample.id], async () => "[")).rejects.toThrow();
});

test.skipIf(!LOADER_PREFLIGHT)("structured meeting loader source-freeze preflight", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("The keyless structured loader attempted a network request.");
  });
  try {
    const provider = vi.spyOn(chatModels, "createAiSdkChatModel").mockImplementation(() => {
      throw new Error("The keyless structured loader attempted provider construction.");
    });
    try {
      await checkStructuredMeetingLoader({
        environment: process.env,
        load: (picked) => loadReservedCalls(picked),
        attempts: () => ({ fetch: fetch.mock.calls.length, provider: provider.mock.calls.length }),
      });
    } finally {
      provider.mockRestore();
    }
  } finally {
    fetch.mockRestore();
  }
});

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

function expectCompleteFill(fill: MeetingFill): void {
  expect(fill.problem, "A partial fill is not a model-quality pass").toBeNull();
  expect(fill.omitted ?? 0, "No facts were omitted").toBe(0);
  expect(fill.unfinishedParts ?? 0, "No transcript parts were left unfinished").toBe(0);
}

// protects=with a name set in Settings, the User's own actions in held-out calls m, n and o count only when they name the User by it, or keep we (我们) where the fixture took we, and fail in the first person, with the token in any form, as "the User" or with "my", while every other fact scores as before (#2306); fails_when=a first-person, token or unlisted we sentence passes, or a named one fails; no_claim=a real model's wording.
test("meeting scores with a Settings name require it for the User's own actions", async () => {
  const cases: Record<string, { name: string; right: string[]; wrong: string[] }[]> = {
    "reserved-en-structured-m": [
      {
        name: "Imogen",
        right: ["Imogen will send Pavel our latest electricity bill by September 8."],
        wrong: [
          "I will send our latest electricity bill by September 8.",
          "{{me}} will send our latest electricity bill by September 8.",
          "Imogen will send my latest electricity bill by September 8.",
          "The User will send the electricity bill by September 8.",
          "They will send the electricity bill by September 8.",
        ],
      },
    ],
    "reserved-en-structured-n": [
      {
        name: "Avery Lin",
        right: [
          "Avery Lin will send the other side our glossary of product terms by November 5.",
          "We will send the glossary by November 5.",
        ],
        wrong: [
          "I will send our glossary of product terms by November 5.",
          "{me} will send the glossary by November 5.",
        ],
      },
    ],
    "reserved-en-structured-o": [
      {
        name: "Sunita",
        right: ["Sunita will send Marco the final guest count by June 4."],
        wrong: ["I will send Marco the final guest count by June 4."],
      },
      {
        name: "Sunita",
        right: ["Sunita will pay the deposit by May 21."],
        wrong: [
          "｛｛ME｝｝ will pay the deposit by May 21.",
          "Me will pay the deposit by May 21.",
          "We will pay the deposit by May 21.",
        ],
      },
    ],
    "reserved-zh-structured-m": [
      {
        name: "梁薇",
        right: [
          "梁薇在六月二十日前把各班的人数统计发给季川。",
          "我们在六月二十日前把各班的人数统计发给季川。",
        ],
        wrong: [
          "我在六月二十日前把各班的人数统计发给季川。",
          "{{me}}在六月二十日前把各班的人数统计发给季川。",
          "用户在六月二十日前把各班的人数统计发给季川。",
        ],
      },
    ],
    "reserved-zh-structured-n": [
      {
        name: "林安",
        right: ["林安在九月十日前把我们门店每个月的用量表发给对方。"],
        wrong: [
          "我九月十日前把门店每个月的用量表发给对方。",
          "我们九月十日前把门店每个月的用量表发给对方。",
        ],
      },
    ],
    "reserved-zh-structured-o": [
      {
        name: "邱宁",
        right: ["邱宁在十月二十日前把背板的设计稿发给傅磊。"],
        wrong: ["我在十月二十日前把背板的设计稿发给傅磊。"],
      },
      {
        name: "邱宁",
        right: ["邱宁在十月八日前把定金付了。"],
        wrong: ["{{me}}的定金在十月八日前付了。", "邱宁和我在十月八日前把定金付了。"],
      },
    ],
  };
  const calls = await loadReservedCalls(Object.keys(cases));
  expect(calls.map((call) => call.id).sort()).toEqual(Object.keys(cases).sort());
  for (const call of calls) {
    const expected = cases[call.id] ?? [];
    const named = namedCall(call, expected[0]?.name ?? "");
    const own = named.facts.filter((fact) => OWN_ACTION.test(fact.name));
    expect(own, call.id).toHaveLength(expected.length);
    for (const [index, fact] of own.entries()) {
      for (const text of expected[index]?.right ?? []) expect(says(fact, text), text).toBe(true);
      for (const text of expected[index]?.wrong ?? []) expect(says(fact, text), text).toBe(false);
    }
    expect(named.facts.filter((fact) => !OWN_ACTION.test(fact.name))).toEqual(
      call.facts.filter((fact) => !OWN_ACTION.test(fact.name)),
    );
  }
});

// protects=the named run's request check counts the User's name only where the app's own words carry it, not where the call itself said it or the model wrote it back, and counts a token left in the note (#2306); fails_when=a name the transcript carries counts against the app, or one the app added doesn't; no_claim=what a real run sends.
test("meeting scores tell the app's own use of the name from the call's", () => {
  const said = "Hi, this is Imogen. We're putting solar panels on our roof in Harlow.";
  const fill = JSON.stringify([
    { role: "user", content: `[0:02 Me] ${said}\nWrite the User as {{me}}.` },
  ]);
  expect(nameInRequests([fill], "Imogen", [said])).toMatchObject({
    requests: 1,
    holding: 1,
    outside: 0,
  });
  const told = JSON.stringify([
    { role: "system", content: "The User set their name as Imogen Hart." },
  ]);
  expect(nameInRequests([fill, told], "Imogen", [said])).toMatchObject({
    requests: 2,
    holding: 2,
    outside: 1,
    outsideAt: [expect.stringContaining("set their name as Imogen Hart")],
  });
  const thought = ["Imo", "gen is the User, so she sends the bill."]
    .map((text) => JSON.stringify({ type: "reasoning-delta", text }))
    .join("");
  const reasoned = JSON.stringify([
    { role: "assistant", content: "Imogen is the User, so she sends the bill." },
  ]);
  expect(nameInRequests([reasoned], "Imogen", writtenIn(thought))).toMatchObject({ outside: 0 });
  const unit = (text: string, ai: boolean): Unit => ({
    text,
    ai,
    section: null,
    afterLine: null,
    citations: [],
  });
  expect(rawTokens([unit("Imogen will pay {{me}} and ｛me", true), unit("{typed}", false)])).toBe(
    2,
  );
});

test("meeting scores reject honest partial fills even when their state is filled", () => {
  const complete: MeetingFill = {
    state: "filled",
    mode: "notes",
    local: false,
    problem: null,
  };
  expect(() => expectCompleteFill(complete)).not.toThrow();
  expect(() => expectCompleteFill({ ...complete, omitted: 0, unfinishedParts: 0 })).not.toThrow();
  for (const partial of [
    { omitted: 1 },
    { unfinishedParts: 1 },
    { omitted: 2, unfinishedParts: 1 },
    { problem: { kind: "model" as const, message: "Some facts could not be filled." } },
  ]) {
    expect(() => expectCompleteFill({ ...complete, ...partial })).toThrow();
  }
});

/**
 * Where the call's Note goes: a Folder holding its Documents, or none. With
 * INCARNAMIND_LIVE_LIBRARY, a folder of other files, the Note goes in no Folder, with no scope
 * chosen, beside a Library holding those files and the call's own: its claims aren't checked.
 */
async function withDocuments(core: Core, call: Call): Promise<string | null> {
  const library = process.env.INCARNAMIND_LIVE_LIBRARY;
  const sources = await createSourceFolder();
  const written = await Promise.all(
    (call.documents ?? []).map((document) =>
      writeSourceFile(sources, document.name, document.text),
    ),
  );
  const others = library
    ? (await readdir(library))
        .filter((file) => /\.(?:md|txt|pdf)$/.test(file))
        .map((file) => join(library, file))
    : [];
  if (written.length + others.length === 0) return null;
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  const added = await addAndProcess(core, [...written, ...others]);
  if (library || written.length === 0) return null;
  const folder = await core.createLibraryGroup({ name: "Call documents", description: "" });
  await core.moveToFolder({
    documentIds: added.map((document) => document.id),
    folderId: folder.id,
  });
  return folder.id;
}

async function run(call: Call, ledger: RequestLedger, observation: Observation | null) {
  const dataDir = STRUCTURED?.dataDir ?? (await createTempDataFolder());
  // The first line of each side goes with the moment both sources start, so they share a clock.
  const { core, record } = await transcribingCore(dataDir, {
    engine: {
      lines: [
        "",
        ...call.turns
          .filter((turn) => call.microphoneOnly || turn.side === "me")
          .map((turn) => turn.text),
      ],
      theirLines: [
        "",
        ...call.turns.filter((turn) => turn.side === "them").map((turn) => turn.text),
      ],
    },
    createChatModel: (spec) => ledger.model(spec, () => chatModels.createAiSdkChatModel(spec)),
    ...(LOCAL_MODEL && {
      ollamaModels:
        evalOllamaModels({
          kind: "ollama",
          modelId: MODEL,
          apiKey: null,
          baseUrl: "http://127.0.0.1:11434",
          endpoint: null,
          numCtx: 8_192,
          citing: null,
        }) ?? undefined,
    }),
  });
  try {
    if (STRUCTURED)
      await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
    const name = call.userName ?? USER_NAME;
    await core.updateSettings({
      user: {
        language: call.language,
        monthlyCap: { amount: 0.25, currency: "USD" },
        ...(name && { authorName: name }),
      },
    });
    if (LOCAL_MODEL) {
      await core.saveChatProvider({ kind: "ollama", modelId: MODEL });
      await core.setLocalOnly(true);
    } else await core.saveChatProvider({ kind: CLOUD.provider, apiKey: KEY ?? "", modelId: MODEL });
    const folderId = await withDocuments(core, call);
    const meeting = await core.createMeeting({ folderId });
    const client = await connectToMind(core, meeting.mindId);
    if (call.notes.length > 0) writeMind(client, call.notes);
    await client.settled();
    const typed = unitsOf(readMind(client)).map((each) => each.text);
    const typedNote = readMind(client).toJSON();
    observation?.capture({ original_note_json: typedNote, data_dir: dataDir });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: !call.microphoneOnly });
    record(20);
    for (const turn of call.turns) {
      record(2_000, [call.microphoneOnly || turn.side === "me" ? "microphone" : "system"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const stoppedAt = performance.now();
    await core.stopMeeting(meeting.id);
    const fill = await settled(core, meeting);
    const fillMs = performance.now() - stoppedAt;
    observation?.capture({ fill, fill_ms: fillMs });
    if (fill.state === "filled") {
      await vi.waitFor(() => expect(unitsOf(readMind(client)).some((each) => each.ai)).toBe(true), {
        timeout: 10_000,
      });
    }
    const doc = readMind(client);
    const filledNote = doc.toJSON();
    observation?.capture({ filled_note_json: filledNote });
    const units = unitsOf(doc);
    const transcript = (await core.listMeetings()).find(
      (each) => each.id === meeting.id,
    )?.transcript;
    const cues = transcript?.savedPath
      ? readVtt(await readFile(transcript.savedPath, "utf8")).cues
      : [];
    observation?.capture({ saved_cues: cues });
    const claimsTitles = (["en", "zh-CN"] as const).map((language) =>
      translate(language, "meetings.fill.section.claims"),
    );
    const inClaims = units.filter((each) => each.ai && claimsTitles.includes(each.section ?? ""));
    const scored = call.facts.map((fact) => ({
      fact,
      ...placements(fact, units, call, cues),
      inClaims: inClaims.reduce((sum, each) => sum + occurrences(fact, each.text), 0),
    }));
    const uncited = units.filter((each) => each.ai && each.citations.length === 0).length;
    let undone = false;
    let undoNote: unknown = null;
    if (fill.state === "filled" && call.requireSections) {
      await core.undoMeetingFill(meeting.id);
      undoNote = readMind(client).toJSON();
      observation?.capture({ undo_note_json: undoNote });
      await vi.waitFor(() => expect(readMind(client).toJSON()).toEqual(typedNote));
      undoNote = readMind(client).toJSON();
      observation?.capture({ undo_note_json: undoNote });
      undone = true;
    }
    return {
      fill,
      doc,
      typed,
      units,
      scored,
      uncited,
      transcript,
      cues,
      undone,
      fillMs,
      dataDir,
      originalNote: typedNote,
      filledNote,
      undoNote,
    };
  } finally {
    core.close();
  }
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

/** The walk's calls with nothing typed: the sections alone, as before #2306, for comparison. */
const UNTYPED = CALLS.filter((call) => call.id.startsWith("walk-")).map((call) => ({
  ...call,
  id: `${call.id}-untyped`,
  notes: [],
}));

const reserved = !LOADER_PREFLIGHT && (KEY || LOCAL_MODEL) ? await loadReservedCalls(PICKED) : [];
const chosen = [...CALLS, ...FINAL_CALLS, ...UNTYPED, ...reserved]
  .filter((call) => !PICKED || PICKED.includes(call.id))
  .map((call) => (USER_NAME ? namedCall(call, USER_NAME) : call));
if (
  STRUCTURED &&
  (chosen.length !== 1 || chosen[0]?.id !== STRUCTURED.call || chosen[0]?.requireSections !== true)
) {
  throw new Error(
    "Strict structured observation requires exactly one section-gated selected call.",
  );
}
let structuredStarted = false;

describe.skipIf(LOADER_PREFLIGHT || (!KEY && !LOCAL_MODEL))(
  "Notes typed in a call, filled in on a real model (#2306)",
  {
    timeout: 900_000,
  },
  () => {
    test.each(chosen)("$id", async (call) => {
      const price = catalogModel(CLOUD.provider, MODEL)?.price;
      if (!price && !LOCAL_MODEL) throw new Error("The selected model has no catalog price.");
      const ledger = createRequestLedger({ model: MODEL, price, strict: STRUCTURED });
      let observation: Observation | null = null;
      let restoreTransport: (() => void) | null = null;
      let assertionsPassed = false;
      const check = (name: V5Check, assertion: () => void) =>
        observation ? observation.check(name, assertion) : assertion();
      try {
        if (STRUCTURED) {
          if (structuredStarted) throw new Error("A structured observation cannot run twice.");
          structuredStarted = true;
          observation = await startObservation(STRUCTURED, ledger);
          restoreTransport = ledger.installTransportGuard();
        }
        const { fill, doc, typed, units, scored, uncited, cues, undone, fillMs } = await run(
          call,
          ledger,
          observation,
        );
        const usage = ledger.usage;
        const userName = call.userName ?? USER_NAME;
        const aiText = units.filter((each) => each.ai).map((each) => each.text);
        const named = userName
          ? {
              settingsName: userName,
              ...nameInRequests(ledger.prompts, userName, [
                ...call.turns.map((turn) => turn.text),
                ...usage.replies.flatMap((reply) => writtenIn(reply.raw)),
              ]),
              rawTokens: rawTokens(units),
              saidInCall: call.turns.some((turn) => turn.text.includes(userName)),
              ourKept: (call.named?.kept ?? []).filter((pattern) =>
                aiText.some((text) => pattern.test(text)),
              ).length,
              // The owner's rule (2026-11-08): "our" for the User's side never becomes their name's.
              ourAsName: aiText.filter((text) =>
                new RegExp(
                  `${literally(userName)}(?:['’]s|\\s*的)\\s*(?:team|studio|group|side|团队|工作室|小组)`,
                  "iu",
                ).test(text),
              ).length,
              possessive: (call.named?.possessive ?? []).filter((pattern) =>
                aiText.some((text) => pattern.test(text)),
              ).length,
            }
          : null;
        const structure = structureOf(doc, call);
        const checks = ledger.prompts.filter((prompt) => !FILL_REQUEST.test(prompt));
        const checkRequests = checks.length;
        // A check's first request is the only one without a reply of the model's in it.
        const claimChecks = checks.filter(
          (prompt) => !prompt.includes('"role":"assistant"'),
        ).length;
        const once = scored.filter((each) => each.count === 1 && each.cited).length;
        const title = (section: "summary" | "decisions" | "actions" | "questions") =>
          call.sectionHeadings?.[section] ??
          translate(call.language, `meetings.fill.section.${section}`);
        const summary = units.filter((each) => each.ai && each.section === title("summary"));
        // The note has the name where the reply has the token.
        const overview = hasGeneratedOverview(
          summary,
          usage.replies.map((reply) =>
            userName ? textWithUserName(reply.text, userName) : reply.text,
          ),
        );
        const decisions = units.filter((each) => each.ai && each.section === title("decisions"));
        const questions = units.filter((each) => each.ai && each.section === title("questions"));
        const counts = {
          decisions: scored.filter((each) => each.fact.kind === "decision" && each.count > 0)
            .length,
          actions: scored.filter((each) => each.fact.kind === "action" && each.count > 0).length,
          duplicates: scored.reduce((sum, each) => sum + Math.max(0, each.count - 1), 0),
          invented: decisions.filter(
            (each) =>
              call.notDecided?.some((pattern) => pattern.test(each.text)) &&
              !call.facts.some((fact) => fact.kind === "decision" && says(fact, each.text)),
          ).length,
          summary: summary.length,
          overview,
          decisionsSection: decisions.length,
          ...actionSectionCounts(units, title("actions"), call, cues),
          machineAddresses: machineAddressLeaks(doc),
          undone,
          decisionsInSection: call.facts.filter(
            (fact) =>
              fact.kind === "decision" &&
              decisions.some(
                (unit) => namesSubject(fact, unit.text) && citesRightly(unit, fact, call, cues),
              ),
          ).length,
          inPlace: scored.filter((each) => each.fact.underLine && each.inPlace).length,
          questions: questions.length,
          omitted: fill.omitted ?? 0,
          unfinishedParts: fill.unfinishedParts ?? 0,
        };
        // The fill's slips (#2306), each beside the positive it mustn't cost.
        const related = (fact: Fact, text: string) =>
          fact.subject
            ? namesSubject(fact, text)
            : parts(fact).some(
                (pattern) => pattern.source !== fact.owner?.source && pattern.test(text),
              );
        const owned = call.facts.filter((fact) => fact.owner);
        const theirTurns = (fact: Fact): Fact => ({
          ...fact,
          said: fact.said.filter((index) => call.turns[index]?.side === "them"),
        });
        // A part that states the unnamed person's fact, or cites their turn, and carries the name.
        // The Summary is left out: it speaks for the whole call, and may name who the call was with.
        const misattributed = call.facts.flatMap((fact) => {
          const unit = units.find(
            (unit) =>
              unit.ai &&
              !summary.includes(unit) &&
              fact.notBy?.test(unit.text) === true &&
              (says(fact, unit.text) || citesRightly(unit, theirTurns(fact), call, cues)),
          );
          return unit ? [{ fact: fact.name, text: unit.text }] : [];
        });
        const slips = {
          statedAsDecisions: call.facts.filter(
            (fact) => fact.stated && decisions.some((unit) => says(fact, unit.text)),
          ).length,
          stated: call.facts.filter((fact) => fact.stated).length,
          acceptedInSection: call.facts.filter((fact) =>
            decisions.some((unit) => fact.accepted?.test(unit.text) === true),
          ).length,
          accepted: call.facts.filter((fact) => fact.accepted).length,
          decisionsInSection: counts.decisionsInSection,
          decisions: call.facts.filter((fact) => fact.kind === "decision").length,
          unnamed: owned.filter((fact) =>
            units.some(
              (unit) =>
                unit.ai &&
                related(fact, unit.text) &&
                fact.forbid?.test(unit.text) === true &&
                fact.owner?.test(unit.text) === false,
            ),
          ).length,
          named: owned.filter((fact) =>
            units.some(
              (unit) =>
                unit.ai &&
                says(fact, unit.text) &&
                fact.owner?.test(unit.text) === true &&
                fact.forbid?.test(unit.text) !== true,
            ),
          ).length,
          misheard: units.filter(
            (unit) => unit.ai && call.facts.some((fact) => fact.misheard?.test(unit.text) === true),
          ).length,
          owned: owned.length,
          misattributed: misattributed.length,
          unowned: call.facts.filter((fact) => fact.notBy).length,
          unownedWritten: scored.filter((each) => each.fact.notBy && each.count > 0).length,
          restated: scored
            .filter((each) => each.fact.kind === "decision")
            .reduce((sum, each) => sum + Math.max(0, each.count - 1), 0),
        };
        if (REPORT) {
          const rows = scored
            .map(
              ({ fact, count, inClaims, cited, inPlace }) =>
                `| ${fact.kind} | ${fact.name} | ${count} | ${cited ? "yes" : "no"} | ${inClaims} | ${fact.underLine ? (inPlace ? "yes" : "no") : "—"} |`,
            )
            .join("\n");
          await appendFile(
            REPORT,
            ledger.sanitize(
              [
                `## ${call.id} · ${MODEL}`,
                "",
                `Once and cited rightly: ${once} of ${call.facts.length}. AI parts without a Citation: ${uncited}. Fill: ${fill.state}${fill.problem ? ` (${fill.problem.message})` : ""}.`,
                `Tokens: ${usage.calls} requests, ${usage.input} in (${usage.cached} cached, ${usage.written} written to the cache), ${usage.output} out: $${usage.dollars.toFixed(4)}.`,
                `Request settlement: ${ledger.snapshot().unsettled_requests} unsettled; amounts above are known subtotals, not free unknown usage.`,
                `Replies: ${usage.replies.map((reply) => `${reply.output} out (${reply.reasoning} thinking), Tools: ${reply.tools.join(", ") || "none"}`).join("; ")}.`,
                `Counts: ${JSON.stringify({ call: call.id, model: MODEL, scoring: "cue-owner-subject-placement-structure-v6", dollars: usage.dollars, claimChecks, checkRequests, fillMs, once, total: call.facts.length, ...counts })}`,
                `Structure (#2306): ${JSON.stringify(structure)}`,
                `Slips (#2306): ${JSON.stringify(slips)}`,
                ...(misattributed.length > 0
                  ? [`Misattributed (#2306): ${JSON.stringify(misattributed)}`]
                  : []),
                ...(named ? [`Named (#2306): ${JSON.stringify(named)}`] : []),
                "Occurrence counts use component-match minima and can miss partial or anaphoric repeats. Subject-only matches do not add to these counts. An independent raw duplicate and topic audit is still required, including redundant deadline restatements and action references without declared subjects.",
                `Transcript cues: ${JSON.stringify(cues)}`,
                "",
                "| Kind | Fact | Times in the note | Cited rightly | In the claims list | In place |",
                "|---|---|---|---|---|---|",
                rows,
                "",
                "```",
                shownNote(doc),
                "```",
                ...(fill.state === "filled" && once === call.facts.length
                  ? []
                  : [
                      `Citation details: ${JSON.stringify(units.map((unit) => ({ text: unit.text, citations: unit.citations })))}`,
                    ]),
                "",
                ...(fill.state === "filled" && !process.env.INCARNAMIND_LIVE_REPLIES
                  ? []
                  : usage.replies.flatMap((reply, index) => [
                      `Reply ${index + 1}: ${reply.output} tokens out, ${reply.reasoning} reasoning, Tools: ${reply.tools.join(", ") || "none"}.`,
                      "```",
                      reply.raw,
                      "```",
                      "",
                    ])),
              ].join("\n"),
            ),
          );
        }
        expect(fill.state).toBe("filled");
        // The User's own lines, as typed, in their order.
        check("original_preserved", () =>
          expect(units.filter((each) => !each.ai).map((each) => each.text)).toEqual(typed),
        );
        check("all_facts_present", () =>
          expect(scored.filter((each) => each.count === 0).map((each) => each.fact.name)).toEqual(
            [],
          ),
        );
        check("in_place", () => {
          expect(
            scored.filter((each) => !each.inPlace).map((each) => each.fact.name),
            "Agreed facts fill out their typed lines in place",
          ).toEqual([]);
        });
        if (call.requireSections) {
          expectCompleteFill(fill);
          check("machine_addresses", () =>
            expect(counts.machineAddresses, "No machine L/H/F addresses in generated prose").toBe(
              0,
            ),
          );
          check("undo", () => expect(undone).toBe(true));
          check("overview", () => {
            expect(summary.length, "Summary is present").toBeGreaterThan(0);
            expect(
              overview,
              "The generated overview was placed, not just details under a Summary heading",
            ).toBe(true);
          });
          const expected = call.facts.filter((fact) => fact.kind === "decision").length;
          check("decisions", () => {
            expect(decisions.length > 0, "Decisions only when the call decided something").toBe(
              expected + slips.accepted > 0,
            );
            expect(counts.decisionsInSection).toBe(expected);
            expect(slips.acceptedInSection, "A term accepted aloud is a decision").toBe(
              slips.accepted,
            );
            expect(counts.invented).toBe(0);
          });
          const expectedActions = call.facts.filter((fact) => fact.kind === "action").length;
          check("actions", () => {
            expect(counts.actionsSection > 0, "Actions only when the call has commitments").toBe(
              expectedActions > 0,
            );
            expect(
              counts.actionsInSection,
              "Every action has a cited task reference in Actions",
            ).toBe(expectedActions);
          });
          check("questions", () => {
            if (call.openQuestions !== undefined)
              expect(
                questions.length > 0,
                "Open questions only when the call explicitly left one unanswered",
              ).toBe(call.openQuestions);
          });
          check("once", () =>
            expect(once, "Every fact occurs once with the right Citation").toBe(call.facts.length),
          );
          check("citations", () => {
            expect(uncited).toBe(0);
            expect(scored.every((each) => each.cited)).toBe(true);
          });
          const headings: string[] = [];
          doc.forEach((block) => {
            if (block.type.name === "heading") headings.push(block.textContent);
          });
          check("headings", () => {
            for (const text of Object.values(call.sectionHeadings ?? {})) {
              expect(headings.filter((heading) => heading === text)).toHaveLength(1);
              expect(units.some((unit) => unit.ai && unit.section === text)).toBe(true);
            }
          });
          check("structure", () => {
            expect(slips.statedAsDecisions, "A stated figure is never a decision").toBe(0);
            expect(slips.misheard, "A name the User typed is never written as misheard").toBe(0);
            expect(
              slips.misattributed,
              "What someone unnamed said never carries another person's name",
            ).toBe(0);
            expect(structure.summaryFirst, "Summary is the first part added").toBe(true);
            expect(structure.summaryParts, "Summary is one overview").toBe(1);
            expect(structure.summaryCited, "The overview is a cited paragraph").toBe(true);
            expect(structure.summarySentences).toBeGreaterThanOrEqual(2);
            expect(structure.summarySentences).toBeLessThanOrEqual(3);
            expect(structure.topics.length, "At most six topics").toBeLessThanOrEqual(6);
            if (call.notes.length === 0) {
              expect(
                structure.topics.length,
                "A note with no typed lines has topics",
              ).toBeGreaterThan(0);
              expect(structure.topicsMissing, "Each of the call's topics has a heading").toEqual(
                [],
              );
            }
            expect(structure.topicNotBullets, "A topic's facts are bullets").toBe(0);
            expect(
              structure.topicSentences.filter((count) => count > 2),
              "A topic's bullets are short, not paragraphs",
            ).toEqual([]);
            expect(structure.topicUncited, "Every topic bullet is cited").toBe(0);
            expect(structure.topicPointers, "A topic holds facts, not pointers").toBe(0);
            expect(structure.sectionNotBullets, "A section's items are bullets").toBe(0);
            expect(structure.sectionUncited).toBe(0);
            expect(structure.emptyHeadings, "No heading is added without content").toEqual([]);
            // A Note in no Folder, with no scope chosen, is never checked (#2306).
            const scoped = call.documents !== undefined && !process.env.INCARNAMIND_LIVE_LIBRARY;
            if (!scoped) expect(structure.claimsList, "Nothing in scope, no claims list").toBe(0);
            expect(structure.claimsKeptListed, "What the Documents hold isn't listed").toEqual([]);
            expect(structure.claimsListed, "What they don't hold is listed").toEqual(
              scoped ? (call.claims?.listed ?? []) : [],
            );
          });
        }
        check("named", () => {
          expect(rawTokens(units), "No token is left in the note").toBe(0);
          if (!named) return;
          expect(named.outside, "The app's own words never carry the User's name").toBe(0);
          if (!named.saidInCall)
            expect(named.holding, "A Settings name never said in the call is never sent").toBe(0);
          expect(named.ourAsName, "Our never becomes the User's name's").toBe(0);
          expect(named.possessive, "My becomes the name's").toBe(
            call.named?.possessive.length ?? 0,
          );
        });
        if (STRUCTURED) ledger.assertSettled();
        assertionsPassed = true;
      } finally {
        try {
          await observation?.finish(assertionsPassed);
        } finally {
          restoreTransport?.();
        }
      }
    });
  },
);
