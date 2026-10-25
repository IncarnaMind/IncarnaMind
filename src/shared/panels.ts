/** The parts of the window that fail on their own, and the window itself (#1500). */
export const PANEL_NAMES = ["window", "sidebar", "card", "assistant", "overlays"] as const;

export type PanelName = (typeof PANEL_NAMES)[number];

export const isPanelName = (value: unknown): value is PanelName =>
  PANEL_NAMES.some((name) => name === value);
