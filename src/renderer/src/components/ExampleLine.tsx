import { useGap, useT } from "../i18n";
import { allExamples, useAppStore } from "../store";
import { useAddYourDocuments } from "./AddYourDocuments";

/**
 * The example's one line, just above its input (#3791): that it is an example, the credit paper's
 * with the one figure its source contradicts, and the way to the User's own files.
 */
export function ExampleLine({ mindId }: { mindId: string }) {
  const t = useT();
  const gap = useGap();
  const addMenu = useAddYourDocuments("example-add");
  const credit = useAppStore(
    (state) => allExamples(state).find((each) => each.mindId === mindId)?.group === "credit",
  );
  const said = t(credit ? "examples.line.credit" : "examples.line");
  return (
    <div className="mind-measure example-line">
      <p data-testid="example-line">
        {said}
        {gap(said, t("examples.line.add"))}
        <button
          {...addMenu.buttonProps}
          type="button"
          data-testid="example-add-own"
          className="rounded-sm font-semibold text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0"
        >
          {t("examples.line.add")}
        </button>
      </p>
      {addMenu.menu}
    </div>
  );
}
