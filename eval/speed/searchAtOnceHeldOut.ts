/**
 * Held-out Questions for searching at once (#2706), over the gating set's library
 * (eval/retrieval/questions.json's Documents). Written and committed on 2026-11-07, before any run
 * of the path; no prompt has seen them. Each asks what one Document says on a topic, the shape on
 * which DeepSeek V4.1 Flash searched and read page after page before writing. They aren't the two
 * Questions the path was shaped on (eval:speed's question flow), nor a gating Question's fact.
 * Some ask in the other language from their Document's. The gate is
 * eval/speed/gates/search-at-once.md.
 */
import type { EvalQuestion, ExpectedPassage } from "../lib/evaluationSet";

const at = (document: string, page: number, quote: string): ExpectedPassage => ({
  document,
  pages: [page, page],
  quote,
});

const asked = (
  id: string,
  language: "en" | "zh",
  question: string,
  needed: readonly [ExpectedPassage, ...ExpectedPassage[]],
  crossLingual = false,
): EvalQuestion => ({
  id,
  language,
  crossLingual,
  question,
  expected: needed[0],
  ...(needed.length > 1 && { expectedAll: [...needed] }),
});

export const SEARCH_AT_ONCE_HELD_OUT: readonly EvalQuestion[] = [
  asked(
    "sa-en-01",
    "en",
    "What does Weighted Keys Shorter Paths say about how many attention heads to use?",
    [
      at("weighted-keys", 5, "The base model runs twelve attention heads in each layer."),
      at(
        "weighted-keys",
        9,
        "With one head, the score falls by 2.5 BLEU against the best setting.",
      ),
    ],
  ),
  asked("sa-en-02", "en", "What does Tuning the Tuner say about the workloads it was tested on?", [
    at(
      "tuning-the-tuner",
      5,
      "the second a small convolutional network on colour images, and the third a recurrent network on character text",
    ),
  ]),
  asked("sa-en-03", "en", "What does Tuning the Tuner say about taller stacks of optimisers?", [
    at(
      "tuning-the-tuner",
      7,
      "A tall stack is awkward to set by hand, since every level carries its own step size",
    ),
    at(
      "tuning-the-tuner",
      8,
      "The taller the stack, the flatter the curve of quality against the starting rate",
    ),
  ]),
  asked(
    "sa-en-04",
    "en",
    "What does Demonstrations Not Weights say about how the web part of its training data was chosen?",
    [
      at(
        "demonstrations-not-weights",
        8,
        "The web portion was scored by a classifier trained to tell prose resembling a curated corpus from prose that does not",
      ),
    ],
  ),
  asked("sa-en-05", "en", "What does the MPMA Code say about shared-risk supply agreements?", [
    at(
      "mpma-code",
      36,
      "A shared-risk supply agreement is an arrangement under which a company makes a payment or a reduction in price",
    ),
    at("mpma-code", 36, "Clause 19.1 does not prevent the use of shared-risk supply agreements."),
  ]),
  asked(
    "sa-en-06",
    "en",
    "What does the Norvath Assembly's report say about food insecurity in 2022?",
    [
      at("norvath-assembly", 26, "People in acute food insecurity 189 M 214 M"),
      at("norvath-assembly", 26, "Countries facing acute food insecurity 44 47"),
    ],
  ),
  asked("sa-en-07", "en", "How does the World Development Report define who is a migrant?", [
    at(
      "real-wdr-2023",
      1,
      "This Report defines migrants as people who live outside their country of nationality",
    ),
    at(
      "real-wdr-2023",
      1,
      "It does not consider as migrants people who have been naturalized in their country of residence",
    ),
  ]),
  asked(
    "sa-en-08",
    "en",
    "What does China's 2023 statistical communiqué say about prices?",
    [
      at("real-nbs-communique-2023", 3, "全年居民消费价格比上年上涨0.2%"),
      at("real-nbs-communique-2023", 3, "工业生产者出厂价格下降3.0%"),
    ],
    true,
  ),
  asked(
    "sa-en-09",
    "en",
    "What does the Wikipedia article on large language models say about where they came from?",
    [at("维基百科-大型语言模型", 1, "LLM 源于早期的统计语言模型、神经概率语言模型和循环神经网络")],
    true,
  ),
  asked(
    "sa-en-10",
    "en",
    "What does the Wikipedia article on the attention mechanism say it is used for?",
    [at("维基百科-注意力机制", 1, "注意力机制的用途包括神经图灵机中的记忆功能")],
    true,
  ),
  asked("sa-zh-01", "zh", "ESG 条目里，批评者对 ESG 相关产品是怎么说的？", [
    at(
      "维基百科-环境-社会和公司治理",
      1,
      "批評者聲稱ESG相關產品沒有、也不太可能會讓污染企業的成本升高",
    ),
    at("维基百科-环境-社会和公司治理", 1, "並指責其為一種漂綠運動"),
  ]),
  asked("sa-zh-02", "zh", "大型语言模型条目对词元化是怎么讲的？", [
    at("维基百科-大型语言模型", 2, "因此必须将文本转换为数字表示的词元"),
  ]),
  asked("sa-zh-03", "zh", "统计公报里关于就业说了什么？", [
    at("real-nbs-communique-2023", 2, "全年全国城镇调查失业率平均值为5.2%"),
  ]),
  asked("sa-zh-04", "zh", "统计公报里 2023 年的人口有什么变化？", [
    at("real-nbs-communique-2023", 2, "比上年末减少208万人"),
  ]),
  asked("sa-zh-05", "zh", "梯度下降法条目说它在机器学习里有什么用？", [
    at(
      "维基百科-梯度下降法",
      1,
      "梯度下降法在机器学习中对于成本的最小化或损失函数的最小化都特别有用",
    ),
  ]),
  asked("sa-zh-06", "zh", "可持续发展目标条目对消除贫困是怎么说的？", [
    at("维基百科-可持续发展目标", 1, "消除貧困必須與一系列戰略齊頭並進"),
  ]),
  asked("sa-zh-07", "zh", "大型语言模型条目里关于 BERT 说了什么？", [
    at("维基百科-大型语言模型", 2, "BERT 是一个仅编码器的模型"),
  ]),
  asked(
    "sa-zh-08",
    "zh",
    "Tuning the Tuner 报告说学到的步长会呈现什么样的规律？",
    [
      at(
        "tuning-the-tuner",
        4,
        "Learned step sizes settle into a recognisable pattern: a quick fall early on, then a plateau",
      ),
    ],
    true,
  ),
  asked(
    "sa-zh-09",
    "zh",
    "Weighted Keys Shorter Paths 报告里关于句法分析这个任务说了什么？",
    [
      at(
        "weighted-keys",
        10,
        "The model does remarkably well here even though nothing was tuned for parsing",
      ),
    ],
    true,
  ),
  asked(
    "sa-zh-10",
    "zh",
    "Demonstrations Not Weights 报告说每个模型训练时见过多少词元？",
    [at("demonstrations-not-weights", 8, "Every model in the family saw 210 billion tokens.")],
    true,
  ),
];
