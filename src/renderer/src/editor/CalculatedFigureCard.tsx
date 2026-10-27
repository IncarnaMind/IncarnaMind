import type { CalculatedFigure, Citation, FigureInput } from "../../../core/api";
import { badgeMessage, citationState } from "../../../shared/citations";
import type { ClaimCheckShown } from "../../../shared/claimChecks";
import type { CalculatedSources } from "../../../shared/figureRuns";
import { shownNumber } from "../../../shared/figureSchedule";
import { formulaText } from "../../../shared/formula";
import { sourceText } from "../../../shared/sources";
import { buttonStyle } from "../components/ui";
import { useLanguage, useT } from "../i18n";
import { openCited } from "../openCited";
import { useAppStore } from "../store";
import { QuoteWithUnsureWords, ScanLine, useScannedQuote } from "./citationScan";

export function CalculatedFigureCard({
  figure,
  shown,
  replayed,
  sources,
  problem,
  onCopyFormula,
}: {
  figure: CalculatedFigure;
  shown: ClaimCheckShown;
  replayed: boolean;
  sources: CalculatedSources | null;
  problem: boolean;
  onCopyFormula(): void;
}) {
  const t = useT();
  const stateKey =
    shown.state === "kept" ? "claim.keptAsView" : (`claim.state.${shown.state}` as const);
  const needsLook =
    shown.state === "unsupported" ||
    shown.state === "contradicted" ||
    shown.state === "needs-recheck";
  const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
  return (
    <>
      <h3>
        {t("figures.calculated")} · <strong>{figure.shown}</strong>
      </h3>
      <p className="calculated-figure-state">
        {needsLook ? (
          <>
            {t("figures.filter.look")} · {t(stateKey)}
          </>
        ) : (
          t(stateKey)
        )}
        {replayed ? (
          <> · {t("figures.inline.recalculated")}</>
        ) : figure.analysis ? (
          <> · {t("figures.inline.retained")}</>
        ) : null}
      </p>
      {!figure.analysis && (
        <div className="calculated-figure-formula">
          <p>
            {formulaText(figure.formula, (name) => byName.get(name.toLowerCase())?.label ?? null)}
          </p>
          <p>
            ={" "}
            {formulaText(
              figure.formula,
              (name) => byName.get(name.toLowerCase())?.number.chars ?? null,
            )}{" "}
            = {figure.shown}
          </p>
        </div>
      )}
      {problem && (
        <p className="calculated-figure-problem" role="alert">
          {t("figures.evidenceMissing")}
        </p>
      )}
      {sources?.inputs.map((input) => (
        <CalculationInput
          key={JSON.stringify([input.name, input.citation.passageId, input.number.at])}
          input={input}
        />
      ))}
      {sources?.ranges.map((range) => (
        <div
          key={JSON.stringify([range.name, range.citation.passageId, range.range])}
          className="calculated-figure-input"
        >
          <strong>
            {range.name} · {range.range}
          </strong>
          <CalculationQuote citation={range.citation} />
        </div>
      ))}
      {!figure.analysis &&
        figure.literals.map((literal) => (
          <p key={`${literal.at}:${literal.text}`} className="calculated-figure-note">
            {t("figures.inline.literal", { value: literal.text })}
          </p>
        ))}
      {sources?.analysis && (
        <details className="calculated-figure-code">
          <summary>{t("figures.inline.code")}</summary>
          <p>{t("figures.inline.analysis", { title: sources.analysis.title })}</p>
          <pre>
            <code>{sources.analysis.code}</code>
          </pre>
        </details>
      )}
      <p className="calculated-figure-note">
        {t(
          figure.analysis
            ? "figures.inline.analysisNote"
            : replayed
              ? "figures.inline.note"
              : "figures.inline.savedNote",
        )}
      </p>
      <button type="button" className={buttonStyle("ghost", "sm")} onClick={() => onCopyFormula()}>
        {t("figures.inline.copyFormula")}
      </button>
    </>
  );
}

function CalculationInput({ input }: { input: FigureInput }) {
  const t = useT();
  const language = useLanguage();
  return (
    <div className="calculated-figure-input">
      <div className="calculated-figure-input-value">
        <strong>{input.label}</strong>
        <span>{input.number.chars}</span>
      </div>
      {input.cell && (
        <p className="calculated-figure-note">
          {input.cell.sheet ? `${input.cell.sheet}!` : ""}
          {input.cell.ref}
          {input.cell.stored !== null && (
            <> · {t("figures.inline.raw", { value: shownNumber(input.cell.stored, language) })}</>
          )}
        </p>
      )}
      <CalculationQuote citation={input.citation} />
      {input.unitStatement && (
        <div className="calculated-figure-unit">
          <span>{t("figures.unitQuote")}</span>
          <CalculationQuote citation={input.unitStatement.citation} />
        </div>
      )}
    </div>
  );
}

function CalculationQuote({ citation }: { citation: Citation }) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) => state.documents);
  const scanned = useScannedQuote(citation);
  const state = citationState(citation, documents);
  const badge = badgeMessage(state, citation, t);
  return (
    <>
      <div className="calculated-figure-source">
        <span>{sourceText(citation, { language, documents }).text}</span>
        <button
          type="button"
          onClick={() => openCited(citation, { check: citation.check, withQuote: true })}
        >
          {t("figures.inline.openInput")}
        </button>
      </div>
      <p className="calculated-figure-note">
        {t("figures.inline.original")} · {t(badge.key, badge.params)}
      </p>
      {scanned && <ScanLine scanned={scanned} />}
      <blockquote>
        {scanned ? (
          <QuoteWithUnsureWords quote={citation.quote} unsure={scanned.unsure} />
        ) : (
          citation.quote
        )}
      </blockquote>
    </>
  );
}
