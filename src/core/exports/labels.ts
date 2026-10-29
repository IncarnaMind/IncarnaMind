import { formatDate } from "../../shared/dates";
import { translate } from "../../shared/i18n";
import type { Language } from "../language";
import type { FailedSentence, Footnote } from "../mindText";
import type { NotedChange } from "../shownChanges";

export interface ExportLabels {
  question: string;
  notes: string;
  backToText: string;
  unverified: string;
  chart(title: string): string;
  /** With the space that follows it, if any: "Source: ", "数据来源：". */
  chartSources: string;
  chartUncited(count: number): string;
  chartCut(rows: number, total: number): string;
  /** A Word file's comment on AI text (#107). */
  aiText: string;
  /** A Word file's comment on a Citation whose check failed: what failed, and the source. */
  failedCheck(footnote: Footnote): string;
  /** A Word file's comment on a sentence whose check isn't good: its result, and why. */
  failedSentence(sentence: FailedSentence): string;
  /** Who made someone's change shown in an export, and when (#734): "Deleted by Priya Nair, 2 Oct 2026". */
  change(change: NotedChange): string;
  /**
   * A calculated figure's note in Numbered (#439): how it was worked out, then each source with
   * the inputs from it. "Calculated: (Revenue 2025 − Revenue 2024) ÷ Revenue 2024 = 20.4%.
   * Revenue 2025 and Revenue 2024: Acme Annual Report 2025, p. 4."
   */
  figureNote(worked: FigureWorked, figure: string, sources: readonly FigureNoteSource[]): string;
  /** The words before and after a calculated figure's inputs' cluster in a citation style: "calculated from ", "". */
  figureCluster(note: boolean): [before: string, after: string];
}

/** How a calculated figure was worked out: its formula in words, or the saved Analysis it came from. */
export type FigureWorked = { formula: string } | { analysis: string };

export interface FigureNoteSource {
  inputs: readonly string[];
  source: string;
  unverified: boolean;
}

const FULL_WIDTH_END = /[\u3000-\u303f\uff00-\uffef]$/;

/** "A and B", "A、B 和 C": a space where 和 meets a Latin letter or a digit (docs/agents/zh-CN.md). */
function listOf(items: readonly string[], language: Language): string {
  const latin = /[A-Za-z0-9%]/;
  return new Intl.ListFormat(language, { type: "conjunction" })
    .formatToParts(items)
    .map((part, at, parts) => {
      if (part.type !== "literal" || !/^\p{Script=Han}+$/u.test(part.value)) return part.value;
      const before = latin.test(parts[at - 1]?.value.at(-1) ?? "") ? " " : "";
      const after = latin.test(parts[at + 1]?.value.charAt(0) ?? "") ? " " : "";
      return before + part.value + after;
    })
    .join("");
}

export function exportLabels(language: Language): ExportLabels {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  return {
    question: t("export.question"),
    notes: t("export.html.notes"),
    backToText: t("export.html.back"),
    unverified: t("export.unverified"),
    chart: (title) => (title ? t("export.chart.titled", { title }) : t("export.chart")),
    // No space after full-width punctuation (docs/agents/zh-CN.md).
    chartSources: t("export.chart.sources").replace(/[^\u3000-\u303f\uff00-\uffef]$/, "$& "),
    chartUncited: (count) =>
      count === 1 ? t("export.chart.uncited.one") : t("export.chart.uncited.other", { count }),
    chartCut: (rows, total) => t("export.chart.cut", { rows, total }),
    aiText: t("export.comment.aiText"),
    failedCheck: ({ source, failed }) => {
      if (!failed) return "";
      const said =
        failed.check === "not-found"
          ? failed.quote
            ? t("export.comment.notFound", { source, quote: failed.quote })
            : t("export.comment.notFound.noQuote", { source })
          : t(`export.comment.${failed.check}`, { source });
      return failed.verdict ? `${said}\n${failed.verdict}` : said;
    },
    failedSentence: (sentence) => {
      if (sentence.check === "needs-recheck") {
        return t(`export.comment.sentence.needs-recheck.${sentence.why}`);
      }
      if (sentence.check === "cited-case-unchecked") {
        return t("export.comment.sentence.citedCaseUnchecked");
      }
      if (sentence.check === "own-workings") return t("export.comment.sentence.ownWorkings");
      if (sentence.check === "contradicted") {
        const said = sentence.says
          ? t("export.comment.sentence.contradicted", { says: sentence.says })
          : sentence.worked
            ? t(
                sentence.worked.relation
                  ? `export.comment.sentence.contradicted.worked.${sentence.worked.relation}`
                  : "export.comment.sentence.contradicted.worked",
                sentence.worked,
              )
            : t("export.comment.sentence.contradicted.plain");
        return sentence.quoted
          ? t("export.comment.sentence.quoted", {
              said: said.replace(/[.。]$/u, ""),
              ...sentence.quoted,
            })
          : said;
      }
      if (sentence.nearest)
        return t("export.comment.sentence.unsupported.differs", sentence.nearest);
      if (sentence.covers) return t("export.comment.sentence.unsupported.covers", sentence.covers);
      if (sentence.citations) {
        const { count, ...part } = sentence.citations;
        return t(
          count === 1
            ? "export.comment.sentence.unsupported.citation"
            : "export.comment.sentence.unsupported.citations",
          part,
        );
      }
      if (!sentence.notFound) {
        return sentence.reason
          ? t("export.comment.sentence.unsupported.reason", { reason: sentence.reason })
          : t("export.comment.sentence.unsupported.plain");
      }
      const { scope } = sentence;
      const name = scope
        ? (scope.name ?? t(`scope.chip.deleted.${scope.kind}`))
        : t("composer.scope.all");
      return scope && scope.more > 0
        ? t("export.comment.sentence.notFound.more", {
            scope: name,
            count: scope.more,
            total: scope.more + 1,
          })
        : t("export.comment.sentence.notFound", { scope: name });
    },
    change: ({ kind, pending }) => {
      const author = pending.by || t("export.change.someone");
      // The day the Word file names, not the day it falls on here: Word writes its own clock's time.
      const date = pending.at ? formatDate(pending.at, language, { timeZone: "UTC" }) : "";
      const key = (
        {
          insert: "export.change.inserted",
          delete: "export.change.deleted",
          replace: "export.change.replaced",
        } as const
      )[kind];
      return date ? t(key, { author, date }) : t(`${key}.noDate`, { author });
    },
    figureNote: (worked, figure, sources) =>
      [
        "formula" in worked
          ? t("export.figure.calculated", { formula: worked.formula, figure })
          : t("export.figure.analysis", { title: worked.analysis, figure }),
        ...sources.map(({ inputs, source, unverified }) =>
          t("export.figure.inputs", {
            inputs: listOf(inputs, language),
            source: unverified ? `${source} ${t("export.unverified")}` : source,
          }),
        ),
      ].reduce((text, sentence) =>
        // No space after full-width punctuation (docs/agents/zh-CN.md).
        FULL_WIDTH_END.test(text) ? text + sentence : `${text} ${sentence}`,
      ),
    figureCluster: (note) => {
      const [before = "", after = ""] = t(
        note ? "export.figure.cluster.note" : "export.figure.cluster",
        { cluster: "\u0000" },
      ).split("\u0000");
      return [before, after];
    },
  };
}
