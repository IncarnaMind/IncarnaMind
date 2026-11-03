export const OPINION_WORDS = {
  en: {
    fact: "Revenue rose 8%; ",
    opinion: "we think the deal is risky.",
    pure: "We believe the outlook is bright.",
    forecast: "Revenue will reach £10m in 2027.",
    quote: "Revenue is forecast to reach £10m in 2027.",
    anyway: "Check anyway",
    omitted: "2 opinions left out",
    wording: "Use the Document’s wording",
    attributed: "The committee’s view is that the deal is risky because costs rose 40%.",
    attributedView: "The committee’s view is that the deal is risky",
    attributedFact: "costs rose 40%",
    verifyOpinion: "The deal is too risky to approve.",
  },
  "zh-CN": {
    fact: "收入增长了 8%；",
    opinion: "我们认为这笔交易风险很大。",
    pure: "我们相信前景光明。",
    forecast: "2027 年收入将达到 1000 万英镑。",
    quote: "预计 2027 年收入将达到 1000 万英镑。",
    anyway: "仍然核对",
    omitted: "2 处观点未纳入核对",
    wording: "改为文档的说法",
    attributed: "委员会认为这笔交易有风险，因为成本上涨了 40%。",
    attributedView: "委员会认为这笔交易有风险",
    attributedFact: "成本上涨了 40%",
    verifyOpinion: "这笔交易风险太大，不宜批准。",
  },
} as const;

export function opinionSource(language: keyof typeof OPINION_WORDS): string {
  const words = OPINION_WORDS[language];
  return `${words.fact}\n${words.opinion}\n${words.pure}\n${words.quote}\n${words.attributed}\nQ1, Q2, Q3, Q4: the quarters of 2026.\n${Array.from({ length: 6 }, (_, index) => (language === "en" ? `Part ${index + 1} grew` : `第 ${index + 1} 项增长`)).join("\n")}\n${[1, 2, 3].map((quarter) => `Q${quarter}: ${words.fact.trim()}`).join("\n")}`;
}
