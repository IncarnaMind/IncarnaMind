/**
 * A cited Mind turned into a report (#1800): the claims its Notes make, each cited where its
 * quote is in one of two sample papers, and the requests, in English and Chinese, from a Mind of
 * 6 Citations (the issue's own request) and one of 20.
 */

export type PaperName = "Weighted Keys Shorter Paths" | "Demonstrations Not Weights";

export interface Claim {
  paper: PaperName;
  page: number;
  quote: string;
  en: string;
  zh?: string;
}

const CALVENTIS: PaperName = "Weighted Keys Shorter Paths";
const BRELLAN: PaperName = "Demonstrations Not Weights";

export const CLAIMS: readonly Claim[] = [
  {
    paper: CALVENTIS,
    page: 1,
    quote:
      "the Calventis model is assembled entirely from weighted-key lookups, with no recurrent or convolutional part anywhere in it.",
    en: "The Calventis model relies on weighted-key lookups alone, with no recurrence or convolutions",
    zh: "Calventis 模型只依靠加权键查找，完全不用循环和卷积",
  },
  {
    paper: CALVENTIS,
    page: 8,
    quote: "reaching 34.6 BLEU",
    en: "Its large model reached 34.6 BLEU on German-English translation",
    zh: "它的大模型在德英翻译上取得了 34.6 的 BLEU",
  },
  {
    paper: CALVENTIS,
    page: 1,
    quote: "The largest configuration trained for 4.5 days on twelve accelerator cards",
    en: "The largest configuration trained for 4.5 days on twelve accelerator cards",
    zh: "最大的配置在十二块加速卡上训练了 4.5 天",
  },
  {
    paper: BRELLAN,
    page: 5,
    quote:
      "training a 220 billion parameter autoregressive language model, which we call Brellan-220B",
    en: "Brellan-220B is an autoregressive language model with 220 billion parameters",
    zh: "Brellan-220B 是一个拥有 2200 亿参数的自回归语言模型",
  },
  {
    paper: BRELLAN,
    page: 8,
    quote: "Every model in the family saw 210 billion tokens.",
    en: "Every model in the family was trained on 210 billion tokens",
    zh: "家族里的每个模型都用 2100 亿个词元训练",
  },
  {
    paper: BRELLAN,
    page: 5,
    quote: "Zero-shot scores rise steadily with size, and few-shot scores rise faster.",
    en: "Few-shot scores grow faster with model size than zero-shot scores",
    zh: "随着模型变大，少样本分数的提升比零样本更快",
  },
  {
    paper: CALVENTIS,
    page: 3,
    quote: "Each stack holds seven identical blocks.",
    en: "Each stack holds seven identical blocks",
  },
  {
    paper: CALVENTIS,
    page: 5,
    quote: "The base model runs twelve attention heads in each layer.",
    en: "It uses twelve attention heads in each layer",
  },
  {
    paper: CALVENTIS,
    page: 6,
    quote: "Each position is encoded with sinusoids of geometrically spaced frequencies.",
    en: "Positions are encoded with sinusoids of geometrically spaced frequencies",
  },
  {
    paper: CALVENTIS,
    page: 9,
    quote: "With one head, the score falls by 2.5 BLEU against the best setting.",
    en: "A single head scores 2.5 BLEU below the best setting",
  },
  {
    paper: CALVENTIS,
    page: 8,
    quote:
      "It costs perplexity, since the model is less sure of itself, but it gains accuracy and BLEU.",
    en: "Label smoothing costs perplexity but gains accuracy and BLEU",
  },
  {
    paper: CALVENTIS,
    page: 10,
    quote: "The model does remarkably well here even though nothing was tuned for parsing",
    en: "Without task-specific tuning it did remarkably well at parsing",
  },
  {
    paper: CALVENTIS,
    page: 7,
    quote: "Attention can also make a model easier to interpret, which is a useful side effect.",
    en: "Attention may also make models easier to interpret",
  },
  {
    paper: BRELLAN,
    page: 8,
    quote: "Our eight sizes span 110 million to 220 billion parameters",
    en: "Its eight model sizes range from 110 million to 220 billion parameters",
  },
  {
    paper: BRELLAN,
    page: 8,
    quote: "The architecture follows Wrennick-LM, with the changes noted below.",
    en: "It reuses the Wrennick-LM architecture",
  },
  {
    paper: BRELLAN,
    page: 9,
    quote:
      "some parts of the mixture were repeated up to 2.6 times, others were never seen in full.",
    en: "Some parts of the mixture were repeated up to 2.6 times, others never seen in full",
  },
  {
    paper: BRELLAN,
    page: 34,
    quote:
      "Text-only training leaves a model with no grounding in video, touch or the physical world.",
    en: "Such models are not grounded in video or physical interaction",
  },
  {
    paper: BRELLAN,
    page: 34,
    quote: "Pre-training is also hungry for data: reaching this quality took an enormous corpus.",
    en: "Language models learn sample-inefficiently during pre-training",
  },
  {
    paper: BRELLAN,
    page: 36,
    quote: "A model trained on the open web inherits the web's biases, at web scale.",
    en: "Internet-trained models carry internet-scale biases",
  },
  {
    paper: BRELLAN,
    page: 35,
    quote: "Better text synthesis also means more scope for misuse.",
    en: "The risk of misuse rises as generated text gets better",
  },
];

export const LIMITATION = {
  en: "These two Documents do not establish a unified evaluation across later domains.",
  zh: "这两份文档并没有建立跨后续领域的统一评估。",
};

export interface ReportCase {
  id: string;
  language: "en" | "zh-CN";
  /** The claims the Mind holds, by their place in `CLAIMS`. */
  claims: readonly number[];
  request: string;
}

const SIX = [0, 1, 2, 3, 4, 5];
const TWENTY = CLAIMS.map((_, index) => index);

export const CASES: readonly ReportCase[] = [
  {
    id: "six-en",
    language: "en",
    claims: SIX,
    request:
      "Turn this Mind into a concise report draft in your Answer, with Title, Summary, Evidence, and Limits sections, at most 140 words. Preserve the source Citations on retained factual claims and the limitation that these two Documents do not establish a unified evaluation across later domains. Do not add outside sources, use Connectors, or modify the current Mind until I add the Answer myself.",
  },
  {
    id: "six-zh",
    language: "zh-CN",
    claims: SIX,
    request:
      "把这个 Mind 整理成一份简洁的报告草稿，写在你的回答里，包含标题、摘要、证据和局限四个部分，不超过 300 字。保留已有事实陈述上的来源引用，以及“这两份文档并没有建立跨后续领域的统一评估”这一局限。不要添加外部来源，不要使用连接器，在我自己添加回答之前不要修改当前 Mind。",
  },
  {
    id: "twenty-en",
    language: "en",
    claims: TWENTY,
    request:
      "Turn this Mind into a report draft in your Answer, with Title, Summary, Evidence and Limits sections. Keep every finding with its source Citation, and the limitation that these two Documents do not establish a unified evaluation across later domains. Do not add outside sources or modify the current Mind.",
  },
  {
    id: "six-en-mind",
    language: "en",
    claims: SIX,
    request:
      "Write this Mind up as a short report in a new Mind, keeping the source Citations on its findings and the limitation. Don't add outside sources.",
  },
];
