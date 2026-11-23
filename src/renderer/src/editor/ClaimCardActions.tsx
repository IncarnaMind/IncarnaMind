import { type ReactNode, useId } from "react";
import type { CommandId } from "../../../shared/commands";
import { CheckIcon } from "../components/icons";
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
            aria-keyshortcuts={action.keys}
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

const FIND_SOURCES: readonly CommandId[] = ["check.findSources"];

/**
 * The card's one ⋯ (#2869): every action that isn't a button, in the card's order, Open the page
 * first, then the check's own commands, Find sources… among them, as the right-click menu lists
 * them, then About this check: where it looked, with what model and when, as the record keeps it.
 */
export function CardMenu({
  id,
  actions,
  about,
  findSources,
}: {
  id: string;
  actions: readonly CardAction[];
  about: readonly ReactNode[];
  /** Find sources for the sentence, where the card offers it. */
  findSources?: () => void;
}) {
  const t = useT();
  if (actions.length === 0 && about.length === 0 && !findSources) return null;
  // Where a row ticks, every row keeps the tick's room, so their words start in one line.
  const ticks = actions.some((action) => action.checked !== undefined);
  const here: Partial<Record<CommandId, () => void>> | undefined = findSources
    ? { "check.findSources": findSources }
    : undefined;
  return (
    <ObjectMenu
      target={{ kind: "check", id }}
      label={t("claim.more")}
      className={`${rowActionButtonClass} citation-card-menu`}
      align="end"
      here={here}
      // The command's own test reads the sentence at the caret, which needn't be this card's.
      without={findSources ? undefined : FIND_SOURCES}
      first={
        actions.length > 0
          ? (close) =>
              actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  {...(action.checked === undefined
                    ? { role: "menuitem" }
                    : { role: "menuitemcheckbox", "aria-checked": action.checked })}
                  data-testid={action.testId}
                  aria-disabled={action.disabled || undefined}
                  className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                  onClick={() => {
                    if (action.disabled) return;
                    close();
                    action.onClick();
                  }}
                >
                  {ticks && (
                    <span className="claim-menu-tick" aria-hidden="true">
                      {action.checked && <CheckIcon className="claim-menu-tick-icon" />}
                    </span>
                  )}
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
      {/* The menu's last stop: Tab past it leaves the menu, closing it, as past any last item. */}
      <div
        role="menuitem"
        aria-disabled="true"
        tabIndex={0}
        className="claim-about-lines"
        data-testid="claim-about-lines"
      >
        {lines}
      </div>
    </div>
  );
}
