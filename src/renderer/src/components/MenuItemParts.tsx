import type { ComponentType, ReactNode } from "react";
import { CheckLineIcon } from "./icons";

/**
 * What a menu item shows, in every menu (DESIGN.md, Menus; #3761): its icon, its name, its keys at
 * the right in grey, and a switch's tick after them. A switch shows no icon, as its tick already
 * marks the row; an item with no icon keeps the icon's room, so names line up.
 */
export function MenuItemParts({
  icon: Glyph,
  label,
  keys,
  checked,
}: {
  icon?: ComponentType<{ className?: string }> | undefined;
  label: ReactNode;
  keys?: string | null | undefined;
  /** For a switch: whether it is on. */
  checked?: boolean | undefined;
}) {
  return (
    <>
      {Glyph && checked === undefined ? (
        <Glyph className="shrink-0" />
      ) : (
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}
      <span className="flex-1">{label}</span>
      {keys && <span className="pl-4 text-small text-ink-meta">{keys}</span>}
      {checked !== undefined && (
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          {checked && <CheckLineIcon />}
        </span>
      )}
    </>
  );
}
