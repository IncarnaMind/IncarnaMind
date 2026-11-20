import type { Editor } from "@tiptap/core";
import type { WorkbookCheck } from "../../../shared/verification";
import { MetaLine } from "../components/MetaLine";
import { useLanguage, useT } from "../i18n";
import { ClaimMarkIcon } from "./icons";

/** Where the paragraph with this id starts in the Note, or null when it is gone. */
function startOf(editor: Editor, blockId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock && node.attrs.id === blockId) found = pos + 1;
    return found === null;
  });
  return found;
}

/**
 * What working a workbook's formulas out again came to (#3278), under the claims' rows in its
 * check card: how many were worked out, how many the file saved no result for to compare (#3412),
 * and each whose saved result differs, which moves to its cell. A formula is the workbook's own working, so no Document is asked and no model is.
 */
export function VerifyFormulas({
  editor,
  workbook,
  goTo,
}: {
  editor: Editor;
  workbook: WorkbookCheck;
  goTo(at: number): void;
}) {
  const t = useT();
  const language = useLanguage();
  const { checked, unchecked, differs } = workbook;
  const unsaved = workbook.unsaved ?? 0;
  const worked = checked + unsaved;
  if (worked === 0 && unchecked === 0) return null;
  const number = new Intl.NumberFormat(language, { maximumSignificantDigits: 12 });
  const count = (value: number) => ({ count: new Intl.NumberFormat(language).format(value) });
  const shown = (value: string) => {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) ? number.format(parsed) : value;
  };
  return (
    <div data-testid="verify-formulas" className="check-rows">
      <MetaLine
        className="check-card-summary"
        parts={[
          worked > 0 &&
            t(
              worked === 1 ? "verify.formulas.checked.one" : "verify.formulas.checked",
              count(worked),
            ),
          checked > 0 &&
            (differs.length === 0
              ? t("verify.formulas.noneDiffer")
              : t(
                  differs.length === 1 ? "verify.formulas.differ.one" : "verify.formulas.differ",
                  count(differs.length),
                )),
          unsaved > 0 &&
            t(
              unsaved === 1 ? "verify.formulas.unsaved.one" : "verify.formulas.unsaved",
              count(unsaved),
            ),
          unchecked > 0 &&
            t(
              unchecked === 1 ? "verify.formulas.unchecked.one" : "verify.formulas.unchecked",
              count(unchecked),
            ),
        ]}
      />
      {differs.map((each) => {
        const text = t("verify.formulas.cell", {
          cell: each.cell,
          saved: shown(each.saved),
          worked: shown(each.worked),
        });
        return (
          <button
            key={each.blockId}
            type="button"
            data-testid="verify-formula-differs"
            data-cell={each.cell}
            className="check-row"
            aria-label={t("verify.formulas.next", { cell: each.cell })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const at = startOf(editor, each.blockId);
              if (at !== null) goTo(at);
            }}
          >
            <span className="check-row-mark">
              <ClaimMarkIcon state="contradicted" className="mind-health-icon" />
            </span>
            <span className="check-row-text">{text}</span>
            <span className="check-row-next" aria-hidden="true">
              {t("badge.next")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
