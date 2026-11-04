import type { Translate } from "../objects";

/** ARIA wants the keys named, not the glyphs a macOS screen shows (#328). */
export const COMMENT_KEYSHORTCUTS = "Alt+Meta+M";

/** The Comment command's tooltip and accessible name: its name with its keys, joined as the Undo line joins them. */
export const commentCommandName = (t: Translate, keys: string): string =>
  t("line.actionKeys", { label: t("comments.add"), keys });
