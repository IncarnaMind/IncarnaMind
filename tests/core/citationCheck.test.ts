/**
 * The Citation check, case by case, in English and Chinese (#31): the text
 * PDFs give and the quotes models write differ in hyphenation, ligatures,
 * full-width punctuation and CJK spacing, quotes run across page breaks, and
 * models cite page ranges that break the page-range rule. eval/README.md
 * lists these cases with the end-to-end tests that cover them too.
 *
 * Each case is a Document's stored page text (as processing stores it, see
 * `pageTexts`), a Citation's pages and the pages of its Passage, and the quote.
 *
 * The letter case, reference mark and ellipsis cases come from the evaluation
 * run of 2026-10-07 with Ollama's mistral, where the check said "not found"
 * for three quotes that are on their pages: the page text is the stored text
 * of the sample PDFs in data/, cut short.
 */
import { describe, expect, test } from "vitest";
import type { CitationCheckReason } from "../../src/core";
import { type CheckResult, checkCitation } from "../../src/core/answers/citations";

/** Tuning the Tuner, p. 8, as stored. */
const HYPEROPTIMIZERS = [
  "with stacks of hyperoptimizers of increasing heights, and with bottom-level step sizes ↵ initialized",
  "across many orders of magnitude. In practice we find that when the starting hyper-step sizes are far too large,",
  "training blows up on anything bigger than the small dense task. Each level therefore starts",
  "below the one beneath it.",
].join("\n");

/** Weighted Keys, Shorter Paths, p. 8, as stored: "[3]" is a reference to the paper's bibliography. */
const LABEL_SMOOTHING = [
  "Pdrop = 0.1.",
  "Label smoothing of ε = 0.04 [3] was applied throughout. It costs perplexity,",
  "since the model is less sure of itself, but it gains accuracy and BLEU.",
  "4 Results",
].join("\n");

/** MPMA Code of Practice 2021, pp. 35 and 36, as stored. */
const PACKAGE_DEALS = [
  [
    "Where a medicine needs a test before it can be prescribed, a",
    "company may offer the test as part of a package deal, even if",
    "the test shows that the medicine will not help some of the",
    "patients tested.",
    "Clause 19.1: Shared-Risk Supply Agreements",
    "Clause 19.1 does not prevent the use of shared-risk supply",
    "agreements.",
  ].join("\n"),
  "Where a medicine fails to meet the criteria agreed with the\npayer, the agreement must say how the payment or the price reduction is calculated.",
];

/** 维基百科-梯度下降法, p. 1, as stored: "[2]" is a reference, and "⾸" a Kangxi radical. */
const CAUCHY =
  "梯度下降法通常被认为是奧古斯丁-路易·柯西（法語：Augustin-Louis Cauchy）在 1847 年⾸次提出的。[2]雅克·所罗⻔·阿达⻢（法語：Jacques Solomon Hadamard）在 1907 年独⽴提出了⼀个类似的⽅法。[3]";

/** 维基百科-可持续发展目标, as the Chinese fixture's pages read. */
const POVERTY =
  "到 2030 年，為所有地⽅的所有⼈消除極端貧窮，⽬前標準按照每天⽣活費不⾜ 1.25 美元計算。";

interface Case {
  language: "en" | "zh";
  topic: string;
  name: string;
  /** The Document's pages, from 1. */
  pages: string[];
  /** The cited pages. */
  cited: [number, number];
  /** The cited Passage's pages. */
  passage: [number, number];
  quote: string;
  /** The Document's text lost its f-ligatures (see `lostLigatures`, worked out from all its text). */
  lostLigatures?: boolean;
  /** "found", or why not. */
  expected: "found" | CitationCheckReason;
}

/** Vantrell Financial Group 2022 ESG Report, p. 8, as stored: its text lost its f-ligatures. */
const TARGET =
  "set our Sustainable Development Target (the “Target”) with the goal to fnance and\nfacilitate more than $1.4 trillion over eight years—from 2022 through the end of 2029—";

const cases: Case[] = [
  // Hyphenation at line ends
  {
    language: "en",
    topic: "hyphenation",
    name: "a word split by a hyphen at a line end is joined",
    pages: ["Trade figures\nGrowth in inter-\nnational trade slowed in 2022."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "Growth in international trade slowed in 2022.",
    expected: "found",
  },
  {
    language: "en",
    topic: "hyphenation",
    name: "a hyphenated compound broken after its hyphen keeps the hyphen",
    pages: ["On the WMT 2014 English-\nto-German translation task, the big model wins."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "On the WMT 2014 English-to-German translation task",
    expected: "found",
  },
  {
    language: "zh",
    topic: "hyphenation",
    name: "an English term split at a line end inside Chinese text is joined",
    pages: ["用梯度下降法优化 Rosen-\nbrock 函数时，收敛非常缓慢。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "用梯度下降法优化Rosenbrock函数时,收敛非常缓慢。",
    expected: "found",
  },
  {
    language: "en",
    topic: "hyphenation",
    name: "the quote keeps the line-end hyphen, with a space for the line break",
    pages: [
      "In practice we find that if the initial hyper-\nstep sizes are too large, it diverges.",
    ],
    cited: [1, 1],
    passage: [1, 1],
    quote: "if the initial hyper- step sizes are too large",
    expected: "found",
  },
  {
    language: "en",
    topic: "hyphenation",
    name: "a soft hyphen at a line end joins the word, and one inside a line is ignored",
    pages: ["Growth in inter\u00ad\nnational trade slowed in 20\u00ad22."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "Growth in international trade slowed in 2022.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "hyphenation",
    name: "an English term split by a soft hyphen at a line end inside Chinese text",
    pages: ["用梯度下降法优化 Rosen\u00ad\nbrock 函数时，收敛非常缓慢。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "用梯度下降法优化Rosenbrock函数时,收敛非常缓慢。",
    expected: "found",
  },

  // Ligatures and other compatibility characters
  {
    language: "en",
    topic: "ligatures",
    name: "fi, fl and ffi ligatures on the page match plain letters in the quote",
    pages: ["The ﬁrst ﬂoor was ofﬁcially opened in May."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The first floor was officially opened in May.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "ligatures",
    name: "a ligature in an English term inside Chinese text",
    pages: ["模型经过 ﬁne-tuning 之后，效果明显更好。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "模型经过fine-tuning之后,效果明显更好",
    expected: "found",
  },

  // Full-width forms and punctuation
  {
    language: "en",
    topic: "full-width punctuation",
    name: "full-width letters, digits and hyphen in the quote match ASCII on the page",
    pages: ["Alder-LM has 175 billion parameters in total."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "ＡＬＤＥＲ－ＬＭ has １７５ billion parameters",
    expected: "found",
  },
  {
    language: "zh",
    topic: "full-width punctuation",
    name: "full-width colon, comma and full stop on the page match ASCII in the quote",
    pages: ["该目标要求：到 2030 年，让全球因为交通事故而伤亡的人数减少一半。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "该目标要求:到2030年,让全球因为交通事故而伤亡的人数减少一半.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "full-width punctuation",
    name: "Chinese quotation marks and full-width brackets match their ASCII forms",
    pages: ["注意力机制的灵活性来自于它的“软权重”特性（soft weights）。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: '注意力机制的灵活性来自于它的"软权重"特性(soft weights)',
    expected: "found",
  },

  // Quote marks, apostrophes and dashes
  {
    language: "en",
    topic: "quote marks and dashes",
    name: "curly and angle quotes, apostrophes and dashes match straight quotes and hyphens",
    pages: ["The model’s “soft” weights — unlike its ‹fixed› ones – change; the teamʼs ⸺ result."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The model's \"soft\" weights - unlike its 'fixed' ones - change; the team's - result.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "quote marks and dashes",
    name: "corner brackets and a double em dash match straight quotes and hyphens",
    pages: ["注意力机制的「软权重」——可以在运行时改变。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: '注意力机制的"软权重"--可以在运行时改变',
    expected: "found",
  },

  // Whitespace and line breaks
  {
    language: "en",
    topic: "whitespace",
    name: "line breaks, tabs, blank lines and non-breaking spaces count as one space",
    pages: ["Revenue grew\n by\tten\u00a0percent\n\nin the third\u202fquarter."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "Revenue grew by ten percent in the third quarter.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "whitespace",
    name: "line breaks and spaces inside Chinese text are ignored",
    pages: ["潮汐是海水的\n周期性 涨落。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "潮汐是海水的周期性涨落。",
    expected: "found",
  },

  // Letter case
  {
    language: "en",
    topic: "letter case",
    name: "a quote that starts mid-sentence, given a capital (Tuning the Tuner, p. 8)",
    pages: [HYPEROPTIMIZERS],
    cited: [1, 1],
    passage: [1, 1],
    quote:
      "When the starting hyper-step sizes are far too large, training blows up on anything bigger than the small dense task.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "letter case",
    name: "an English term inside Chinese text, in another letter case",
    pages: ["梯度下降法（英語：Gradient descent）是一个一阶最优化算法。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "梯度下降法(英語:gradient Descent)是一个一阶最优化算法",
    expected: "found",
  },

  // Greek letters
  {
    language: "en",
    topic: "Greek letters",
    name: "ε in the quote matches the page, with its subscript run on",
    pages: [LABEL_SMOOTHING],
    cited: [1, 1],
    passage: [1, 1],
    quote: "label smoothing of ε = 0.04 [3] was applied throughout. It costs perplexity",
    expected: "found",
  },
  {
    language: "en",
    topic: "Greek letters",
    name: "a mathematical italic epsilon on the page matches ε",
    pages: ["The step size 𝜖 is decayed by ϑ every epoch."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The step size ε is decayed by θ every epoch.",
    expected: "found",
  },
  {
    language: "zh",
    topic: "Greek letters",
    name: "ε in the quote matches ϵ in Chinese text",
    pages: ["学习率 ϵ 通常取 0.001，动量 β 取 0.9。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "学习率ε通常取0.001,动量β取0.9",
    expected: "found",
  },

  // Reference and footnote marks
  {
    language: "en",
    topic: "reference marks",
    name: "a reference [3] on the page, written [^3] in the quote (Weighted Keys, p. 8)",
    pages: [LABEL_SMOOTHING],
    cited: [1, 1],
    passage: [1, 1],
    quote:
      "Label smoothing of ε = 0.04 [^3] was applied throughout. It costs perplexity, since the model is less sure of itself, but it gains accuracy and BLEU.",
    expected: "found",
  },
  {
    language: "en",
    topic: "reference marks",
    name: "a footnote [^1] on the page, written [1] in the quote",
    pages: ["The trial ran for two years.[^1] It ended early."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The trial ran for two years.[1] It ended early.",
    expected: "found",
  },
  {
    language: "en",
    topic: "reference marks",
    name: "a reference with another number isn't found",
    pages: [LABEL_SMOOTHING],
    cited: [1, 1],
    passage: [1, 1],
    quote: "label smoothing of ε = 0.04 [^9] was applied throughout. It costs perplexity",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "reference marks",
    name: "a reference [2] on the page, written [^2] in the quote",
    pages: [CAUCHY],
    cited: [1, 1],
    passage: [1, 1],
    quote:
      "梯度下降法通常被认为是奧古斯丁-路易·柯西（法語：Augustin-Louis Cauchy）在 1847 年首次提出的。[^2]",
    expected: "found",
  },

  // An ellipsis marks words left out
  {
    language: "en",
    topic: "ellipsis",
    name: "an ellipsis where the page has a full stop and a heading (MPMA Code of Practice, pp. 35–36)",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote:
      "a company may offer the test as part of a package deal, even if the test shows that the medicine will not help some of the patients tested... Clause 19.1: Shared-Risk Supply Agreements",
    expected: "found",
  },
  {
    language: "en",
    topic: "ellipsis",
    name: "words left out between parts that are each on the pages, in order",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote:
      "Where a medicine needs a test … the test shows that the medicine will not help … the agreement must say how the payment",
    expected: "found",
  },
  {
    language: "en",
    topic: "ellipsis",
    name: "a part shorter than three words isn't enough, though it is on the page",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote: "Where a medicine needs a test before it can be prescribed ... patients tested.",
    expected: "quote-not-on-pages",
  },
  {
    language: "en",
    topic: "ellipsis",
    name: "a part of three short words isn't enough either",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote: "Where a medicine needs a test before it can be prescribed ... the use of",
    expected: "quote-not-on-pages",
  },
  {
    language: "en",
    topic: "ellipsis",
    name: "parts in another order than on the pages",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote: "Clause 19.1: Shared-Risk Supply Agreements ... a company may offer the test",
    expected: "quote-not-on-pages",
  },
  {
    language: "en",
    topic: "ellipsis",
    name: "a reworded part",
    pages: PACKAGE_DEALS,
    cited: [1, 2],
    passage: [1, 2],
    quote:
      "companies can arrange to provide such testing as a package deal ... the outcome of the tests does not back the use of the medicine",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "ellipsis",
    name: "a Chinese ellipsis (……) between two parts on the page",
    pages: [POVERTY],
    cited: [1, 1],
    passage: [1, 1],
    quote: "到 2030 年，為所有地⽅的所有⼈消除極端貧窮……⽬前標準按照每天⽣活費不⾜ 1.25 美元計算。",
    expected: "found",
  },
  {
    language: "zh",
    topic: "ellipsis",
    name: "a part shorter than 15 characters isn't enough",
    pages: [POVERTY],
    cited: [1, 1],
    passage: [1, 1],
    quote: "到 2030 年，為所有地⽅的所有⼈消除極端貧窮……1.25 美元計算",
    expected: "quote-not-on-pages",
  },

  // CJK text
  {
    language: "en",
    topic: "CJK",
    name: "a Chinese term in English text matches whatever the spacing around it",
    pages: ["The Chinese term 大语言模型 appears in most survey titles."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The Chinese term大语言模型appears in most survey titles",
    expected: "found",
  },
  {
    language: "zh",
    topic: "CJK",
    name: "radical look-alikes and the spaces pdf.js adds around Latin words and numbers",
    pages: ["例如 Alder-LM 含 1750 亿参数，是一个 ⼤型语⾔模型。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "Alder-LM含1750亿参数,是一个大型语言模型",
    expected: "found",
  },
  {
    language: "zh",
    topic: "CJK",
    name: "a quote in simplified characters of a page in traditional ones, character by character (ADR-0009)",
    pages: ["歐盟因此於 2021 年 3 月制定永續財務揭露法規。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "欧盟因此于2021年3月制定永续财务揭露法规",
    expected: "found",
  },
  {
    language: "zh",
    topic: "CJK",
    name: "a quote in traditional characters of a page in simplified ones",
    pages: [CAUCHY],
    cited: [1, 1],
    passage: [1, 1],
    quote: "梯度下降法通常被認為是奧古斯丁-路易·柯西",
    expected: "found",
  },
  {
    language: "zh",
    topic: "CJK",
    name: "another word for the same thing isn't found: phrases aren't converted",
    pages: ["歐盟因此於 2021 年 3 月制定永續財務揭露法規。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "欧盟因此于2021年3月制定永续财务披露法规",
    expected: "quote-not-on-pages",
  },

  // Lost f-ligatures: pdf.js reads some PDFs' "fi" as "f", so the page shows "finance" where its text has "fnance"
  {
    language: "en",
    topic: "lost ligatures",
    name: "a quote of the page as it shows, in a Document whose text lost its f-ligatures (Vantrell, p. 8)",
    pages: [TARGET],
    cited: [1, 1],
    passage: [1, 1],
    quote: "with the goal to finance and facilitate more than $1.4 trillion over eight years",
    lostLigatures: true,
    expected: "found",
  },
  {
    language: "en",
    topic: "lost ligatures",
    name: "a quote with ligatures the text lost and one it kept: 'Firm' kept its 'Fi' (Vantrell, p. 9, en-19)",
    pages: [
      "In 2022, our Firm fnanced and facilitated approximately $118 billion toward the\nTarget; $41 billion toward green, $52 billion toward development fnance and $25\nbillion toward community development.",
    ],
    cited: [1, 1],
    passage: [1, 1],
    quote:
      "In 2022, our Firm financed and facilitated approximately $118 billion toward the Target; $41 billion toward green, $52 billion toward development finance and $25 billion toward community development.",
    lostLigatures: true,
    expected: "found",
  },
  {
    language: "en",
    topic: "lost ligatures",
    name: "where the Document's text keeps them, a lone f is an f: 'flight' isn't 'fight'",
    pages: ["The fight was delayed by fog."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "The flight was delayed by fog.",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "lost ligatures",
    name: "an English term in Chinese text whose Document lost its f-ligatures",
    pages: ["该公司的 fnancial report 显示收入增长。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "该公司的financial report显示收入增长",
    lostLigatures: true,
    expected: "found",
  },
  {
    language: "zh",
    topic: "lost ligatures",
    name: "the same term where the Document's text keeps its ligatures",
    pages: ["该公司的 fnancial report 显示收入增长。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "该公司的financial report显示收入增长",
    expected: "quote-not-on-pages",
  },

  // Quotes across a page break
  {
    language: "en",
    topic: "page break",
    name: "a sentence running from one page onto the next, citing both",
    pages: [
      "Tides are the rise and fall of the sea.",
      "High water comes twice a day.\nNeap tides occur when the Sun and the Moon",
      "pull at right angles to each other.\nTheir range is the smallest.",
    ],
    cited: [2, 3],
    passage: [1, 3],
    quote: "Neap tides occur when the Sun and the Moon pull at right angles to each other.",
    expected: "found",
  },
  {
    language: "en",
    topic: "page break",
    name: "a word hyphenated across the page break",
    pages: ["Delegates from every region and the inter-", "national community agreed on the text."],
    cited: [1, 2],
    passage: [1, 2],
    quote: "the international community agreed",
    expected: "found",
  },
  {
    language: "en",
    topic: "page break",
    name: "citing only the first of the two pages a quote runs across",
    pages: ["Neap tides occur when the Sun and the Moon", "pull at right angles to each other."],
    cited: [1, 1],
    passage: [1, 2],
    quote: "Neap tides occur when the Sun and the Moon pull at right angles to each other.",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "page break",
    name: "a Chinese sentence running onto the next page, citing both",
    pages: ["潮汐是海水的周期性涨落。\n月球的引力使地球两侧的海水隆起，", "形成两个潮汐隆起。"],
    cited: [1, 2],
    passage: [1, 2],
    quote: "月球的引力使地球两侧的海水隆起，形成两个潮汐隆起。",
    expected: "found",
  },

  // The page-range rule: at most two consecutive pages, within the Passage's pages
  {
    language: "en",
    topic: "page range",
    name: "three pages cited",
    pages: ["Tides rise and fall.", "Spring tides happen at full moon.", "Neap tides are small."],
    cited: [1, 3],
    passage: [1, 3],
    quote: "Spring tides happen at full moon.",
    expected: "too-many-pages",
  },
  {
    language: "en",
    topic: "page range",
    name: "a page outside the cited Passage",
    pages: ["Tides rise and fall.", "Spring tides happen at full moon.", "Neap tides are small."],
    cited: [2, 2],
    passage: [3, 3],
    quote: "Spring tides happen at full moon.",
    expected: "pages-outside-passage",
  },
  {
    language: "zh",
    topic: "page range",
    name: "three pages cited",
    pages: ["潮汐是海水的周期性涨落。", "大潮发生在新月和满月时。", "小潮的潮差最小。"],
    cited: [1, 3],
    passage: [1, 3],
    quote: "大潮发生在新月和满月时。",
    expected: "too-many-pages",
  },
  {
    language: "zh",
    topic: "page range",
    name: "a page outside the cited Passage",
    pages: ["潮汐是海水的周期性涨落。", "大潮发生在新月和满月时。", "小潮的潮差最小。"],
    cited: [2, 2],
    passage: [3, 3],
    quote: "大潮发生在新月和满月时。",
    expected: "pages-outside-passage",
  },

  // The match is exact
  {
    language: "en",
    topic: "exact match",
    name: "a paraphrase isn't found",
    pages: ["Revenue grew by ten percent in the third quarter."],
    cited: [1, 1],
    passage: [1, 1],
    quote: "Revenue rose 10% in the third quarter.",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "exact match",
    name: "a paraphrase isn't found",
    pages: ["优化过程是之字形的向极小值点靠近，速度非常缓慢。"],
    cited: [1, 1],
    passage: [1, 1],
    quote: "优化过程以之字形缓慢地接近极小值",
    expected: "quote-not-on-pages",
  },
  {
    language: "en",
    topic: "exact match",
    name: "a quote with one word changed isn't found, whatever its letter case and punctuation",
    pages: [HYPEROPTIMIZERS],
    cited: [1, 1],
    passage: [1, 1],
    quote:
      "When the starting hyper-step sizes are too big, training blows up on anything bigger than the small dense task.",
    expected: "quote-not-on-pages",
  },
  {
    language: "en",
    topic: "exact match",
    name: "a quote from another page than the one cited isn't found",
    pages: [HYPEROPTIMIZERS, LABEL_SMOOTHING],
    cited: [1, 1],
    passage: [1, 2],
    quote: "Label smoothing of ε = 0.04 [3] was applied throughout.",
    expected: "quote-not-on-pages",
  },
  {
    language: "zh",
    topic: "exact match",
    name: "a quote from another page than the one cited isn't found",
    pages: [CAUCHY, POVERTY],
    cited: [1, 1],
    passage: [1, 2],
    quote: "到 2030 年，為所有地⽅的所有⼈消除極端貧窮",
    expected: "quote-not-on-pages",
  },
];

/** The check as the core runs it: on the stored text of the cited pages only. */
function check({ pages, cited, passage, quote, lostLigatures }: Case): CheckResult {
  const [from, to] = cited;
  return checkCitation({
    quote,
    range: { pageFrom: from, pageTo: to },
    passage: { pageFrom: passage[0], pageTo: passage[1] },
    documentDeleted: false,
    pages: pages
      .map((text, index) => ({ page: index + 1, text }))
      .filter(({ page }) => page >= from && page <= to),
    lostLigatures,
  });
}

describe("The Citation check, case by case", () => {
  test.each(cases)("$language, $topic: $name", (each) => {
    expect(check(each)).toEqual(
      each.expected === "found"
        ? { check: "found", checkReason: null }
        : { check: "not-found", checkReason: each.expected },
    );
  });

  test("covers every topic in both languages", () => {
    const covered = (language: Case["language"]) =>
      new Set(cases.filter((each) => each.language === language).map((each) => each.topic));
    expect([...covered("en")].sort()).toEqual([...covered("zh")].sort());
  });
});
