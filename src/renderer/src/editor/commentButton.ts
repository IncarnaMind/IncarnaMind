import { isMacOS } from "@tiptap/core";
import type { Translate } from "../objects";

/** ARIA names the chord's keys: on Windows and Linux Meta is the Windows key, so it is Control there (#328). */
export const commentKeyshortcuts = (): string => (isMacOS() ? "Alt+Meta+M" : "Control+Alt+M");

/** The Comment command's tooltip and accessible name: its name with its keys, joined as the Undo line joins them. */
export const commentCommandName = (t: Translate, keys: string): string =>
  t("line.actionKeys", { label: t("comments.add"), keys });
