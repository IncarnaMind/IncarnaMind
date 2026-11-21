import { useId, useState } from "react";
import { useT } from "../../i18n";
import { useSortingPicker } from "../ai/SortingPicker";
import { SortingLine, useSorting } from "../providers/SortingChoice";
import { QuietLine } from "./SetupPanel";

/**
 * The Your AI step's last line (#3570): the model that sorts and tags new Documents, optional and
 * closed. Opening it shows the choice Settings › AI › Organize and Tags has, in place; nothing is
 * read, saved or sent until it is opened, and none of it is needed to go on.
 */
export function SortingModelLine() {
  const t = useT();
  const panel = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <QuietLine
        testId="setup-sorting-model-open"
        expanded={open}
        controls={panel}
        onClick={() => setOpen(!open)}
      >
        {t("setupPage.ai.sorting")}
      </QuietLine>
      {open && <SortingModel id={panel} />}
    </div>
  );
}

function SortingModel({ id }: { id: string }) {
  const t = useT();
  const field = useId();
  const sorting = useSorting();
  const picker = useSortingPicker(field, sorting);
  const { current, library, read } = sorting;
  const chosen =
    library !== null &&
    library.settings.classifier.kind !== "automatic" &&
    current !== null &&
    !current.unresolved;
  return (
    <div id={id} data-testid="setup-sorting-model" className="flex flex-col gap-2">
      <p className="text-[13px] leading-5 text-ink-secondary">{t("setupPage.ai.sorting.about")}</p>
      {read.state !== "loading" && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {picker.control && (
              <label htmlFor={field} className="text-[12px] leading-[18px] text-ink-meta">
                {t("setupPage.ai.model")}
              </label>
            )}
            {picker.control}
          </div>
          {picker.below}
          {chosen && !picker.settingUp && <SortingLine option={current} />}
        </>
      )}
    </div>
  );
}
