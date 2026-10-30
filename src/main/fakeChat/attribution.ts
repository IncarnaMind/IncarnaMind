import type { ClaimFacetPeriod } from "../../core/api";
import { formatClaimFacetPeriod } from "../../shared/dates";
import { passagesIn } from "./passages";
import {
  type GenerateOptions,
  type Prompt,
  type Reply,
  systemOf,
  toolResults,
  userText,
} from "./prompt";

const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;
const day = (date: Date) => date.toISOString().slice(0, 10);
const fresh: ClaimFacetPeriod = {
  start: day(new Date(Date.UTC(year, month - 1, 1))),
  end: day(new Date(Date.UTC(year, month, 0))),
  precision: "month",
};
const stale: ClaimFacetPeriod = { start: "2023-03-01", end: "2023-03-31", precision: "month" };

export const ATTRIBUTION_SMOKE = {
  en: {
    residents: "Residents record",
    firstFolder: "Home company",
    secondFolder: "Group company",
    source: "According to Residents record, Nora lives in Oslo.",
    sourceWords: "According to Residents record",
    sourceFact: "Nora lives in Oslo.",
    firstQuote: "In March 2023, Nora lives in Oslo.",
    secondQuote: "In March 2024, Nora lives in Bergen.",
    wrong: "According to Archive record, Elise lives in York.",
    wrongWords: "According to Archive record",
    wrongName: "Archive record",
    wrongFact: "Elise lives in York.",
    actualName: "Housing register",
    corrected: "According to Housing register, Elise lives in York.",
    correctedWords: "According to Housing register",
    transcriptName: "Site visit call",
    speaker: "Zhang said the Leeds plant runs at full capacity.",
    speakerWords: "Zhang said",
    speakerFact: "the Leeds plant runs at full capacity.",
    spoken: "The Leeds plant runs at full capacity.",
    staleName: "Old loan statement",
    stale: "Bramley currently pays 5% on its term loan.",
    staleFact: "pays 5% on its term loan.",
    staleQuote: "In March 2023, Bramley paid 5% on its term loan.",
    anchored: "In March 2023, Bramley paid 5% on its term loan.",
    noPeriodName: "Undated loan statement",
    noPeriod: "Larch currently pays 5% on its term loan.",
    noPeriodFact: "pays 5% on its term loan.",
    noPeriodQuote: "Larch pays 5% on its term loan.",
    freshName: "Current loan statement",
    recent: "Elm currently pays 5% on its term loan.",
    recentFact: "pays 5% on its term loan.",
    recentQuote: `In ${formatClaimFacetPeriod(fresh, "en")}, Elm pays 5% on its term loan.`,
    when: "currently",
  },
  "zh-CN": {
    residents: "住户记录",
    firstFolder: "本地公司",
    secondFolder: "集团公司",
    source: "据住户记录，诺拉住在奥斯陆。",
    sourceWords: "据住户记录",
    sourceFact: "诺拉住在奥斯陆。",
    firstQuote: "2023年3月，诺拉住在奥斯陆。",
    secondQuote: "2024年3月，诺拉住在卑尔根。",
    wrong: "据档案记录，伊莉丝住在约克。",
    wrongWords: "据档案记录",
    wrongName: "档案记录",
    wrongFact: "伊莉丝住在约克。",
    actualName: "住房登记册",
    corrected: "据住房登记册，伊莉丝住在约克。",
    correctedWords: "据住房登记册",
    transcriptName: "现场考察通话",
    speaker: "张三说利兹工厂满负荷运转。",
    speakerWords: "张三说",
    speakerFact: "利兹工厂满负荷运转。",
    spoken: "利兹工厂满负荷运转。",
    staleName: "旧贷款说明",
    stale: "布拉姆利目前的定期贷款利率为5%。",
    staleFact: "的定期贷款利率为5%。",
    staleQuote: "2023年3月，布拉姆利的定期贷款利率为5%。",
    anchored: "2023年3月，布拉姆利的定期贷款利率为5%。",
    noPeriodName: "未注明期间的贷款说明",
    noPeriod: "落叶松目前的定期贷款利率为5%。",
    noPeriodFact: "的定期贷款利率为5%。",
    noPeriodQuote: "落叶松的定期贷款利率为5%。",
    freshName: "本期贷款说明",
    recent: "榆树目前的定期贷款利率为5%。",
    recentFact: "的定期贷款利率为5%。",
    recentQuote: `${formatClaimFacetPeriod(fresh, "zh-CN")}，榆树的定期贷款利率为5%。`,
    when: "目前",
  },
} as const;

export type AttributionLanguage = keyof typeof ATTRIBUTION_SMOKE;
export const ATTRIBUTION_PERIODS = { stale, fresh };

function fixture(text: string) {
  for (const [language, row] of Object.entries(ATTRIBUTION_SMOKE)) {
    if (text === row.source)
      return {
        language,
        row,
        kind: "source" as const,
        words: row.sourceWords,
        fact: row.sourceFact,
        name: row.residents,
        period: undefined,
      };
    if (text === row.wrong || text === row.corrected)
      return {
        language,
        row,
        kind: "source" as const,
        words: text === row.wrong ? row.wrongWords : row.correctedWords,
        fact: row.wrongFact,
        name: text === row.wrong ? row.wrongName : row.actualName,
        period: undefined,
      };
    if (text === row.speaker)
      return {
        language,
        row,
        kind: "speaker" as const,
        words: row.speakerWords,
        fact: row.speakerFact,
        name: row.transcriptName,
        period: undefined,
      };
    if (text === row.stale || text === row.noPeriod || text === row.recent)
      return {
        language,
        row,
        kind: "time" as const,
        words: row.when,
        fact:
          text === row.stale
            ? row.staleFact
            : text === row.noPeriod
              ? row.noPeriodFact
              : row.recentFact,
        name:
          text === row.stale
            ? row.staleName
            : text === row.noPeriod
              ? row.noPeriodName
              : row.freshName,
        period: text === row.stale ? stale : text === row.recent ? fresh : undefined,
      };
    if (text === row.anchored)
      return {
        language,
        row,
        kind: null,
        words: "",
        fact: row.anchored,
        name: row.staleName,
        period: undefined,
      };
  }
  return null;
}

export function attributionParts(text: string) {
  const found = fixture(text);
  return found
    ? [
        ...(found.kind
          ? [{ kind: "fact" as const, text: found.words, facet: { kind: found.kind } }]
          : []),
        { kind: "fact" as const, text: found.fact },
      ]
    : null;
}

export function attributionPreamble(prompt: Prompt): string | null {
  if (toolResults(prompt, "search_documents").length > 0) return null;
  const first = userText(prompt.find((message) => message.role === "user"));
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(first)?.[1] ?? "";
  const parts = attributionParts(sentence);
  return parts ? `Parts: ${JSON.stringify(parts)}\n` : null;
}

export function attributionReply(prompt: Prompt): Reply | null {
  const first = userText(prompt.find((message) => message.role === "user"));
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(first)?.[1] ?? "";
  const found = fixture(sentence);
  if (!found) return null;
  const { row, kind, words, fact, name, period } = found;
  const searched = toolResults(prompt, "search_documents").at(-1);
  if (searched === undefined) {
    const declared =
      /Judge these exact facet targets in that complete assertion, in this same Run:\n([^\n]+)/.exec(
        first,
      )?.[1];
    const facets: unknown = declared ? JSON.parse(declared) : [];
    const selected = Array.isArray(facets)
      ? facets.find(
          (facet: unknown) =>
            typeof facet === "object" &&
            facet !== null &&
            "kind" in facet &&
            facet.kind === "source" &&
            "document" in facet &&
            typeof facet.document === "string",
        )
      : undefined;
    const document =
      selected &&
      typeof selected === "object" &&
      "document" in selected &&
      typeof selected.document === "string"
        ? selected.document
        : kind === "source"
          ? undefined
          : name;
    return { tool: "search_documents", input: { query: fact, ...(document && { document }) } };
  }
  const quotes =
    kind === "source"
      ? sentence === row.source
        ? [row.firstQuote, row.secondQuote]
        : [row.wrongFact]
      : kind === "speaker"
        ? [row.spoken]
        : [row.staleQuote, row.noPeriodQuote, row.recentQuote];
  const passages = passagesIn(searched);
  const citations = quotes
    .flatMap((quote) => {
      const passage = passages.find((passage) => passage.text.includes(quote));
      return passage ? [{ marker: 0, passage: passage.id, quote }] : [];
    })
    .map((citation, index) => ({ ...citation, marker: index + 1 }));
  const quote = citations[0]?.quote;
  const passage = citations[0]?.passage;
  if (!quote || !passage)
    return { text: "Verdict: unsupported\nAbsence: no\nCalculation: none\nEvidence: []" };
  if (toolResults(prompt, "cite").length === 0) return { tool: "cite", input: { citations } };
  const contradicted = quote === row.secondQuote;
  const verdict = contradicted ? "contradicted" : "supported";
  const asked = /<figures>\n([\s\S]*?)\n<\/figures>/.exec(first)?.[1];
  const figures: unknown = asked ? JSON.parse(asked) : [];
  const items = Array.isArray(figures)
    ? figures.flatMap((figure: unknown) =>
        typeof figure === "object" &&
        figure !== null &&
        "id" in figure &&
        typeof figure.id === "string"
          ? [
              {
                id: figure.id,
                verdict,
                scope: "same",
                topic: "found",
                roles: "same",
                says: quote,
                reading: null,
                relation: "equals",
                source: { citation: 1, number: "5%" },
                calculation: null,
              },
            ]
          : [],
      )
    : [];
  return {
    text: [
      `Parts: ${JSON.stringify(attributionParts(sentence))}`,
      `Verdict: ${verdict}`,
      "Scope: none, same",
      "Topic: found",
      "Roles: none, same",
      "Absence: no",
      "Calculation: none",
      "Evidence: [1]",
      `${quote} [^1]`,
      ...(items.length ? [`Figures: ${JSON.stringify({ items, remainder: null })}`] : []),
      ...(kind
        ? [
            `Facets: ${JSON.stringify({ items: [{ kind, text: words, occurrence: 1, verdict: "supported", scope: "same", topic: "found", roles: "same", says: quote, evidence: kind === "source" && sentence === row.source ? citations.map((citation) => citation.marker) : [1], ...(kind === "source" && { sourceName: name }), ...(kind === "time" && { time: "present", ...(period && { period }) }), ...(kind === "speaker" && { claimedSpeaker: found.language === "en" ? "Zhang" : "张三", actualSpeaker: "Speaker 2", actualSpeakerNamed: false, speakerOrigin: "cue" }) }] })}`,
          ]
        : []),
    ].join("\n"),
  };
}

export function attributionConfirm(options: GenerateOptions): string | null {
  if (!systemOf(options.prompt).startsWith("Compare a sentence")) return null;
  const text = options.prompt.map((message) => userText(message)).join("\n");
  const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(text)?.[1] ?? "";
  const found = fixture(sentence);
  return found?.kind === "source" &&
    sentence === found.row.source &&
    text.includes(found.row.secondQuote)
    ? "conflict"
    : null;
}

export function attributionEdit(passage: string, instruction: string): string | null {
  for (const row of Object.values(ATTRIBUTION_SMOKE)) {
    if (
      passage.replace(/\s*\[\d+\]/g, "") === row.wrong &&
      instruction.includes(`Change only the attribution to ${JSON.stringify(row.actualName)}`)
    )
      return `${row.corrected}${(passage.match(/\[\d+\]/g) ?? []).join("")}`;
    if (
      passage.replace(/\s*\[\d+\]/g, "") === row.stale &&
      instruction.includes("Anchor the sentence to March 2023")
    )
      return `${row.anchored}${(passage.match(/\[\d+\]/g) ?? []).join("")}`;
  }
  return null;
}
