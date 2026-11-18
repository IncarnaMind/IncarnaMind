import { type FormEvent, useEffect, useId, useState } from "react";
import type { WorkbookSheetChoice } from "../../../core/api";
import { useLanguage, useT } from "../i18n";
import { checkWorkbook, closeWorkbookChoice, useVerify, type WorkbookProblem } from "../verify";
import { DocumentLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import {
  buttonClass,
  choiceListClass,
  choiceRadioClass,
  choiceRowClass,
  choiceTextClass,
  choiceTitleClass,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

const hasContent = (sheet: WorkbookSheetChoice) => sheet.typed + sheet.formulas > 0;

/**
 * "Check someone else's file…" on a workbook (#3278): which sheet to check, and, if the User
 * wants, a range of it. Each sheet says what it holds, so a sheet of assumptions and one of
 * formulas read differently; the first with anything in it is chosen. A sheet or range the core
 * can't take says why here, and the User chooses again.
 */
export function WorkbookSheetDialog() {
  const t = useT();
  const language = useLanguage();
  const choosing = useVerify((state) => state.choosing);
  const dialog = useModal(choosing !== null);
  const id = useId();
  const [sheet, setSheet] = useState("");
  const [range, setRange] = useState("");
  const path = choosing?.path ?? null;
  const sheets = choosing?.sheets;

  useEffect(() => {
    if (path === null) return;
    setRange("");
    setSheet((sheets?.find(hasContent) ?? sheets?.[0])?.name ?? "");
  }, [path, sheets]);

  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const detail = (each: WorkbookSheetChoice) =>
    hasContent(each)
      ? [
          each.typed > 0 &&
            t(each.typed === 1 ? "verify.workbook.typed.one" : "verify.workbook.typed", {
              count: format(each.typed),
            }),
          each.formulas > 0 &&
            t(each.formulas === 1 ? "verify.workbook.formulas.one" : "verify.workbook.formulas", {
              count: format(each.formulas),
            }),
        ]
          .filter((part) => part !== false)
          .join(" · ")
      : t("verify.workbook.empty");
  const problemText = (problem: WorkbookProblem) =>
    problem.kind === "too-many"
      ? t("verify.refused.tooMany", { typed: format(problem.typed), most: format(problem.most) })
      : t(problem.kind === "range" ? "verify.refused.range" : "verify.refused.noNumbers");

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (sheet !== "") void checkWorkbook(sheet, range);
  };
  const reading = choosing?.reading === true;

  return (
    <dialog
      ref={dialog}
      onClose={closeWorkbookChoice}
      data-testid="workbook-sheet-dialog"
      aria-labelledby={`${id}-title`}
      aria-busy={reading}
      className={`${dialogClass} w-[30rem]`}
    >
      <form className={dialogBodyClass} onSubmit={submit}>
        <h2 id={`${id}-title`} className={dialogTitleClass}>
          {t("verify.workbook.title")}
        </h2>
        <div className="flex min-w-0 items-center gap-3">
          <DocumentLineIcon kind="xlsx" className="size-4 shrink-0 text-ink-meta" />
          <p title={path ?? ""} className="min-w-0 truncate text-ui font-semibold text-ink">
            {path?.split(/[\\/]/).pop() ?? ""}
          </p>
        </div>
        <p className={dialogTextClass}>{t("verify.workbook.note")}</p>
        <fieldset disabled={reading}>
          <legend className={`mb-1.5 ${fieldLabelClass}`}>{t("verify.workbook.sheet")}</legend>
          <div className={choiceListClass}>
            {(sheets ?? []).map((each) => (
              <label key={each.name} className={choiceRowClass}>
                <input
                  type="radio"
                  name={`${id}-sheet`}
                  value={each.name}
                  data-testid="workbook-sheet"
                  data-sheet={each.name}
                  checked={sheet === each.name}
                  disabled={!hasContent(each)}
                  onChange={() => setSheet(each.name)}
                  className={choiceRadioClass}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={choiceTitleClass}>{each.name}</span>
                  <span className={choiceTextClass}>{detail(each)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-range`} className={fieldLabelClass}>
            {t("verify.workbook.range")}
          </label>
          <input
            id={`${id}-range`}
            data-testid="workbook-range"
            value={range}
            disabled={reading}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="B2:M40"
            onChange={(event) => setRange(event.target.value)}
            className={`${inputClass} font-mono text-[13px]`}
          />
          <p className={choiceTextClass}>{t("verify.workbook.range.hint")}</p>
        </div>
        {choosing?.problem && (
          <ProblemLine testId="workbook-problem">{problemText(choosing.problem)}</ProblemLine>
        )}
        <div className={dialogActionsClass}>
          <button type="button" onClick={closeWorkbookChoice} className={buttonClass}>
            {t("verify.workbook.cancel")}
          </button>
          <button
            type="submit"
            data-testid="workbook-check"
            disabled={sheet === "" || reading}
            className={primaryButtonClass}
          >
            {t("verify.workbook.confirm")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
