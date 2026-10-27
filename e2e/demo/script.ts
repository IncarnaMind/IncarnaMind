/**
 * What the README recording shows and says, in each language: the workspace's names, the draft,
 * the Questions, the captions and the call. Everything the app answers is the app's own: nothing
 * here is an answer.
 */
import { translate } from "../../src/shared/i18n";
import type { DemoLanguage } from "./documents";

export interface Block {
  type: "heading1" | "heading2" | "paragraph";
  text: string;
}

interface FolderScript {
  name: string;
  description: string;
}

export interface CallLine {
  side: "them" | "me";
  text: string;
}

export interface DemoScript {
  language: DemoLanguage;
  /** The README this recording is for. */
  readme: string;
  /** The shipped examples' Documents, by file name, in this language's folder of them. */
  credit: { source: "credit/en" | "credit/zh-CN" };
  folders: { credit: FolderScript; contracts: FolderScript };
  /** The synced drive the lenders' folder sits in, so the linked folder reads as one from work. */
  sharedDrive: string;
  /** The folder on disk the lenders' new Documents arrive in, which is linked. */
  lenders: string;
  /** The Folder the exported file is saved in, which the Saved line names. */
  outputFolder: string;
  /** The Mind the term sheets are compared in, in the Contracts Folder. */
  options: { title: string; intro: string };
  paper: { title: string; blocks: Block[] };
  /** The figure the draft gets wrong, as the draft writes it and as the Document does. */
  wrong: { draft: string; document: string };
  /** Asked before the recording, to give the draft a cited paragraph to build on. */
  seedQuestion: string;
  /** The Question of the Answer scene, typed at its first frame. */
  question: string;
  /** The Question the paper is asked: Python Analysis over the workbook, then its table and chart. */
  chartRequest: string;
  compareQuestions: string[];
  /** The line the User types in the notes before the call, which the filled notes go under. */
  callNote: string;
  /** What each side says, in order: the expert, then the User, then the drift. */
  call: { lines: readonly CallLine[]; voices: { them: string; me: string } };
  captions: {
    hook: string;
    organize: string;
    ask: string;
    click: string;
    working: string;
    compare: string;
    addToNote: string;
    chart: string;
    call: string;
    notCovered: string;
    callNotes: string;
    check: string;
    fixed: string;
    export: string;
  };
  endCard: { lines: string[] };
  /** What the interface calls things the recording points at. */
  words: {
    contradicted: RegExp;
    saved: string;
    /** A footnote of the exported file: the last source it cites. */
    footnote: RegExp;
    /** What an Answer says when its model has failed at the job: a take with it is not kept. */
    failed: RegExp;
    /** What the transcript of the call must have heard: the expert's own words. */
    heard: RegExp;
    /** The promise the call must hold before it stops: what the expert will send, and when. */
    friday: RegExp;
    /** Talk that has drifted off the guide, the line Not covered yet answers. */
    drift: RegExp;
    me: string;
    filled: string;
    /** The call help buttons, as the app names them: the interview template's two. */
    followUp: string;
    notCovered: string;
    /** The template's command in ⌘K, in this language. */
    templateCommand: string;
    checkCommand: string;
    compareCommand: string;
    recordCommand: string;
    foldCommand: string;
    /** What is typed in ⌘K to find each command: the start of its name. */
    typed: { check: string; compare: string; record: string };
  };
}

export const SCRIPTS: Record<DemoLanguage, DemoScript> = {
  en: {
    language: "en",
    readme: "README.md",
    credit: { source: "credit/en" },
    folders: {
      credit: {
        name: "Northwind credit review",
        description: "Northwind Retail’s results and its senior facilities agreement.",
      },
      contracts: {
        name: "Contracts",
        description: "Term sheets and agreements from lenders.",
      },
    },
    sharedDrive: "Shared drive",
    lenders: "Lender documents",
    outputFolder: "Committee papers",
    options: { title: "Refinancing options", intro: "Three banks sent term sheets." },
    paper: {
      title: "Credit committee paper",
      blocks: [
        { type: "heading1", text: "Credit committee paper" },
        { type: "paragraph", text: "Draft for the credit committee." },
        { type: "heading2", text: "Recommendation" },
        {
          type: "paragraph",
          text: "Hold the facility at its current limit and ask Northwind for a monthly margin report.",
        },
        { type: "heading2", text: "Why" },
        {
          type: "paragraph",
          text: "Group revenue was £1,284 million in the third quarter, up 4.2% on a year earlier. Gross margin fell to 36.8% in Q3, mostly in online. Net debt was £1,190 million on 26 September 2026.",
        },
        { type: "paragraph", text: "Underlying EBITDA fell 18.6% on a year earlier." },
        { type: "heading2", text: "Covenant" },
      ],
    },
    wrong: { draft: "36.8", document: "38.6" },
    seedQuestion:
      "In two sentences: what leverage limit does the facilities agreement set, and what was Northwind’s leverage at the end of Q3?",
    question:
      "Using the documents: what was Northwind’s group gross margin in Q3, and what did the results blame?",
    chartRequest:
      "Use Python Analysis on Northwind Retail’s monthly sales workbook to check the 2026 sales by region. Then add a bar chart of 2026 sales by region to this Note, with its cited table.",
    compareQuestions: ["Margin", "Tenor", "Leverage covenant"],
    callNote: "Northwind Retail expert interview",
    call: {
      lines: [
        {
          side: "them",
          text: "I visit Northwind’s stores every month, usually on a Tuesday or a Thursday. I walk the floor, look at the tills and talk to the managers.",
        },
        { side: "me", text: "Thanks for making the time today." },
        {
          side: "them",
          text: "Since they began closing an hour earlier, store traffic has fallen most after four in the afternoon. The shops near the station have lost more visits than the ones in the suburbs. Online orders look steadier, but I can’t tell you whether they make up the difference.",
        },
        {
          side: "me",
          text: "I know that station well. Before I moved, I used to wait in the cafe by the entrance every week. The bakery next door has gone, and the whole corner is being rebuilt now, so I wonder how long the work will take.",
        },
        {
          side: "them",
          text: "The station works are due to finish in March, though the council has moved that date twice already. The managers near the station told me they are counting the days.",
        },
        {
          side: "me",
          text: "That is helpful. Could you send me the station stores’ monthly footfall figures by Friday? The committee meets on Monday.",
        },
        {
          side: "them",
          text: "Yes, I’ll send them on Friday. They go back to January last year, so you’ll see the change week by week.",
        },
      ],
      voices: { them: "Daniel", me: "Samantha" },
    },
    captions: {
      hook: "The memo says 36.8%. The Q3 results say 38.6%.",
      organize: "Monday. Files everywhere. Link the folders, and it reads and sorts them.",
      ask: "What was the margin? Don’t take its word. Click.",
      click: "Click it. The quote lights up on the page.",
      fixed: "Wrong figure caught. Fixed in one click.",
      working: "Calculations show their working too.",
      compare: "Three banks, one table.",
      addToNote: "It drafts from your files. Grey is the AI’s, and you can undo it.",
      chart: "Analyse the spreadsheet. Every bar links to its cell.",
      call: "An expert call. It suggests the next question.",
      notCovered: "Drifting? See what your guide hasn’t covered.",
      callNotes: "After the call, notes that cite what was said.",
      check: "Check the whole memo against your files.",
      export: "Send it as Word. Footnotes and sources go with it.",
    },
    endCard: {
      lines: ["Free and open source · macOS, Windows, Linux", "github.com/IncarnaMind/IncarnaMind"],
    },
    words: {
      contradicted: /Contradicted/,
      failed: /couldn.t calculate|could not calculate|can.t calculate|unable to calculate/i,
      saved: "Saved",
      footnote: /Q3 2026 results, p\./,
      heard: /traffic[\s\S]*(afternoon|four)/i,
      friday: /Friday/i,
      drift: /station works/i,
      me: "Me",
      filled: "Note filled in",
      followUp: translate("en", "meetings.help.followUp"),
      notCovered: translate("en", "meetings.help.notCovered"),
      templateCommand: translate("en", "meetings.template.command", {
        name: translate("en", "meetings.template.interview"),
      }),
      checkCommand: "Check this note",
      compareCommand: "Compare Documents…",
      recordCommand: "Record a meeting",
      foldCommand: "Assistant: Fold",
      typed: { check: "Check this", compare: "Compare", record: "Record a" },
    },
  },
  "zh-CN": {
    language: "zh-CN",
    readme: "README.zh-CN.md",
    credit: { source: "credit/zh-CN" },
    folders: {
      credit: {
        name: "Northwind 授信审阅",
        description: "Northwind 的季度业绩公告，以及现有的优先级贷款协议。",
      },
      contracts: {
        name: "合同",
        description: "各家银行新发来的再融资条款清单（报价），以及其他合同。",
      },
    },
    sharedDrive: "共享盘",
    lenders: "贷款方文件",
    outputFolder: "授信委员会文件",
    options: { title: "再融资方案", intro: "三家银行发来了条款清单。" },
    paper: {
      title: "授信委员会报告",
      blocks: [
        { type: "heading1", text: "授信委员会报告" },
        { type: "paragraph", text: "供授信委员会审阅的草稿。" },
        { type: "heading2", text: "建议" },
        { type: "paragraph", text: "维持现有授信额度，并要求 Northwind 每月提供毛利率报告。" },
        { type: "heading2", text: "理由" },
        {
          type: "paragraph",
          text: "第三季度集团收入为 12.84 亿英镑，同比增长 4.2%。第三季度毛利率降至 36.8%，主要拖累来自线上业务。2026 年 9 月 26 日的净债务为 11.90 亿英镑。",
        },
        { type: "paragraph", text: "基础 EBITDA 同比下降 18.6%。" },
        { type: "heading2", text: "杠杆率约定" },
      ],
    },
    wrong: { draft: "36.8", document: "38.6" },
    seedQuestion:
      "用两句话回答，不要加粗：贷款协议规定的杠杆率上限是多少，第三季度末 Northwind 的杠杆率是多少？",
    question: "根据文档回答：Northwind 第三季度集团毛利率是多少，业绩把原因归在哪里？不要加粗。",
    chartRequest:
      "用 Python 数据分析核对 Northwind Retail 月度销售工作簿里 2026 年各地区销售额，然后在这篇笔记中加入 2026 年各地区销售额的柱状图和带引用的表格。不要加粗。",
    compareQuestions: ["利差", "期限", "杠杆率约定"],
    callNote: "Northwind Retail 专家访谈",
    call: {
      lines: [
        {
          side: "them",
          text: "我每个月都会去 Northwind 的门店，通常是周二或周四。我会在店里走一圈，看看收银台，也跟店长聊几句。",
        },
        { side: "me", text: "谢谢你今天抽时间。" },
        {
          side: "them",
          text: "自从提前一个小时关门以后，下午四点以后的门店客流减少得最明显。车站附近的门店比郊区少得更多。线上订单看起来稳定一些，但我不能确定能不能弥补门店的损失。",
        },
        {
          side: "me",
          text: "那个车站我也很熟。搬家以前，我每个星期都会在入口旁边的咖啡馆等一会儿。旁边的面包店已经搬走了，整个路口都在重建，不知道要修到什么时候。",
        },
        {
          side: "them",
          text: "车站的施工原定三月完工，不过市政已经把日期推后过两次。车站附近的店长跟我说，他们都在数着日子。",
        },
        {
          side: "me",
          text: "很有用。能不能请你周五前把车站附近门店的月度客流数据发给我？委员会周一开会。",
        },
        {
          side: "them",
          text: "可以，我周五发给你。数据从去年一月开始，每周的变化都看得出来。",
        },
      ],
      voices: { them: "Eddy (Chinese (China mainland))", me: "Tingting" },
    },
    captions: {
      hook: "报告里写 36.8%，Q3 业绩里是 38.6%。",
      organize: "周一，文件散在各处。关联文件夹，它读进来并分好类。",
      ask: "毛利率是多少？别信它说的，点开看。",
      click: "点一下，引文在原页上亮起来。",
      fixed: "错数被拦下，一键改正。",
      working: "算出来的数也摆出算式和出处。",
      compare: "三家银行，一张表。",
      addToNote: "根据你的文件起草。灰字是 AI 写的，可以撤销。",
      chart: "分析表格，每根柱子都连到它的单元格。",
      call: "专家访谈，它帮你想好下一个问题。",
      notCovered: "聊偏了？看看提纲里还有什么没聊到。",
      callNotes: "通话结束，纪要里每一点都标出原话。",
      check: "整份报告对照你的文件核对。",
      export: "导出成 Word，脚注和出处都在。",
    },
    endCard: {
      lines: ["免费开源 · macOS、Windows、Linux", "github.com/IncarnaMind/IncarnaMind"],
    },
    words: {
      contradicted: /与文档矛盾/,
      failed: /(无法|没能|未能|不能)(计算|算出)/,
      saved: "已保存",
      footnote: /2026 年第三季度业绩/,
      heard: /(下午|四点)[\s\S]*(客流|门店)/,
      friday: /周五/,
      drift: /车站/,
      me: "我",
      filled: "已补全笔记",
      followUp: translate("zh-CN", "meetings.help.followUp"),
      notCovered: translate("zh-CN", "meetings.help.notCovered"),
      templateCommand: translate("zh-CN", "meetings.template.command", {
        name: translate("zh-CN", "meetings.template.interview"),
      }),
      checkCommand: "核对此笔记",
      compareCommand: "对比文档…",
      recordCommand: "录制会议",
      foldCommand: "助手：收起",
      typed: { check: "核对此", compare: "对比文档", record: "录制会议" },
    },
  },
};
