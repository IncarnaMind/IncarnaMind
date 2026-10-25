/**
 * A button's tooltip and name with its shortcut: its label drops the hint when
 * the assistant is narrow (#612), and the shortcut still works.
 */
export function withShortcut(label: string, keys: string | undefined) {
  return keys ? { title: `${label} (${keys})`, "aria-label": `${label} (${keys})` } : {};
}
