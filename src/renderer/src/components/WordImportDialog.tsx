import { useId } from "react";
import type { WordOrigin } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { useLanguage, useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { refusalKey, useWordImport } from "../wordImport";
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
  dialogTitleClass,
  fieldLabelClass,
  primaryButtonClass,
} from "./ui";
import { useModal } from "./useModal";

const ORIGINS: readonly { value: WordOrigin; label: MessageKey; note: MessageKey }[] = [
  { value: "own", label: "wordImport.own", note: "wordImport.own.note" },
  { value: "someone-else", label: "wordImport.someoneElse", note: "wordImport.someoneElse.note" },
];

const tickClass = "mt-3 flex items-start gap-2 text-[13px] leading-5 text-ink-secondary";
const tickBoxClass = "mt-0.5 size-4 shrink-0 accent-ink";

/** At most this many authors are named; the rest are counted. */
const NAMED = 3;

/**
 * "Import a Word file": the file, read first. One that can't be imported says
 * why, in plain words, with "Choose another file…". Otherwise it asks whose
 * document it is, starting on someone else's when the file carries tracked
 * changes or comments, and names their authors. A tick, on by default, also
 * adds the original as a Document (#720), and offers to make a newer draft of
 * one imported before a new version of it. Import makes the Mind and opens
 * it; Esc or Cancel leaves everything as it was.
 */
export function WordImportDialog() {
  const t = useT();
  const language = useLanguage();
  const state = useWordImport();
  const { path, check, origin, importing, refusal, dropped, addOriginal, newVersion } = state;
  const dialog = useModal(path !== null);
  const id = useId();
  const fileName = check?.fileName ?? path?.split(/[\\/]/).pop() ?? "";
  const refused = refusal ?? check?.refusal ?? null;
  const refusedSaid = refused
    ? saidInLine(t, (t) => t(refusalKey(refused), { name: fileName }))
    : null;
  const authors = check?.authors ?? [];
  const named =
    authors.length > NAMED
      ? [...authors.slice(0, NAMED), t("wordImport.othersMore", { count: authors.length - NAMED })]
      : authors;

  return (
    <dialog
      ref={dialog}
      onClose={state.close}
      data-testid="word-import-dialog"
      aria-labelledby={`${id}-title`}
      aria-busy={check === null || importing}
      className={`${dialogClass} w-[30rem]`}
    >
      <div className={dialogBodyClass}>
        <h2 id={`${id}-title`} className={dialogTitleClass}>
          {t("wordImport.title")}
        </h2>
        <div className="flex min-w-0 items-center gap-3">
          <DocumentLineIcon kind="docx" className="size-4 shrink-0 text-ink-meta" />
          <p
            data-testid="word-import-file"
            title={path ?? ""}
            className="min-w-0 truncate text-ui font-semibold text-ink"
          >
            {fileName}
          </p>
        </div>

        {check === null ? (
          <p role="status" className="text-[13px] leading-5 text-ink-meta">
            {t("wordImport.reading", { name: fileName })}
          </p>
        ) : refusedSaid ? (
          <ProblemLine
            testId="word-import-refusal"
            title={refusedSaid.fullMessage}
            action={{
              label: t("wordImport.chooseAnother"),
              testId: "word-import-choose-another",
              onClick: () => void state.pick(),
            }}
          >
            {refusedSaid.message}
          </ProblemLine>
        ) : (
          <fieldset disabled={importing}>
            <legend className={`mb-1.5 ${fieldLabelClass}`}>{t("wordImport.whose")}</legend>
            <div className={choiceListClass}>
              {ORIGINS.map((option) => (
                <label key={option.value} className={choiceRowClass}>
                  <input
                    type="radio"
                    name={`${id}-origin`}
                    value={option.value}
                    data-testid={`word-import-origin-${option.value}`}
                    checked={origin === option.value}
                    onChange={() => state.setOrigin(option.value)}
                    className={choiceRadioClass}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className={choiceTitleClass}>{t(option.label)}</span>
                    <span className={choiceTextClass}>{t(option.note)}</span>
                  </span>
                </label>
              ))}
            </div>
            {authors.length > 0 && (
              <p data-testid="word-import-authors" className={`mt-2 ${choiceTextClass}`}>
                {t("wordImport.others", {
                  names: new Intl.ListFormat(language, { type: "conjunction" }).format(named),
                })}
              </p>
            )}
            <p className="mt-3 text-[13px] leading-5 text-ink-meta">{t("wordImport.keeps")}</p>
            <label className={tickClass}>
              <input
                type="checkbox"
                data-testid="word-import-add-original"
                checked={addOriginal}
                onChange={(event) => state.setAddOriginal(event.target.checked)}
                className={tickBoxClass}
              />
              {t("wordImport.addOriginal")}
            </label>
            {addOriginal && check.earlierDraft && (
              <label className={`${tickClass} ml-6`}>
                <input
                  type="checkbox"
                  data-testid="word-import-new-version"
                  checked={newVersion}
                  onChange={(event) => state.setNewVersion(event.target.checked)}
                  className={tickBoxClass}
                />
                {t("wordImport.newerDraft", { name: check.earlierDraft.name })}
              </label>
            )}
          </fieldset>
        )}

        <div className={dialogActionsClass}>
          {dropped && (
            <button
              type="button"
              data-testid="word-import-as-document"
              disabled={importing}
              onClick={() => void state.addAsDocument()}
              className={`${buttonClass} mr-auto`}
            >
              {t("wordImport.asDocument")}
            </button>
          )}
          <button type="button" onClick={state.close} className={buttonClass}>
            {t("wordImport.cancel")}
          </button>
          {!refused && (
            <button
              type="button"
              data-testid="word-import-confirm"
              disabled={check === null || importing}
              onClick={() => void state.confirm()}
              className={primaryButtonClass}
            >
              {t(importing ? "wordImport.importing" : "wordImport.import")}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
