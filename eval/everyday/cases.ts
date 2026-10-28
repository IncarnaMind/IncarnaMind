/**
 * The everyday requests (README.md): what Users ask the assistant every day,
 * in English and Chinese, beside a Mind or not, about their Documents or
 * their own text. The owner's own conversation comes first. Each says what
 * its Answer must do; `checks.ts` holds every Answer to it.
 */
import type { Expected } from "./checks";

/**
 * The Documents a request is asked over: two arXiv papers, the repository's seven sample PDFs,
 * contracts and minutes whose files' dates are none of their text's (./dated), the table of
 * China's official reserve assets, whose cells give a difference (#1444), or a leverage covenant
 * folder in English or Chinese (./cedar, #1796).
 */
export type LibraryName =
  | "papers"
  | "reports"
  | "dated"
  | "reserves"
  | "cedar"
  | "cedar-zh"
  | "filings";

export interface EverydayCase {
  id: string;
  language: "en" | "zh-CN";
  library: LibraryName;
  /** The Mind it is asked from, its Blocks in Markdown-ish lines ("## " a heading); null: none in focus. */
  mind: { title: string; blocks: readonly string[] } | null;
  /** The whole Mind is selected as it is asked. */
  selectAll?: boolean;
  /** A Word file of these paragraphs (the first its title) is imported as the Mind it is asked from, in place of `mind`. */
  word?: { name: string; paragraphs: readonly string[] };
  /** The example's Answer, written in advance, is the conversation's first turn, in the case's language. */
  afterExample?: true;
  /** With `afterExample`: asked from the example's own Mind, where the User stays, instead of from a Mind of its own. */
  inExample?: true;
  /** With `afterExample`: `before` is asked from the example's own Mind, as a newcomer does before opening a page of their own. */
  beforeInExample?: true;
  /** Asked first, in the same conversation, and not checked. */
  before?: readonly string[];
  /** The last of `before` is put into the Mind with Add to note, as a whole Answer, before the request. */
  addToNote?: true;
  request: string;
  expected: Expected;
  /** Hard enough to ask Claude Sonnet 5.5 as well (INCARNAMIND_EVAL_EVERYDAY=hard). */
  hard?: boolean;
  /** An inference is tempting: the app's own check judges each of its cited sentences (./support). */
  research?: true;
  /** A summary: the report counts its sentences outside headings that carry a Citation (./dates). */
  summary?: true;
  /** What the model's first reply is, in place of its own, so the app must ask again (./reasks). */
  firstReply?: string;
  /** The Documents open on screen, by name, the focused group's first, as the composer sends them (#1334). */
  onScreen?: readonly string[];
  /**
   * Asked first in a conversation of its own, its Answer put into the Mind with Add to note and
   * selected: the request is then asked in a new conversation, with that selection (#1334).
   */
  selectNote?: string;
  /** When the assistant asks the User which (ask_user), they choose the option that names this; without it, the Answer stops at its question. */
  answerAsk?: string;
  /**
   * Words selected on a page of a Document to ask about ("Ask about this", #101), cited as the
   * viewer cites them: the Answer's first Citation must be them, found there.
   */
  quote?: { document: string; page: number; words: string };
}

/** The share of its runs a request must pass: two in three, one in three for a hard one. */
export const floorOf = (each: EverydayCase): number => (each.hard ? 1 / 3 : 2 / 3);

const ANSWER = { write: false, cite: true, coverAll: false } as const;
const WRITE = { write: true, cite: true, coverAll: false } as const;
const WRITE_ALL = { write: true, cite: true, coverAll: true } as const;
const EDIT = { write: true, cite: false, coverAll: false } as const;
const NOTHING = { write: false, cite: false, coverAll: false } as const;
// It names nothing to produce: answered in the panel or written into a Mind, either passes (#1559).
const EITHER = { write: false, cite: true, coverAll: false, either: true } as const;
const EITHER_ALL = { ...EITHER, coverAll: true } as const;
const EMPTY = { title: "", blocks: [] };
const ABOUT_THE_QUESTION = {
  write: false,
  cite: false,
  coverAll: false,
  noEarlier: true,
  standsAlone: true,
  noExample: true,
} as const;
const TEXT_DATES = { write: false, cite: true, coverAll: false, textDates: true } as const;
// The contracts and minutes have English and Chinese versions in the set: the reply follows the Question's language (#1273).
const TEXT_DATES_EN = { ...TEXT_DATES, language: "en" } as const;
const TEXT_DATES_ZH = { ...TEXT_DATES, language: "zh-CN" } as const;

// The trap of #1796: asked to recompute with the calculation Tool, a model without it said the
// Tool confirmed its own wrong 3.37x and 15. With the Tool, the figures are 3.26x and 22.5.
const CEDAR_TRAP = {
  ...NOTHING,
  honestTools: true,
  calculated: [/3\.26|3\.3(?!\d)/, /22\.5|2,?250/],
} as const;
// Honest replies the check must leave alone (#1796): a check of figures against the Documents,
// and the denial a model without the calculation Tool is told to write.
const CEDAR_HONEST = { ...NOTHING, honestTools: true } as const;
const CEDAR_FIRST_EN =
  "What is Cedar's leverage at 30 September 2026 under the executed facility's covenant, using the final figures and not the draft or the forecast? Give net debt, EBITDA, the ratio and the headroom to the cap, with Citations.";
const CEDAR_FIRST_ZH =
  "按已签署融资协议的杠杆率契约，用终版数据（不用草稿或预测），雪松控股2026年9月30日的杠杆率是多少？请给出净负债、EBITDA、比率和距上限的空间，并附引用。";
const CEDAR: readonly EverydayCase[] = [
  {
    id: "cedar-trap-en",
    language: "en",
    library: "cedar",
    mind: null,
    before: [CEDAR_FIRST_EN],
    request:
      "Recompute 310/95 and (3.5*95)-310 using the calculation Tool, not mental arithmetic. Is your earlier 3.37x / GBP15m correct? Show checked results and correct the answer.",
    expected: CEDAR_TRAP,
  },
  {
    id: "cedar-trap-zh",
    language: "zh-CN",
    library: "cedar-zh",
    mind: null,
    before: [CEDAR_FIRST_ZH],
    request:
      "用计算工具重新计算 310/95 和 (3.5*95)-310，不要心算。你之前给出的 3.37 倍 / 1,500万英镑 对吗？给出核对后的结果，并更正回答。",
    expected: CEDAR_TRAP,
  },
  {
    id: "cedar-check-en",
    language: "en",
    library: "cedar",
    mind: null,
    before: [CEDAR_FIRST_EN],
    request:
      "Check the net debt and EBITDA you gave against the final figures, not the draft. Do they match?",
    expected: CEDAR_HONEST,
  },
  {
    id: "cedar-check-zh",
    language: "zh-CN",
    library: "cedar-zh",
    mind: null,
    before: [CEDAR_FIRST_ZH],
    request: "把你给出的净负债和EBITDA与终版数据核对一下，不要用草稿。它们一致吗？",
    expected: CEDAR_HONEST,
  },
  {
    id: "cedar-denial-en",
    language: "en",
    library: "cedar",
    mind: null,
    request:
      "Can you use IncarnaMind's calculation Tool here? If not, say so, and give Cedar's 310 / 95 as your own working.",
    expected: CEDAR_HONEST,
  },
  {
    id: "cedar-denial-zh",
    language: "zh-CN",
    library: "cedar-zh",
    mind: null,
    request:
      "你这里能用 IncarnaMind 的计算工具吗？如果不能，请直说，并给出你自己算的雪松控股 310/95。",
    expected: CEDAR_HONEST,
  },
];

const READING_GROUP = {
  title: "Reading group",
  blocks: [
    "## Notes",
    "Wei asked for something short we can hand out before Thursday's reading group.",
    "Still need: what each paper actually claims, and whether the GraphST results hold up.",
  ],
};
const Q3 = {
  title: "Q3 review",
  blocks: [
    "Sales grew in every region this quarter, led by the north.",
    "Margins were thin in the north because shipping got more expensive, and we haven't fixed that yet.",
    "Hiring was slow, and the new office opened late in the year.",
  ],
};
const WEEKLY = {
  title: "周报",
  blocks: [
    "这周我们完成了新版本的测试，大部分问题都修好了。",
    "下周要跟客户开会，聊聊合同的事，顺便看看他们对新功能的想法。",
    "团队里有两个人请假，进度可能会慢一点。",
  ],
};
const TYPOS = {
  title: "Trip notes",
  blocks: [
    "We visted the harbour on tuesday and saw the tide go out compleatly.",
    "The guide said spring tides come twice a month, wich surprised everyone.",
  ],
};
const PENSIONS = {
  title: "Benefits memo",
  blocks: [
    "Staff get 25 days of leave a year, plus bank holidays.",
    "The pension scheme matches contributions up to 5% of salary.",
    "Health cover starts after three months.",
  ],
};
const TYPOS_ZH = {
  title: "港口笔记",
  blocks: [
    "我们周二去了海港，看到潮水彻底退去了，场面十分壮管。",
    "导游说大潮每月会出现两次，这让所有人都很惊呀。",
  ],
};
const READING_GROUP_ZH = {
  title: "读书会",
  blocks: [
    "## 笔记",
    "魏想要一份周四读书会前可以发给大家的简短材料。",
    "还需要：每篇论文到底主张什么。",
  ],
};
const SUPPLY_AGREEMENT = {
  name: "Supply agreement.docx",
  paragraphs: [
    "Supply agreement",
    "Each party's total liability is capped at the fees paid in the twelve months before the claim.",
    "The Buyer pays each invoice within 30 days of receiving it.",
  ],
};
const SUPPLY_AGREEMENT_ZH = {
  name: "供货协议.docx",
  paragraphs: [
    "供货协议",
    "每一方的赔偿责任以索赔前十二个月内已付的费用为限。",
    "买方应在收到每张发票后 30 天内付款。",
  ],
};
const OWNER = ["write a summary page", "make the summary section longer", "no citations?"];

const CONTRACT = "Employment contract";
const CONTRACT_ZH = "劳动合同";
const NDA = "Mutual NDA";
const NDA_ZH = "保密协议";
// A short piece written into the empty Mind it is asked from (#1334).
const SHORT_HERE = { ...WRITE, into: "asked-from", atMostLines: 5 } as const;
const ASKS_WHICH = { ...NOTHING, asks: "must" } as const;
const CALL_NOTES = {
  title: "Call notes",
  blocks: ["Notes for Friday's call with Harbour Logistics."],
};
const CALL_NOTES_ZH = { title: "通话笔记", blocks: ["周五和海港物流通话前的笔记。"] };
const HANDOVER = {
  title: "Handover",
  blocks: [
    "From April the new warehouse supervisor takes over the night shift rota, the weekly stock checks and the Friday report to the operations manager, who will go through the first month of reports with them before they run on their own.",
  ],
};
const HANDOVER_ZH = {
  title: "交接",
  blocks: [
    "从四月起，新的仓库主管接手夜班排班、每周盘点和每周五给运营经理的报告，运营经理会和他一起看第一个月的报告，之后再由他独立负责。",
  ],
};

/**
 * What "this" means (#1334) and adding the last Answer to notes (#1734), over the contracts, the
 * agreements and the minutes: the requests of the re-walk on #1334, with the Documents on screen
 * the composer now sends.
 */
const THIS_DOCUMENT: readonly EverydayCase[] = [
  {
    id: "this-contract-zh",
    language: "zh-CN",
    library: "dated",
    mind: EMPTY,
    onScreen: [CONTRACT_ZH],
    request: "请为这份劳动合同写一个简短的摘要。",
    expected: { ...SHORT_HERE, documents: [CONTRACT_ZH] },
  },
  {
    id: "this-contract-zh-nothing-open",
    language: "zh-CN",
    library: "dated",
    mind: EMPTY,
    request: "请为这份劳动合同写一个简短的摘要。",
    expected: { ...SHORT_HERE, documents: [CONTRACT_ZH], asks: "may" },
  },
  {
    id: "this-contract-en",
    language: "en",
    library: "dated",
    mind: EMPTY,
    onScreen: [CONTRACT],
    request: "Write a short summary of this employment contract.",
    expected: { ...SHORT_HERE, documents: [CONTRACT] },
  },
  {
    id: "this-agreement-en",
    language: "en",
    library: "dated",
    mind: EMPTY,
    onScreen: [NDA],
    request: "Write a short summary of this agreement.",
    expected: { ...SHORT_HERE, documents: [NDA] },
  },
  {
    id: "this-document-en",
    language: "en",
    library: "dated",
    mind: EMPTY,
    onScreen: [NDA],
    request: "Write a short summary of this document.",
    expected: { ...SHORT_HERE, documents: [NDA] },
  },
  {
    id: "this-document-zh",
    language: "zh-CN",
    library: "dated",
    mind: EMPTY,
    onScreen: [NDA_ZH],
    request: "请为这份文件写一个简短的摘要。",
    expected: { ...SHORT_HERE, documents: [NDA_ZH] },
  },
  {
    id: "two-open-en",
    language: "en",
    library: "dated",
    mind: EMPTY,
    onScreen: [CONTRACT, NDA],
    request: "Write a short summary of this document.",
    expected: ASKS_WHICH,
  },
  {
    id: "two-open-zh",
    language: "zh-CN",
    library: "dated",
    mind: EMPTY,
    onScreen: [CONTRACT_ZH, NDA_ZH],
    request: "请为这份文件写一个简短的摘要。",
    expected: ASKS_WHICH,
  },
  {
    id: "two-open-answered-en",
    language: "en",
    library: "dated",
    mind: EMPTY,
    onScreen: [CONTRACT, NDA],
    answerAsk: "NDA",
    request: "Write a short summary of this document.",
    expected: { ...SHORT_HERE, documents: [NDA], asks: "may" },
  },
  {
    id: "selection-nda-en",
    language: "en",
    library: "dated",
    mind: { title: "Vendor notes", blocks: [] },
    selectNote: "What does the mutual NDA say about confidentiality?",
    request: "Summarise this document.",
    expected: { ...EITHER, documents: [NDA] },
  },
  {
    id: "selection-nda-zh",
    language: "zh-CN",
    library: "dated",
    mind: { title: "供应商笔记", blocks: [] },
    selectNote: "保密协议对保密义务是怎么规定的？",
    request: "总结一下这份文件。",
    expected: { ...EITHER, documents: [NDA_ZH] },
  },
  {
    id: "add-to-notes-en",
    language: "en",
    library: "dated",
    mind: CALL_NOTES,
    before: ["How much notice does the employment contract require?"],
    request: "Add this to my notes.",
    expected: { ...EDIT, into: "asked-from", addsAnswer: true },
  },
  {
    id: "add-to-notes-zh",
    language: "zh-CN",
    library: "dated",
    mind: CALL_NOTES_ZH,
    before: ["劳动合同的解除通知期是多久？"],
    request: "把这个加到我的笔记里。",
    expected: { ...EDIT, into: "asked-from", addsAnswer: true },
  },
  {
    id: "notes-on-documents-en",
    language: "en",
    library: "dated",
    mind: CALL_NOTES,
    before: ["How much notice does the employment contract require?"],
    request: "Write notes on these documents.",
    expected: { ...WRITE, addsAnswer: false },
  },
  {
    id: "notes-on-documents-zh",
    language: "zh-CN",
    library: "dated",
    mind: CALL_NOTES_ZH,
    before: ["劳动合同的解除通知期是多久？"],
    request: "为这些文档写笔记。",
    expected: { ...WRITE, addsAnswer: false },
  },
  {
    id: "shorter-this-en",
    language: "en",
    library: "dated",
    mind: HANDOVER,
    selectAll: true,
    onScreen: [CONTRACT],
    request: "Make this shorter.",
    expected: { ...EDIT, only: 0, into: "asked-from", documents: [] },
  },
  {
    id: "shorter-this-zh",
    language: "zh-CN",
    library: "dated",
    mind: HANDOVER_ZH,
    selectAll: true,
    onScreen: [CONTRACT_ZH],
    request: "把这段改短一点。",
    expected: { ...EDIT, only: 0, into: "asked-from", documents: [] },
  },
  {
    id: "this-contract-question-en",
    language: "en",
    library: "dated",
    mind: null,
    request: "How much notice does this contract require?",
    expected: { ...ANSWER, asks: "may" },
  },
];

const ATTENTION = "Weighted Keys Shorter Paths";
const GPT3 = "Demonstrations Not Weights";
const GPT2 = "What a Corpus Teaches";
const HYPER = "Tuning the Tuner";
const MPMA = "MPMA Code of Practice for the Pharmaceutical Industry 2021";
const MASKING =
  "Masking, plus the one-position shift on the output side, keeps each prediction to positions already produced.";
const NO_GRADIENTS =
  "Nothing in these “learning” curves involves a gradient update or a fine-tune — the prompt simply carries more examples.";

/**
 * "Ask about this" (#101): words selected in a Document go with the Question, and its first
 * Citation is them, where they were selected. The same Questions with nothing selected must
 * neither guess nor change anything.
 */
const SELECTED: readonly EverydayCase[] = [
  ...(
    [
      [ATTENTION, 3, MASKING, "What does this mean?"],
      [
        ATTENTION,
        3,
        "A residual connection [1] wraps each sub-layer, and layer normalisation [2] follows it.",
        "Explain this in plain words.",
      ],
      [
        ATTENTION,
        3,
        "Both the encoder and the decoder are built from self-attention and position-wise feed-forward layers.",
        "What does this mean?",
      ],
      [GPT3, 5, NO_GRADIENTS, "What does this mean?"],
      [
        GPT3,
        5,
        "Brellan-220B, for instance, scores 71.2 F1 on the Quill reading set with no examples, 74.8 with one and 77.5 with several.",
        "Is this a big improvement?",
      ],
      [
        GPT3,
        5,
        "Some tasks, however, remain difficult for prompting even at this size.",
        "Which tasks does this mean?",
      ],
      [
        GPT2,
        2,
        "A language model can carry out tasks it was never trained on, in a zero-shot setting – with no change to its parameters or architecture.",
        "What does this mean?",
      ],
      [
        HYPER,
        2,
        "On all three architectures we tried — dense, convolutional and recurrent — the learned optimiser remained stable when its starting hyperparameters were badly chosen, and it became more stable as the stack of optimisers grew.",
        "Explain this in simpler terms.",
      ],
      [
        MPMA,
        12,
        "Companies answer under the Code for what their third parties do within its scope, even where the third party ignored the instructions it was given.",
        "What does this mean for a company?",
      ],
      [
        MPMA,
        12,
        "‘Support’ here means a financial contribution, in whole or in part, paid directly or indirectly so that a health professional or other decision maker can attend an event.",
        "Summarise this in one sentence.",
      ],
    ] as const
  ).map(
    ([document, page, words, request], index): EverydayCase => ({
      id: `selected-en-${index + 1}`,
      language: "en",
      library: "reports",
      mind: null,
      quote: { document, page, words },
      request,
      expected: { ...ANSWER, language: "en" },
    }),
  ),
  ...(
    [
      ["reports", ATTENTION, 3, MASKING, "这句话是什么意思？"],
      ["reports", GPT3, 5, NO_GRADIENTS, "用简单的话解释一下这段。"],
      [
        "dated",
        CONTRACT_ZH,
        1,
        "第六条　解除：任何一方提前三十日书面通知对方，可以解除本合同。",
        "这一条是什么意思？",
      ],
      [
        "dated",
        CONTRACT_ZH,
        1,
        "第二条　合同期限：三年，自乙方入职之日起计算，其中试用期三个月。",
        "用简单的话解释一下这段。",
      ],
    ] as const
  ).map(
    ([library, document, page, words, request], index): EverydayCase => ({
      id: `selected-zh-${index + 1}`,
      language: "zh-CN",
      library,
      mind: null,
      quote: { document, page, words },
      request,
      expected: { ...ANSWER, language: "zh-CN" },
    }),
  ),
  {
    id: "selected-none-en",
    language: "en",
    library: "reports",
    mind: null,
    request: "What does this mean?",
    expected: { ...NOTHING, asks: "may" },
  },
  {
    id: "selected-none-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "这句话是什么意思？",
    expected: { ...NOTHING, asks: "may" },
  },
];

export const CASES: readonly EverydayCase[] = [
  // The owner's own conversation, 2026-10-15.
  {
    id: "owner-1",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: OWNER[0] ?? "",
    expected: WRITE_ALL,
  },
  {
    id: "owner-2",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: OWNER.slice(0, 1),
    request: OWNER[1] ?? "",
    expected: WRITE,
  },
  {
    id: "owner-3",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: OWNER.slice(0, 2),
    request: OWNER[2] ?? "",
    expected: { ...NOTHING, either: true },
  },
  {
    id: "owner-4",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: OWNER,
    request: "I mean write a summary about these 2 papers",
    expected: WRITE_ALL,
    hard: true,
  },
  // Only the paragraph asked about changes (#880's hand check changed the first).
  {
    id: "only-second-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    selectAll: true,
    request: "把第二段改得更正式，其他段落保持不变",
    expected: { ...EDIT, only: 1 },
    hard: true,
  },
  {
    id: "only-second-en",
    language: "en",
    library: "papers",
    mind: Q3,
    selectAll: true,
    request: "Make the second paragraph more formal and leave the other paragraphs as they are",
    expected: { ...EDIT, only: 1 },
    hard: true,
  },
  // Questions about the Documents: answered, cited, nothing changed.
  {
    id: "ask-tutorial",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "What does the tutorial claim?",
    expected: ANSWER,
  },
  {
    id: "ask-tutorial-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    request: "这篇关于随机神经网络的教程主要讲了什么？",
    expected: ANSWER,
  },
  {
    id: "ask-compare",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Compare the two papers' methods",
    expected: EITHER_ALL,
  },
  {
    id: "ask-summarise",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Summarise these papers",
    expected: EITHER_ALL,
  },
  {
    id: "ask-summarise-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    request: "总结一下这两篇论文",
    expected: EITHER_ALL,
  },
  {
    id: "ask-translate-doc",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Translate the abstract of the GraphST paper into Chinese",
    expected: EITHER,
  },
  {
    id: "ask-clarify",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Clarify what the authors of the tutorial mean by product form",
    expected: ANSWER,
  },
  {
    id: "ask-datasets",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Which datasets does GraphST use?",
    expected: ANSWER,
  },
  {
    id: "ask-datasets-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    request: "GraphST 在哪些数据集上做了实验？",
    expected: ANSWER,
  },
  // Text asked for in a Mind.
  {
    id: "write-section",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Add a short section on GraphST's results to my notes",
    expected: { ...WRITE, into: "asked-from" },
  },
  {
    id: "write-section-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    request: "把教程的主要观点加到我的笔记里",
    expected: { ...WRITE, into: "asked-from" },
  },
  {
    id: "write-new-note",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Make a new note with the key numbers from the GraphST paper",
    expected: { ...WRITE, into: "new" },
  },
  {
    id: "write-page-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    request: "写一个总结页面",
    expected: WRITE_ALL,
  },
  {
    id: "write-page-all",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Write a summary page of these documents",
    expected: WRITE_ALL,
  },
  // The app asks the model again inside the turn, its first reply being one it would ask about: nothing the User reads is about that try (#1226).
  {
    id: "reask-write",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Write a summary page of these documents",
    firstReply:
      "Here is a summary of the two documents.\n\n## Summary\n\nThe first document is the paper 2306.10683v1. The second is “A Tutorial about Random Neural Networks in Supervised Learning”.",
    expected: WRITE_ALL,
  },
  {
    id: "reask-write-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP_ZH,
    request: "写一个总结页面",
    firstReply:
      "下面是这两份文档的总结。\n\n## 总结\n\n第一份文档是论文 2306.10683v1，第二份是《A Tutorial about Random Neural Networks in Supervised Learning》。",
    expected: WRITE_ALL,
  },
  {
    id: "reask-claim",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    request: "Add a short section on GraphST's results to my notes",
    firstReply: "I've added a short section on GraphST's results to “Reading group”.",
    expected: WRITE,
  },
  {
    id: "reask-claim-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP_ZH,
    request: "把教程的主要观点加到我的笔记里",
    firstReply: "我已经在“读书会”里添加了教程的主要观点。",
    expected: WRITE,
  },
  // In a new, empty Mind with no name yet, a piece asked for goes into it (#1212).
  {
    id: "write-empty",
    language: "en",
    library: "papers",
    mind: EMPTY,
    request: "Write a short summary of the GraphST paper.",
    expected: { ...WRITE, into: "asked-from" },
  },
  {
    id: "write-empty-zh",
    language: "zh-CN",
    library: "papers",
    mind: EMPTY,
    request: "帮我写一份 GraphST 论文的简短摘要。",
    expected: { ...WRITE, into: "asked-from" },
  },
  // The User's own text, changed.
  {
    id: "edit-shorten",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Shorten the second paragraph",
    expected: { ...EDIT, only: 1 },
  },
  {
    id: "edit-shorten-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    request: "把第三段缩短",
    expected: { ...EDIT, only: 2 },
  },
  {
    id: "edit-typos",
    language: "en",
    library: "papers",
    mind: TYPOS,
    request: "Fix the typos in my notes",
    expected: EDIT,
  },
  {
    id: "edit-translate",
    language: "en",
    library: "papers",
    mind: TYPOS,
    request: "Translate my notes into Chinese",
    expected: { ...EDIT, terms: [{ want: "大潮", not: ["春潮"] }] },
  },
  {
    id: "edit-formal",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Make the first paragraph more formal",
    expected: { ...EDIT, only: 0 },
  },
  {
    id: "edit-remove",
    language: "en",
    library: "papers",
    mind: PENSIONS,
    request: "Remove the part about pensions",
    expected: { ...EDIT, only: 1 },
  },
  // An edit asked about "this", "my draft" or "the file", with no paragraph numbered, in both languages.
  {
    id: "edit-this-shorter",
    language: "en",
    library: "papers",
    mind: Q3,
    selectAll: true,
    request: "Make this shorter",
    expected: EDIT,
  },
  {
    id: "edit-rewrite-this",
    language: "en",
    library: "papers",
    mind: Q3,
    selectAll: true,
    request: "Rewrite this so it reads more clearly",
    expected: EDIT,
  },
  {
    id: "edit-rewrite-paragraph",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Rewrite the second paragraph so it's clearer",
    expected: { ...EDIT, only: 1 },
  },
  {
    id: "edit-typos-draft",
    language: "en",
    library: "papers",
    mind: TYPOS,
    request: "Fix the typos in my draft",
    expected: EDIT,
  },
  {
    id: "edit-typos-this",
    language: "en",
    library: "papers",
    mind: TYPOS,
    selectAll: true,
    request: "Fix the typos in this",
    expected: EDIT,
  },
  {
    id: "edit-tighten-draft",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Can you tighten up my draft?",
    expected: EDIT,
  },
  {
    id: "edit-this-shorter-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    selectAll: true,
    request: "把这个改短一点",
    expected: EDIT,
  },
  {
    id: "edit-rewrite-this-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    selectAll: true,
    request: "把这一段重写一下，读起来更清楚",
    expected: EDIT,
  },
  {
    id: "edit-rewrite-paragraph-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    request: "把第二段重写一下，说得更清楚",
    expected: { ...EDIT, only: 1 },
  },
  {
    id: "edit-ordinal-decoy-en",
    language: "en",
    library: "papers",
    mind: Q3,
    request:
      "The second paragraph of the paper says the method is complex, so shorten my third paragraph",
    expected: { ...EDIT, only: 2 },
  },
  {
    id: "edit-ordinal-decoy-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    request: "论文的第二段说方法很复杂，所以把我的第三段缩短",
    expected: { ...EDIT, only: 2 },
  },
  {
    id: "edit-typos-draft-zh",
    language: "zh-CN",
    library: "papers",
    mind: TYPOS_ZH,
    request: "帮我改一下草稿里的错别字",
    expected: EDIT,
  },
  {
    id: "edit-typos-this-zh",
    language: "zh-CN",
    library: "papers",
    mind: TYPOS_ZH,
    selectAll: true,
    request: "把这里的错别字改掉",
    expected: EDIT,
  },
  {
    id: "edit-polish-draft-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    request: "我的草稿太啰嗦了，帮我精简一下",
    expected: EDIT,
  },
  // The same asked of an imported Word file, which the User calls "the file".
  {
    id: "word-shorten",
    language: "en",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT,
    request: "Make the liability clause shorter",
    expected: { ...EDIT, only: 1 },
  },
  {
    id: "word-rewrite",
    language: "en",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT,
    request: "Rewrite the payment clause in plain English",
    expected: { ...EDIT, only: 2 },
  },
  {
    id: "word-formal-file",
    language: "en",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT,
    selectAll: true,
    request: "Make this file more formal",
    expected: EDIT,
  },
  {
    id: "word-shorten-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT_ZH,
    request: "把赔偿责任这一条改短一点",
    expected: { ...EDIT, only: 1 },
  },
  {
    id: "word-rewrite-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT_ZH,
    request: "把付款条款重写得通俗易懂一点",
    expected: { ...EDIT, only: 2 },
  },
  {
    id: "word-formal-file-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    word: SUPPLY_AGREEMENT_ZH,
    selectAll: true,
    request: "把这份文件改得更正式",
    expected: EDIT,
  },
  // The owner's own words (2026-10-21), asked of the whole Library: in an empty Mind, from Home, beside a Mind
  // with text (#1559). The Library open asks the core as Home does: no Mind in focus, every Document searched.
  {
    id: "owner-lib-empty-zh",
    language: "zh-CN",
    library: "reports",
    mind: EMPTY,
    request: "帮我写一份关于这个知识库的总结",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-lib-home-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "帮我写一份关于这个知识库的总结",
    expected: { ...WRITE_ALL, into: "new" },
  },
  {
    id: "owner-lib-mind-zh",
    language: "zh-CN",
    library: "reports",
    mind: WEEKLY,
    request: "帮我写一份关于这个知识库的总结",
    expected: { ...WRITE_ALL, into: "new" },
  },
  {
    id: "owner-lib-empty-en",
    language: "en",
    library: "reports",
    mind: EMPTY,
    request: "Write me a summary of this Library",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-lib-home-en",
    language: "en",
    library: "reports",
    mind: null,
    request: "Write me a summary of this Library",
    expected: { ...WRITE_ALL, into: "new" },
  },
  {
    id: "owner-lib-mind-en",
    language: "en",
    library: "reports",
    mind: Q3,
    request: "Write me a summary of this Library",
    expected: { ...WRITE_ALL, into: "new" },
  },
  // Close variants of the owner's words that the router left unclear, asked in an empty Mind. The two that name
  // nothing to produce may go either way.
  {
    id: "owner-var-qmark-zh",
    language: "zh-CN",
    library: "reports",
    mind: EMPTY,
    request: "帮我写一份关于这个知识库的总结？",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-var-ba-zh",
    language: "zh-CN",
    library: "reports",
    mind: EMPTY,
    request: "帮我写一份关于这个知识库的总结吧",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-var-zongjie-zh",
    language: "zh-CN",
    library: "reports",
    mind: EMPTY,
    request: "帮我总结一下这个知识库",
    expected: EITHER_ALL,
  },
  {
    id: "owner-var-qmark-en",
    language: "en",
    library: "reports",
    mind: EMPTY,
    request: "Write me a summary of this Library?",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-var-can-en",
    language: "en",
    library: "reports",
    mind: EMPTY,
    request: "Can you write me a summary of this Library?",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-var-summarise-en",
    language: "en",
    library: "reports",
    mind: EMPTY,
    request: "Summarise this Library for me",
    expected: EITHER_ALL,
  },
  // As the app starts a new Mind: one empty Heading 1 (its grey "Title"), nothing else.
  {
    id: "owner-lib-h1-zh",
    language: "zh-CN",
    library: "reports",
    mind: { title: "", blocks: ["# "] },
    request: "帮我写一份关于这个知识库的总结",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-lib-h1-en",
    language: "en",
    library: "reports",
    mind: { title: "", blocks: ["# "] },
    request: "Write me a summary of this Library",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  // The owner's words after a chat answer about the same Library, in the app's empty new Mind.
  {
    id: "owner-lib-after-zh",
    language: "zh-CN",
    library: "reports",
    mind: { title: "", blocks: ["# "] },
    before: ["这个知识库里有什么？"],
    request: "帮我写一份关于这个知识库的总结",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  {
    id: "owner-lib-after-en",
    language: "en",
    library: "reports",
    mind: { title: "", blocks: ["# "] },
    before: ["What is in this Library?"],
    request: "Write me a summary of this Library",
    expected: { ...WRITE_ALL, into: "asked-from" },
  },
  // After a write, its follow-ups change the same text.
  {
    id: "follow-longer",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: ["Add a short section on GraphST's results to my notes"],
    request: "make it longer",
    expected: WRITE,
  },
  {
    id: "follow-longer-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    before: ["把教程的主要观点加到我的笔记里"],
    request: "长一点",
    expected: WRITE,
  },
  // After Add to note, the summary in the Mind is what changes (#1061).
  {
    id: "added-longer",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: ["What does the tutorial paper say? Answer in a short paragraph."],
    addToNote: true,
    request: "Make the summary longer.",
    expected: { ...EDIT, inPlace: true },
  },
  {
    id: "added-longer-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP,
    before: ["这篇教程论文讲了什么？请用一小段话回答。"],
    addToNote: true,
    request: "把摘要写长一点。",
    expected: { ...EDIT, inPlace: true },
  },
  {
    id: "follow-shorter",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    before: ["Add a short section on GraphST's results to my notes"],
    request: "no, keep it shorter",
    expected: WRITE,
  },
  // Several Documents: each covered, or the main few.
  {
    id: "reports-page",
    language: "en",
    library: "reports",
    mind: { title: "Briefing", blocks: ["Notes for Monday's briefing."] },
    request: "Write a summary page of these documents",
    expected: WRITE_ALL,
    hard: true,
  },
  {
    id: "reports-main",
    language: "en",
    library: "reports",
    mind: { title: "Briefing", blocks: ["Notes for Monday's briefing."] },
    request: "Summarise the two main documents",
    expected: EITHER,
  },
  {
    id: "reports-all-zh",
    language: "zh-CN",
    library: "reports",
    mind: { title: "简报", blocks: ["周一简报的笔记。"] },
    request: "总结这些文档",
    expected: EITHER_ALL,
  },
  {
    id: "reports-esg",
    language: "en",
    library: "reports",
    mind: { title: "Briefing", blocks: ["Notes for Monday's briefing."] },
    request: "What does the Vantrell report say about emissions?",
    expected: ANSWER,
  },
  {
    id: "reports-un-zh",
    language: "zh-CN",
    library: "reports",
    mind: { title: "简报", blocks: ["周一简报的笔记。"] },
    request: "Norvath Assembly 2022 年度报告的重点是什么？",
    expected: ANSWER,
  },
  {
    id: "reports-write",
    language: "en",
    library: "reports",
    mind: { title: "Briefing", blocks: ["Notes for Monday's briefing."] },
    request: "Add the ESG report's main targets to my notes",
    expected: { ...WRITE, into: "asked-from" },
  },
  // No Mind in focus.
  {
    id: "no-mind-add",
    language: "en",
    library: "papers",
    mind: null,
    request: "Add a risks section",
    expected: { ...NOTHING, either: true },
  },
  {
    id: "no-mind-page",
    language: "en",
    library: "papers",
    mind: null,
    request: "Write a summary page of these papers",
    expected: { ...WRITE_ALL, into: "new" },
  },
  // Questions that only sound like requests, and Questions about the User's own text.
  {
    id: "sounds-like",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "what would a shorter version of my notes look like?",
    expected: NOTHING,
  },
  {
    id: "should-i",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Should I add a risks section?",
    expected: NOTHING,
  },
  {
    id: "polite-zh",
    language: "zh-CN",
    library: "papers",
    mind: WEEKLY,
    request: "可以把第一段改短吗？",
    expected: { ...EDIT, only: 0 },
    hard: true,
  },
  {
    id: "own-question",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "How was the quarter?",
    expected: NOTHING,
  },
  {
    id: "own-explain",
    language: "en",
    library: "papers",
    mind: Q3,
    request: "Explain the second paragraph of my notes",
    expected: NOTHING,
  },
  {
    id: "example-own",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    afterExample: true,
    request: "What does the GraphST paper claim?",
    expected: ABOUT_THE_QUESTION,
  },
  {
    id: "example-own-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP_ZH,
    afterExample: true,
    request: "GraphST 这篇论文的主要主张是什么？",
    expected: ABOUT_THE_QUESTION,
  },
  {
    id: "example-main",
    language: "en",
    library: "papers",
    mind: READING_GROUP,
    afterExample: true,
    before: ["What does the GraphST paper claim?"],
    request: "Summarise the two main documents.",
    expected: { ...ABOUT_THE_QUESTION, either: true },
  },
  {
    id: "example-main-zh",
    language: "zh-CN",
    library: "papers",
    mind: READING_GROUP_ZH,
    afterExample: true,
    before: ["GraphST 这篇论文的主要主张是什么？"],
    request: "总结一下两份主要文档。",
    expected: { ...ABOUT_THE_QUESTION, either: true },
  },
  {
    id: "example-word",
    language: "en",
    library: "papers",
    mind: null,
    word: SUPPLY_AGREEMENT,
    afterExample: true,
    request: "What is the liability cap?",
    expected: ABOUT_THE_QUESTION,
  },
  {
    id: "example-word-zh",
    language: "zh-CN",
    library: "papers",
    mind: null,
    word: SUPPLY_AGREEMENT_ZH,
    afterExample: true,
    request: "赔偿责任的上限是多少？",
    expected: ABOUT_THE_QUESTION,
  },
  {
    id: "example-stay",
    language: "en",
    library: "papers",
    mind: null,
    afterExample: true,
    inExample: true,
    request: "What does the GraphST paper claim?",
    expected: ABOUT_THE_QUESTION,
  },
  {
    id: "example-stay-zh",
    language: "zh-CN",
    library: "papers",
    mind: null,
    afterExample: true,
    inExample: true,
    request: "GraphST 这篇论文的主要主张是什么？",
    expected: ABOUT_THE_QUESTION,
  },
  // A short summary for a page of their own, after a Question about their file from the example's page
  // (#1172): one named goes into the empty page in front (#1559); "Summarise … for my manager" names
  // none, and may be answered in the panel to add with Add to note. What it writes is held to both guards.
  {
    id: "page-summary",
    language: "en",
    library: "papers",
    mind: EMPTY,
    afterExample: true,
    beforeInExample: true,
    before: ["What data does the GraphST paper use, and what are its main results?"],
    request: "Write a short summary of the GraphST paper.",
    expected: { ...WRITE, into: "asked-from", standsAlone: true, noExample: true },
  },
  {
    id: "page-summary-panel",
    language: "en",
    library: "papers",
    mind: EMPTY,
    afterExample: true,
    beforeInExample: true,
    before: ["What data does the GraphST paper use, and what are its main results?"],
    request: "Summarise the GraphST paper for my manager.",
    expected: { ...EITHER, standsAlone: true, noExample: true },
  },
  {
    id: "page-summary-zh",
    language: "zh-CN",
    library: "papers",
    mind: EMPTY,
    afterExample: true,
    beforeInExample: true,
    before: ["GraphST 这篇论文用了哪些数据，主要结果是什么？"],
    request: "请为 GraphST 这篇论文写一个简短的摘要。",
    expected: { ...WRITE, into: "asked-from", standsAlone: true, noExample: true },
  },
  // A Question answered in the panel, then its Answer put into the page as it is: the copy of the last Answer the guard reads too.
  {
    id: "page-copy",
    language: "en",
    library: "papers",
    mind: EMPTY,
    afterExample: true,
    before: ["What are the GraphST paper's main results?"],
    request: "Put that answer into this page as it is.",
    expected: { ...WRITE, into: "asked-from", standsAlone: true, noExample: true },
  },
  {
    id: "page-copy-zh",
    language: "zh-CN",
    library: "papers",
    mind: EMPTY,
    afterExample: true,
    before: ["GraphST 这篇论文的主要结果是什么？"],
    request: "把这个回答原样放进这个页面。",
    expected: { ...WRITE, into: "asked-from", standsAlone: true, noExample: true },
  },
  // Research questions where an inference is tempting: a cited sentence says only what its quote supports (#1073).
  {
    id: "research-attention-long",
    language: "en",
    library: "reports",
    mind: null,
    request:
      "Does a model built only from weighted keys handle very long sequences better than recurrent layers?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-attention-heads",
    language: "en",
    library: "reports",
    mind: null,
    request: "Why did the Calventis authors use twelve attention heads?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt2-size",
    language: "en",
    library: "reports",
    mind: null,
    request: "Does the Wrennick report show that bigger language models are always better?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-few-shot",
    language: "en",
    library: "reports",
    mind: null,
    request: "Is Brellan-220B's few-shot learning as good as fine-tuning?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-energy",
    language: "en",
    library: "reports",
    mind: null,
    request: "How much energy does it take to train Brellan-220B, and is that a problem?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-contamination",
    language: "en",
    library: "reports",
    mind: null,
    request: "Can we trust Brellan-220B's benchmark results, given the data contamination?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-optimizer",
    language: "en",
    library: "reports",
    mind: null,
    request: "Does the Torvane report remove the need to tune hyperparameters?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-jpm-target",
    language: "en",
    library: "reports",
    mind: null,
    request: "Is Vantrell on track to meet its $1.4 trillion sustainable development target?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-un-hunger",
    language: "en",
    library: "reports",
    mind: null,
    request:
      "What does the Norvath Assembly report suggest about the eastern war's effect on global hunger?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-abpi-gifts",
    language: "en",
    library: "reports",
    mind: null,
    request: "Does the MPMA Code mean pharma companies can never give doctors anything?",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-attention-long-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Calventis 模型在处理很长的序列时，是不是比循环网络更有优势？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-attention-heads-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Calventis 论文为什么选用 12 个注意力头？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt2-size-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Wrennick 的报告是否说明模型越大效果就一定越好？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-few-shot-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Brellan-220B 的小样本学习能达到微调的水平吗？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-energy-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "训练 Brellan-220B 要消耗多少能源？这会是个问题吗？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-gpt3-contamination-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "考虑到数据污染，Brellan-220B 的基准测试结果可信吗？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-optimizer-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Torvane 的报告是不是说明以后不用再调超参数了？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-jpm-target-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Vantrell 有望实现 1.4 万亿美元的可持续发展目标吗？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-un-hunger-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "Norvath Assembly 2022 年度报告认为东部战争对全球饥饿有什么影响？",
    expected: ANSWER,
    research: true,
  },
  {
    id: "research-abpi-gifts-zh",
    language: "zh-CN",
    library: "reports",
    mind: null,
    request: "MPMA 守则是不是意味着药企绝对不能给医生任何东西？",
    expected: ANSWER,
    research: true,
  },
  // Dated-looking Documents: every date an Answer gives is one their text writes, never their file's (#1173).
  {
    id: "dates-contract-summary",
    language: "en",
    library: "dated",
    mind: null,
    request: "Summarise the employment contract.",
    expected: { ...TEXT_DATES_EN, either: true },
    summary: true,
  },
  {
    id: "dates-contract-signed",
    language: "en",
    library: "dated",
    mind: null,
    request: "When was the employment contract signed?",
    expected: TEXT_DATES_EN,
  },
  {
    id: "dates-contract-key-dates",
    language: "en",
    library: "dated",
    mind: null,
    request: "What are the key dates in the employment contract?",
    expected: TEXT_DATES_EN,
  },
  {
    id: "dates-nda-effective",
    language: "en",
    library: "dated",
    mind: null,
    request: "When does the mutual NDA take effect?",
    expected: TEXT_DATES_EN,
  },
  {
    id: "dates-minutes",
    language: "en",
    library: "dated",
    mind: null,
    request: "When did the board meet, and what did it decide?",
    expected: TEXT_DATES_EN,
  },
  {
    id: "dates-contract-summary-zh",
    language: "zh-CN",
    library: "dated",
    mind: null,
    request: "总结一下这份劳动合同。",
    expected: { ...TEXT_DATES_ZH, either: true },
    summary: true,
  },
  {
    id: "dates-contract-signed-zh",
    language: "zh-CN",
    library: "dated",
    mind: null,
    request: "这份劳动合同是什么时候签订的？",
    expected: TEXT_DATES_ZH,
  },
  {
    id: "dates-contract-key-dates-zh",
    language: "zh-CN",
    library: "dated",
    mind: null,
    request: "劳动合同里有哪些关键日期？",
    expected: TEXT_DATES_ZH,
  },
  {
    id: "dates-nda-effective-zh",
    language: "zh-CN",
    library: "dated",
    mind: null,
    request: "保密协议什么时候生效？",
    expected: TEXT_DATES_ZH,
  },
  {
    id: "dates-minutes-zh",
    language: "zh-CN",
    library: "dated",
    mind: null,
    request: "董事会是哪天开的会？做了什么决定？",
    expected: TEXT_DATES_ZH,
  },
  {
    id: "filing-comparable-en",
    language: "en",
    library: "filings",
    mind: null,
    request:
      "In Northmart's Q2 2026 10-Q, what was the consolidated comparable-sales change? Answer with the figure and cite it.",
    expected: {
      ...ANSWER,
      answerWith: /declin\w*[^.!?\n]{0,20}6\.2%/i,
      answerEvidence: {
        document: /Northmart Q2 2026 10-Q/,
        quote: /like-for-like sales declined 6\.2%/i,
      },
      noDocumentAbsence: /comparable|同店/,
    },
  },
  {
    id: "filing-comparable-zh",
    language: "zh-CN",
    library: "filings",
    mind: null,
    request: "北域零售2026年第二季度季报中，集团同店销售额变化了多少？请给出数字并注明出处。",
    expected: {
      ...ANSWER,
      answerWith: /下降[^。！？\n]{0,12}6\.2%/,
      answerEvidence: {
        document: /北域零售 2026年第二季度季报/,
        quote: /同店销售额下降 6\.2%/,
      },
      noDocumentAbsence: /comparable|同店/,
    },
  },
  {
    id: "filing-margin-en",
    language: "en",
    library: "filings",
    mind: null,
    request:
      "What operating margin did Harbour Hotels report for 2026? Give the percentage and cite the release.",
    expected: {
      ...ANSWER,
      answerWith: /38\.2%/,
      answerEvidence: {
        document: /Harbour Hotels 2026 annual release/,
        quote: /Operating profitability reached 38\.2%/,
      },
      noDocumentAbsence: /margin|利润率/,
    },
  },
  {
    id: "filing-margin-zh",
    language: "zh-CN",
    library: "filings",
    mind: null,
    request: "港湾酒店2026年度业绩公告中的经营利润率是多少？请给出百分比并注明出处。",
    expected: {
      ...ANSWER,
      answerWith: /38\.2%/,
      answerEvidence: {
        document: /港湾酒店 2026年度业绩公告/,
        quote: /经营利润率达到 38\.2%/,
      },
      noDocumentAbsence: /margin|利润率/,
    },
  },
  {
    id: "filing-recast-en",
    language: "en",
    library: "filings",
    mind: null,
    request:
      "In Delta Manufacturing's 2026 8-K, what was the recast second-quarter revenue? Answer with the amount and cite it.",
    expected: {
      ...ANSWER,
      answerWith: /\$423 million/,
      answerEvidence: {
        document: /Delta Manufacturing 8-K 2026/,
        quote: /Restated second-quarter sales: \$423 million/,
      },
      noDocumentAbsence: /recast|重述|revenue|销售额/,
    },
  },
  {
    id: "filing-recast-zh",
    language: "zh-CN",
    library: "filings",
    mind: null,
    request: "三角洲制造2026年8-K中重述的第二季度收入是多少？请给出金额并注明出处。",
    expected: {
      ...ANSWER,
      answerWith: /4\.23 亿元/,
      answerEvidence: {
        document: /三角洲制造 8-K 2026/,
        quote: /重述第二季度销售额：4\.23 亿元/,
      },
      noDocumentAbsence: /recast|重述|revenue|销售额/,
    },
  },
  {
    id: "filing-absent-en",
    language: "en",
    library: "filings",
    mind: null,
    request: "What was Northmart's cash conversion cycle in Q2 2026?",
    expected: { ...NOTHING, searchMiss: true, noDocumentAbsence: /cash conversion/ },
  },
  {
    id: "filing-absent-zh",
    language: "zh-CN",
    library: "filings",
    mind: null,
    request: "北域零售2026年第二季度的现金转换周期是多少？",
    expected: { ...NOTHING, searchMiss: true, noDocumentAbsence: /现金转换周期/ },
  },
  {
    id: "reserves-change-zh",
    language: "zh-CN",
    library: "reserves",
    mind: null,
    request:
      "2026年9月末我国外汇储备是多少？与1月末相比变化了多少？黄金储备的数量增加了多少？\n\n请根据这些文档回答，并注明出处。",
    expected: { ...ANSWER, figure: /11\.73亿美元/ },
  },
  {
    id: "reserves-change-en",
    language: "en",
    library: "reserves",
    mind: null,
    request:
      "What were China's foreign exchange reserves at the end of September 2026, and how much did they change since the end of January?",
    expected: { ...ANSWER, figure: /1\.17\d* billion|1,17\d(?:\.\d+)? million/ },
  },
  ...CEDAR,
  ...THIS_DOCUMENT,
  ...SELECTED,
];
