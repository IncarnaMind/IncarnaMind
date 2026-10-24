/**
 * A cited Mind turned into a report (#1800): the claims its Notes make, each cited where its
 * quote is in one of two sample papers, and the requests, in English and Chinese, from a Mind of
 * 6 Citations (the issue's own request) and one of 20.
 */

export type PaperName = "Attention Is All You Need" | "Language Models are Few-Shot Learners";

export interface Claim {
  paper: PaperName;
  page: number;
  quote: string;
  en: string;
  zh?: string;
}

const ATTENTION: PaperName = "Attention Is All You Need";
const GPT3: PaperName = "Language Models are Few-Shot Learners";

export const CLAIMS: readonly Claim[] = [
  {
    paper: ATTENTION,
    page: 1,
    quote:
      "based solely on attention mechanisms, dispensing with recurrence and convolutions entirely",
    en: "The Transformer relies on attention alone, with no recurrence or convolutions",
    zh: "Transformer 只依靠注意力机制，完全不用循环和卷积",
  },
  {
    paper: ATTENTION,
    page: 8,
    quote: "establishing a new state-of-the-art BLEU score of 28.4",
    en: "Its big model set a new state of the art of 28.4 BLEU on English-to-German translation",
    zh: "它的大模型在英德翻译上取得了 28.4 的 BLEU 新纪录",
  },
  {
    paper: ATTENTION,
    page: 1,
    quote: "after training for 3.5 days on eight GPUs",
    en: "For English-to-French it trained for 3.5 days on eight GPUs",
    zh: "英法翻译模型在八块 GPU 上训练了 3.5 天",
  },
  {
    paper: GPT3,
    page: 5,
    quote: "training a 175 billion parameter autoregressive language model, which we call GPT-3",
    en: "GPT-3 is an autoregressive language model with 175 billion parameters",
    zh: "GPT-3 是一个拥有 1750 亿参数的自回归语言模型",
  },
  {
    paper: GPT3,
    page: 8,
    quote: "All models were trained for a total of 300 billion tokens.",
    en: "All of its models were trained on 300 billion tokens",
    zh: "所有模型都用 3000 亿个词元训练",
  },
  {
    paper: GPT3,
    page: 5,
    quote:
      "While zero-shot performance improves steadily with model size, few-shot performance increases more rapidly",
    en: "Few-shot performance grows faster with model size than zero-shot performance",
    zh: "随着模型变大，少样本表现比零样本提升得更快",
  },
  {
    paper: ATTENTION,
    page: 3,
    quote: "The encoder is composed of a stack of N = 6 identical layers.",
    en: "The encoder is a stack of six identical layers",
  },
  {
    paper: ATTENTION,
    page: 5,
    quote: "In this work we employ h = 8 parallel attention layers, or heads.",
    en: "It uses eight parallel attention heads",
  },
  {
    paper: ATTENTION,
    page: 6,
    quote: "In this work, we use sine and cosine functions of different frequencies",
    en: "Positions are encoded with sine and cosine functions of different frequencies",
  },
  {
    paper: ATTENTION,
    page: 9,
    quote: "single-head attention is 0.9 BLEU worse than the best setting",
    en: "A single attention head scores 0.9 BLEU below the best setting",
  },
  {
    paper: ATTENTION,
    page: 8,
    quote:
      "This hurts perplexity, as the model learns to be more unsure, but improves accuracy and BLEU score.",
    en: "Label smoothing hurts perplexity but improves accuracy and BLEU",
  },
  {
    paper: ATTENTION,
    page: 10,
    quote: "despite the lack of task-specific tuning our model performs surprisingly well",
    en: "Without task-specific tuning it did surprisingly well at English constituency parsing",
  },
  {
    paper: ATTENTION,
    page: 7,
    quote: "As side benefit, self-attention could yield more interpretable models.",
    en: "Self-attention may also make models easier to interpret",
  },
  {
    paper: GPT3,
    page: 8,
    quote:
      "ranging over three orders of magnitude from 125 million parameters to 175 billion parameters",
    en: "Its eight model sizes range from 125 million to 175 billion parameters",
  },
  {
    paper: GPT3,
    page: 8,
    quote: "We use the same model and architecture as GPT-2",
    en: "It reuses GPT-2's model and architecture",
  },
  {
    paper: GPT3,
    page: 9,
    quote:
      "some datasets are seen up to 3.4 times during training while other datasets are seen less than once",
    en: "Some datasets were seen up to 3.4 times in training, others less than once",
  },
  {
    paper: GPT3,
    page: 34,
    quote:
      "large pretrained language models are not grounded in other domains of experience, such as video or real-world physical interaction",
    en: "Such models are not grounded in video or real-world physical interaction",
  },
  {
    paper: GPT3,
    page: 34,
    quote:
      "Another limitation broadly shared by language models is poor sample efficiency during pre-training.",
    en: "Language models learn sample-inefficiently during pre-training",
  },
  {
    paper: GPT3,
    page: 36,
    quote: "internet-trained models have internet-scale biases",
    en: "Internet-trained models carry internet-scale biases",
  },
  {
    paper: GPT3,
    page: 35,
    quote:
      "The misuse potential of language models increases as the quality of text synthesis improves.",
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
