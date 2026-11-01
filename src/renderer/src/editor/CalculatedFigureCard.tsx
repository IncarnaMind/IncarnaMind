import type {
  CalculatedFigure,
  Citation,
  FigureFromWorkbook,
  FigureInput,
  SignOffNow,
} from "../../../core/api";
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
import { SignOffLine, SignOffToggle } from "./SignOff";

export function CalculatedFigureCard({
  figure,
  shown,
  replayed,
  sources,
  problem,
  onCopyFormula,
  signOff,
  onSignOff,
}: {
  figure: CalculatedFigure;
  shown: ClaimCheckShown;
  replayed: boolean;
  sources: CalculatedSources | null;
  problem: boolean;
  onCopyFormula(): void;
  /** The User's own check of it (#1933), apart from IncarnaMind's. */
  signOff: SignOffNow | null;
  /** Null where it can't be marked, such as a Note opened read-only. */
  onSignOff: (() => void) | null;
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
        ) : figure.workbook ? (
          <>
            {" · "}
            {t(
              figure.workbook.kept.length > 0
                ? "figures.workbook.savedValue"
                : "figures.workbook.workedOut",
            )}
          </>
        ) : null}
      </p>
      {figure.workbook && <WorkbookChain figure={figure} workbook={figure.workbook} />}
      {!figure.analysis && !figure.workbook && (
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
          {t("error.figure.evidenceMissing")}
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
        !figure.workbook &&
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
            : figure.workbook
              ? "figures.workbook.note"
              : replayed
                ? "figures.inline.note"
                : "figures.inline.savedNote",
        )}
      </p>
      <SignOffLine now={signOff} />
      <div className="calculated-figure-actions">
        {onSignOff && (
          <SignOffToggle
            now={signOff}
            onToggle={onSignOff}
            className={buttonStyle("secondary", "sm")}
          />
        )}
        <button
          type="button"
          className={buttonStyle("ghost", "sm")}
          onClick={() => onCopyFormula()}
        >
          {t("figures.inline.copyFormula")}
        </button>
      </div>
    </>
  );
}

/**
 * A workbook figure's own formula and the formulas between it and its inputs
 * (#2347), each by its headings and cell; a what-if's changed input; and the
 * cells that kept the values the workbook saved.
 */
function WorkbookChain({
  figure,
  workbook,
}: {
  figure: CalculatedFigure;
  workbook: FigureFromWorkbook;
}) {
  const t = useT();
  const language = useLanguage();
  const changed = workbook.change
    ? figure.inputs.find((input) => input.name === workbook.change?.input)
    : undefined;
  const cell = (sheet: string, ref: string | null) => (ref ? `${sheet}!${ref}` : sheet);
  return (
    <>
      <div className="calculated-figure-formula">
        <p>
          {workbook.cell.label} · {cell(workbook.cell.sheet, workbook.cell.ref)} ={" "}
          {workbook.cell.formula}
        </p>
        {workbook.steps.map((step) => (
          <p key={`${step.sheet}!${step.ref}`}>
            {step.label} · {cell(step.sheet, step.ref)} = {step.formula}
          </p>
        ))}
        {workbook.formulaCells > workbook.steps.length + 1 && (
          <p>
            {t("figures.workbook.formulas", {
              count: shownNumber(workbook.formulaCells, language),
            })}
          </p>
        )}
      </div>
      {changed && workbook.change && (
        <p className="calculated-figure-note">
          {t("figures.workbook.change", {
            input: changed.label,
            cell: cell(changed.cell?.sheet ?? "", changed.cell?.ref ?? null),
            from: changed.number.chars,
            to: workbook.change.shown,
          })}
        </p>
      )}
      {workbook.change && (
        <p className="calculated-figure-note">
          {t("figures.workbook.inWorkbook", { value: workbook.savedShown })}
        </p>
      )}
      {workbook.kept.map((kept) => (
        <p
          key={`${kept.sheet}!${kept.ref ?? ""}:${kept.reason}`}
          className="calculated-figure-problem"
        >
          {t(`figures.workbook.kept.${kept.reason}`, {
            cell: cell(kept.sheet, kept.ref),
            name: kept.name ?? "",
          })}
        </p>
      ))}
      {workbook.moreInputs > 0 && (
        <p className="calculated-figure-note">
          {t("figures.workbook.moreInputs", {
            count: shownNumber(workbook.moreInputs, language),
          })}
        </p>
      )}
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
