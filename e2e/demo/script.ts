/**
 * What the README recording shows and says, in each language: the workspace's names, the draft,
 * the Questions, the captions and the call. Everything the app answers is the app's own: nothing
 * here is an answer.
 */
import type { DemoLanguage } from "./documents";

export interface Block {
  type: "heading1" | "heading2" | "paragraph";
  text: string;
}

interface FolderScript {
  name: string;
  description: string;
}

export interface DemoScript {
  language: DemoLanguage;
  /** The README this recording is for. */
  readme: string;
  /** The shipped examples' Documents, by file name, in this language's folder of them. */
  credit: { source: "credit/en" | "credit/zh-CN" };
  folders: { credit: FolderScript; contracts: FolderScript };
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
  /** What the Answer is asked for in the paper, and its chart. */
  chartRequest: string;
  compareQuestions: string[];
  /** The line the User types in the notes during the call. */
  callNote: string;
  /** What each side says: the other side asks, the User answers in one line. */
  call: { them: string; me: string; voices: { them: string; me: string } };
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
    callNotes: string;
    check: string;
    export: string;
  };
  endCard: { lines: string[]; audience: string };
  /** What the interface calls things the recording points at. */
  words: {
    contradicted: RegExp;
    saved: string;
    /** A footnote of the exported file: the last source it cites. */
    footnote: RegExp;
    /** What an Answer says when its model has failed at the job: a take with it is not kept. */
    failed: RegExp;
    /** What the transcript of the call must have heard: the two figures. */
    heard: RegExp;
    me: string;
    filled: string;
    answerTheirQuestion: string;
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
    question: "Is Northwind inside its leverage covenant?",
    chartRequest: "Make a bar chart of gross margin by segment",
    compareQuestions: ["Margin", "Tenor", "Leverage covenant"],
    callNote: "Covenant headroom",
    call: {
      them: "Before we go on, how much headroom is there under the leverage covenant at the moment?",
      me: "We are at three point one times against a limit of three point five.",
      voices: { them: "Daniel", me: "Samantha" },
    },
    captions: {
      hook: "The paper says 36.8%. The Q3 results say 38.6%.",
      organize: "Monday, 9:12. New lender documents. Organize suggests Folders and Tags.",
      ask: "Is Northwind inside its covenant? Don’t take its word. Click.",
      click: "Click it. The quote lights up on the page.",
      working: "Even the maths shows its working.",
      compare: "Three banks, one table.",
      addToNote: "Add it to the paper. Grey text is the AI’s.",
      chart: "A chart from the same numbers.",
      call: "A lender asks about headroom. It answers, with the page.",
      callNotes: "The notes cite what was said, and when.",
      check: "Check the whole paper. That wrong number gets caught.",
      export: "Send it as Word. The sources go with it.",
    },
    endCard: {
      lines: [
        "Don’t trust the AI. Click the source.",
        "Every answer shows the page it came from.",
        "Free, open source, runs on your computer.",
        "github.com/IncarnaMind/IncarnaMind",
      ],
      audience:
        "For analysts, lawyers and engineers who write from documents and stand behind every figure.",
    },
    words: {
      contradicted: /Contradicted/,
      failed: /couldn.t calculate|could not calculate|can.t calculate|unable to calculate/i,
      saved: "Saved",
      footnote: /Q3 2026 results, p\./,
      heard: /(3\.1|three point one)[\s\S]*(3\.5|point five)/i,
      me: "Me",
      filled: "Note filled in",
      answerTheirQuestion: "Answer their question",
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
      "用两句话回答：贷款协议规定的杠杆率上限是多少，第三季度末 Northwind 的杠杆率是多少？",
    question: "Northwind 有没有超出杠杆率条款的限制？",
    chartRequest: "画一个各业务板块毛利率的柱状图",
    compareQuestions: ["利差", "期限", "杠杆率约定"],
    callNote: "杠杆率还有多少余地",
    call: {
      them: "我们先确认一个问题：现在的杠杆率，离贷款协议的上限还有多少空间？",
      me: "现在的杠杆率是三点一倍，上限是三点五倍。",
      voices: { them: "Eddy (Chinese (China mainland))", me: "Tingting" },
    },
    captions: {
      hook: "报告里写 36.8%，Q3 业绩里是 38.6%。",
      organize: "周一 9:12，贷款方发来新文件。“整理”建议文件夹和标签。",
      ask: "Northwind 超限了吗？别信它说的，点开看。",
      click: "点一下，引文在原页上亮起来。",
      working: "连算式都摆给你看。",
      compare: "三家银行，一张表。",
      addToNote: "加进报告。灰色的字是 AI 写的。",
      chart: "图表用的是同一批数字。",
      call: "贷款方问还剩多少空间，它直接答，还带着出处。",
      callNotes: "笔记引用通话里说的话，连时间都有。",
      check: "整份报告核对一遍，那个错数被拦住了。",
      export: "导出成 Word，出处跟着走。",
    },
    endCard: {
      lines: [
        "别信 AI，点开出处看。",
        "每个回答都标出它来自哪一页。",
        "免费开源，在你自己的电脑上运行。",
        "github.com/IncarnaMind/IncarnaMind",
      ],
      audience: "适合靠文件写报告、要对每个数字负责的分析师、律师和工程师。",
    },
    words: {
      contradicted: /与文档矛盾/,
      failed: /(无法|没能|未能|不能)(计算|算出)/,
      saved: "已保存",
      footnote: /2026 年第三季度业绩/,
      heard: /(3\.1|三点一)[\s\S]*(3\.5|点五)/,
      me: "我",
      filled: "已补全笔记",
      answerTheirQuestion: "回答对方的问题",
      checkCommand: "核对此笔记",
      compareCommand: "对比文档…",
      recordCommand: "录制会议",
      foldCommand: "助手：收起",
      typed: { check: "核对此", compare: "对比文档", record: "录制会议" },
    },
  },
};
