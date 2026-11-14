import { type ReactNode, useId } from "react";
import type { CommandId } from "../../../shared/commands";
import { ObjectMenu } from "../components/ObjectMenu";
import { rowActionButtonClass } from "../components/sidebarRows";
import { menuItemClass, menuItemUnavailableClass } from "../components/ui";
import { useT } from "../i18n";
import type { CardAction } from "./cardActions";

/** A card's buttons: the first styled as its main action where the card had one. */
export function CardButtons({ buttons }: { buttons: readonly CardAction[] }) {
  return (
    <>
      {buttons.map((action, index) =>
        action.render ? (
          <span key={action.key} className="contents">
            {action.render()}
          </span>
        ) : (
          <button
            key={action.key}
            type="button"
            data-testid={action.testId}
            className={`citation-card-action ${index === 0 && action.primary ? "citation-card-action--primary" : ""}`}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ),
      )}
    </>
  );
}

/** The check commands a sentence's card offers as actions of its own, in its own order. */
const OFFERED_HERE: readonly CommandId[] = [
  "check.anyway",
  "check.useDocumentWording",
  "check.findSources",
];

/**
 * The card's one ⋯ (#2869): every action that isn't a button, in the card's order, then About this
 * check, which says where it looked, with what model and when, as the check record keeps it.
 */
export function CardMenu({
  id,
  actions,
  about,
}: {
  id: string;
  actions: readonly CardAction[];
  about: readonly ReactNode[];
}) {
  const t = useT();
  if (actions.length === 0 && about.length === 0) return null;
  return (
    <ObjectMenu
      target={{ kind: "check", id }}
      label={t("claim.more")}
      className={`${rowActionButtonClass} citation-card-menu`}
      align="end"
      without={OFFERED_HERE}
      more={
        actions.length > 0
          ? (close) =>
              actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  data-testid={action.testId}
                  aria-disabled={action.disabled || undefined}
                  className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                  onClick={() => {
                    if (action.disabled) return;
                    close();
                    action.onClick();
                  }}
                >
                  <span className="flex-1">{action.label}</span>
                </button>
              ))
          : undefined
      }
      foot={about.length > 0 ? <AboutThisCheck lines={about} /> : undefined}
    />
  );
}

/** A labelled group at the menu's foot whose lines the arrow keys reach, as an item that does nothing. */
function AboutThisCheck({ lines }: { lines: readonly ReactNode[] }) {
  const t = useT();
  const title = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu's items are grouped by role; a fieldset is for a form's.
    <div role="group" aria-labelledby={title} className="claim-about" data-testid="claim-about">
      <p id={title} className="claim-about-title">
        {t("claim.about")}
      </p>
      <div
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        className="claim-about-lines"
        data-testid="claim-about-lines"
      >
        {lines}
      </div>
    </div>
  );
}
