import type { Translate } from "../objects";

/** A button's name with its shortcut, "Close tab (⌘W)"; "关闭标签页（⌘W）". */
export const withKeys = (t: Translate, label: string, keys: string | null | undefined): string =>
  keys ? t("line.actionKeys", { label, keys }) : label;

/**
 * A button's tooltip and name with its shortcut: its label drops the hint when
 * the assistant is narrow (#612), and the shortcut still works.
 */
export function withShortcut(t: Translate, label: string, keys: string | undefined) {
  const named = withKeys(t, label, keys);
  return keys ? { title: named, "aria-label": named } : {};
}
