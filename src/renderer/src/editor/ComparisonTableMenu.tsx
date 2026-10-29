import type { ComparisonQuestion } from "../../../core/api";
import { comparisonLabelOf } from "../../../shared/comparisons";
import { showColumn } from "../comparisonColumns";
import { comparisonCellsInTable } from "../comparisonSelection";
import type { ComparisonTableHandle } from "../comparisonStructure";
import { ObjectMenu } from "../components/ObjectMenu";
import { menuItemClass, menuTitleClass } from "../components/ui";
import { useT } from "../i18n";
import { ComparisonRefillEstimate } from "./ComparisonRefillEstimate";

/**
 * A comparison table's own ⋯ (#1837): Documents added, its name renamed, and
 * every hidden column shown again, in the shared menu order. The actions
 * themselves are commands, so ⌘K reaches them wherever the table has focus.
 */
export function ComparisonTableMenu({
  handle,
  hidden,
}: {
  handle: ComparisonTableHandle;
  hidden: readonly ComparisonQuestion[];
}) {
  const t = useT();
  return (
    <ObjectMenu
      target={{ kind: "comparisonTable", id: handle.tableId }}
      label={t("comparison.table.more")}
      className="comparison-action comparison-table-menu"
      tabIndex={-1}
      testId="comparison-table"
      foot={
        <>
          <ComparisonRefillEstimate
            handle={handle}
            mode="refill-all"
            requested={comparisonCellsInTable(handle, true)}
            label={(count) =>
              t(
                count === 1 ? "comparison.refill.allCells.one" : "comparison.refill.allCells.other",
                {
                  count,
                },
              )
            }
          />
          <ComparisonRefillEstimate
            handle={handle}
            mode="refill-problems"
            requested={comparisonCellsInTable(handle, true)}
            label={(count) =>
              t(
                count === 1
                  ? "comparison.refill.problemCells.one"
                  : "comparison.refill.problemCells.other",
                { count },
              )
            }
          />
        </>
      }
      more={
        hidden.length > 0
          ? (close) => (
              <>
                <div className={menuTitleClass}>
                  {t("comparison.column.hiddenMenu", { count: hidden.length })}
                </div>
                {hidden.map((question) => (
                  <button
                    key={question.id}
                    type="button"
                    role="menuitem"
                    data-testid={`comparison-column-show-${question.id}`}
                    className={`${menuItemClass} pl-2`}
                    onClick={() => {
                      close();
                      void showColumn(handle, question.id);
                    }}
                  >
                    <span className="flex-1">
                      {t("comparison.column.show", { label: comparisonLabelOf(question) })}
                    </span>
                  </button>
                ))}
              </>
            )
          : undefined
      }
    />
  );
}
