/**
 * A comparison table's hidden columns (#1833): the ⋯ that shows one again,
 * in its own place, when the table has any hidden.
 */
import type { ComparisonQuestion } from "../../../core/api";
import { comparisonLabelOf } from "../../../shared/comparisons";
import { MoreLineIcon } from "../components/lineIcons";
import { menuClass, menuItemClass } from "../components/ui";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { useT } from "../i18n";

export function ComparisonHiddenColumnsMenu({
  hidden,
  onShow,
}: {
  hidden: readonly ComparisonQuestion[];
  onShow(questionId: string): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first", align: "end" });
  const label = t("comparison.column.hiddenMenu", { count: hidden.length });
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="comparison-hidden-menu"
        aria-label={label}
        title={label}
        className="comparison-action comparison-hidden-menu"
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        className={menuClass}
        data-testid="comparison-hidden-actions"
      >
        {menu.open &&
          hidden.map((question) => (
            <button
              key={question.id}
              type="button"
              role="menuitem"
              data-testid={`comparison-column-show-${question.id}`}
              className={`${menuItemClass} pl-2`}
              onClick={() => {
                menu.close();
                onShow(question.id);
              }}
            >
              <span className="flex-1">
                {t("comparison.column.show", { label: comparisonLabelOf(question) })}
              </span>
            </button>
          ))}
      </div>
    </>
  );
}
