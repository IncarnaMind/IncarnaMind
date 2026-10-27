import { formatDate } from "../../shared/dates";
import { translate } from "../../shared/i18n";
import { recordCiteResultLabel } from "../checkRecord/labels";
import type { Language } from "../language";
import type { FailedSentence, Footnote, RecordCiteComment } from "../mindText";
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
      const citeText = (cite: RecordCiteComment) => {
        const lines = [
          t("export.comment.recordCite.result", {
            raw: cite.raw,
            outcome: recordCiteResultLabel(cite.outcome, language, t),
          }),
        ];
        if (cite.source) lines.push(cite.source);
        if (cite.passage) {
          lines.push(t("export.comment.recordCite.passage", { passage: cite.passage }));
        }
        if (cite.covered && cite.uncovered) {
          lines.push(
            t("claim.recordCites.covered", {
              covered: cite.covered,
              uncovered: cite.uncovered,
            }),
          );
        } else if (cite.covered) {
          lines.push(t("claim.recordCites.covers", { covered: cite.covered }));
        } else if (cite.uncovered) {
          lines.push(t("claim.recordCites.doesNotCover", { uncovered: cite.uncovered }));
        }
        if (cite.candidates.length > 0) {
          lines.push(
            t("export.comment.recordCite.candidates", {
              candidates: cite.candidates.join(t("export.citation.separator")),
            }),
          );
        }
        if (cite.nearby) lines.push(t("export.comment.recordCite.nearby", cite.nearby));
        return lines.join("\n");
      };
      const done = (overall: string) =>
        [overall, ...(sentence.recordCites ?? []).map(citeText)]
          .filter((text) => text !== "")
          .join("\n");
      if (sentence.check === "record-cites") return done("");
      if (sentence.check === "needs-recheck") {
        return done(t(`export.comment.sentence.needs-recheck.${sentence.why}`));
      }
      if (sentence.check === "cited-case-unchecked") {
        return done(t("export.comment.sentence.citedCaseUnchecked"));
      }
      if (sentence.check === "own-workings") {
        return done(t("export.comment.sentence.ownWorkings"));
      }
      if (sentence.check === "contradicted") {
        if (sentence.says) {
          return done(t("export.comment.sentence.contradicted", { says: sentence.says }));
        }
        return done(
          sentence.worked
            ? t(
                sentence.worked.relation
                  ? `export.comment.sentence.contradicted.worked.${sentence.worked.relation}`
                  : "export.comment.sentence.contradicted.worked",
                sentence.worked,
              )
            : t("export.comment.sentence.contradicted.plain"),
        );
      }
      if (sentence.nearest) {
        return done(t("export.comment.sentence.unsupported.differs", sentence.nearest));
      }
      if (sentence.covers) {
        return done(t("export.comment.sentence.unsupported.covers", sentence.covers));
      }
      if (sentence.citations) {
        const { count, ...part } = sentence.citations;
        return done(
          t(
            count === 1
              ? "export.comment.sentence.unsupported.citation"
              : "export.comment.sentence.unsupported.citations",
            part,
          ),
        );
      }
      if (!sentence.notFound) {
        return done(
          sentence.reason
            ? t("export.comment.sentence.unsupported.reason", { reason: sentence.reason })
            : t("export.comment.sentence.unsupported.plain"),
        );
      }
      const { scope } = sentence;
      const name = scope
        ? (scope.name ?? t(`scope.chip.deleted.${scope.kind}`))
        : t("composer.scope.all");
      return done(
        scope && scope.more > 0
          ? t("export.comment.sentence.notFound.more", {
              scope: name,
              count: scope.more,
              total: scope.more + 1,
            })
          : t("export.comment.sentence.notFound", { scope: name }),
      );
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
  };
}
