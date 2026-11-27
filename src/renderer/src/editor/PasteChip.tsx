import { ChevronDownSmallIcon, DocumentLineIcon, RemoveIcon } from "../components/icons";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { linesOf, type Paste } from "../composer";
import { useT } from "../i18n";

/** "Pasted text · 74 lines": by lines, or by characters for one long line. */
export function usePasteLabel() {
  const t = useT();
  return (paste: Paste) => {
    const lines = linesOf(paste.text);
    return lines > 1
      ? t("composer.paste.lines", { count: lines })
      : t("composer.paste.chars", { count: paste.text.length });
  };
}

/**
 * A long paste, as a chip above the composer's text (DESIGN.md, Composer ›
 * Height): its name opens a menu with View, Put back in the text, and Save as
 * a Document; × takes it away. The words in it are asked with unless it is
 * put back or saved.
 */
export function PasteChip({
  paste,
  onView,
  onPutBack,
  onSave,
  onRemove,
}: {
  paste: Paste;
  onView(): void;
  onPutBack(): void;
  onSave(): void;
  onRemove(): void;
}) {
  const t = useT();
  const label = usePasteLabel()(paste);
  // Over the composer, not on it.
  const menu = usePopoverMenu({ around: (chip) => chip.closest<HTMLElement>(".composer") });
  const choose = (action: () => void) => () => {
    menu.close();
    action();
  };
  return (
    <span data-testid="composer-paste" className="paste-chip">
      <button
        type="button"
        {...menu.buttonProps}
        data-testid="composer-paste-menu-button"
        aria-label={t("composer.paste.label", { chip: label })}
        className="paste-chip-name"
      >
        <DocumentLineIcon kind="text" className="paste-chip-icon" />
        <span className="truncate">{label}</span>
        <ChevronDownSmallIcon className="composer-model-chevron" />
      </button>
      <button
        type="button"
        data-testid="composer-paste-remove"
        aria-label={t("composer.paste.remove")}
        title={t("composer.paste.remove")}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("composer.paste.menu")}
        data-testid="composer-paste-menu"
        className="paste-menu"
      >
        {menu.open && (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="paste-view"
              onClick={choose(onView)}
              className="paste-menu-item"
            >
              <span className="paste-menu-name">{t("composer.paste.view")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="paste-put-back"
              onClick={choose(onPutBack)}
              className="paste-menu-item"
            >
              <span className="paste-menu-name">{t("composer.paste.putBack")}</span>
            </button>
            <div className="paste-menu-rule" />
            <button
              type="button"
              role="menuitem"
              data-testid="paste-save"
              onClick={choose(onSave)}
              className="paste-menu-item"
            >
              <span className="paste-menu-name">
                {t("composer.paste.save")}
                <span className="paste-menu-hint">{t("composer.paste.saveHint")}</span>
              </span>
            </button>
          </>
        )}
      </div>
    </span>
  );
}
