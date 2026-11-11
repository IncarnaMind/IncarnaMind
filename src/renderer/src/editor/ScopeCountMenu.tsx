import type { ReactNode } from "react";
import { menuClass } from "../components/ui";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { RemoveIcon } from "./icons";

export interface ScopeCountRow {
  key: string;
  icon: ReactNode;
  name: string;
  /** The name is struck through: the Folder, Tag or Document was deleted. */
  struck: boolean;
  /** What its chip's tooltip said: for a locked Folder, why it has no ×. */
  title: string;
  /** A Folder that keeps its Question inside it: shown with its lock, and no ×. */
  walled: boolean;
  /** What its × does; null for a locked Folder. */
  remove: { label: string; run(): void } | null;
}

/**
 * The count a row too short for its Search scope chips folds them into ("2 files", "3 selected").
 * It opens, above itself, every item with its ×, the same ones the chips would have had.
 */
export function ScopeCountMenu({
  label,
  title,
  menuLabel,
  rows,
}: {
  label: string;
  /** The tooltip of the count: that of its one chip when it holds one. */
  title: string | undefined;
  menuLabel: string;
  rows: readonly ScopeCountRow[];
}) {
  // The count is the last thing before Ask, at the right of the box: its menu ends where it ends.
  const menu = usePopoverMenu({ side: "above", align: "end" });
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="scope-chips-more"
        title={title}
        // Keep the cursor where it is.
        onMouseDown={(event) => event.preventDefault()}
        className="scope-chip scope-chip-more"
      >
        {label}
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={menuLabel}
        data-testid="scope-chips-menu"
        className={menuClass}
      >
        {menu.open &&
          rows.map((row) => (
            <div
              key={row.key}
              data-testid="scope-chips-menu-row"
              data-walled={row.walled ? "true" : undefined}
              title={row.title}
              className="flex h-7 items-center gap-2 pr-1 pl-2"
            >
              <span className="flex shrink-0 text-ink-meta">{row.icon}</span>
              {row.struck ? (
                <s className="min-w-0 flex-1 truncate text-ink-placeholder">{row.name}</s>
              ) : (
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
              )}
              {row.walled && <span className="sr-only">{row.title}</span>}
              {row.remove && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="scope-chips-menu-remove"
                  aria-label={row.remove.label}
                  title={row.remove.label}
                  onClick={() => {
                    row.remove?.run();
                    // The × pressed goes with its row: the next one takes the focus, or the count does.
                    if (rows.length <= 2) menu.close();
                    else
                      requestAnimationFrame(() =>
                        menu.menuProps.ref.current
                          ?.querySelector<HTMLElement>('[role="menuitem"]')
                          ?.focus(),
                      );
                  }}
                  className="flex shrink-0 rounded p-1.5 text-ink-meta -outline-offset-2 hover:bg-hover hover:text-ink focus-visible:bg-hover"
                >
                  <RemoveIcon className="size-2.5" />
                </button>
              )}
            </div>
          ))}
      </div>
    </>
  );
}
