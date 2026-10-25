/**
 * One-click help during a call: the buttons, in the floating panel and
 * at the top of the assistant, each a short Question about the call whose
 * Answer is one or two options to say.
 */
import type { MessageKey } from "./i18n";

/** The buttons every meeting has, in the order of their shortcuts (1 to 7). */
export const GENERAL_HELP = ["say", "answer", "want", "sum", "no", "ask", "check"] as const;
export type GeneralHelpKind = (typeof GENERAL_HELP)[number];

export const MEETING_TEMPLATES = ["sales", "interview", "team"] as const;
export type MeetingHelpTemplate = (typeof MEETING_TEMPLATES)[number];

/** The buttons a meeting's template adds after the general ones. */
export const TEMPLATE_HELP = {
  sales: ["objection", "nextStep", "facts"],
  interview: ["followUp", "leading", "notCovered"],
  team: ["decisions", "disagree"],
} as const satisfies Record<MeetingHelpTemplate, readonly string[]>;

export type TemplateHelpKind = (typeof TEMPLATE_HELP)[MeetingHelpTemplate][number];
export type MeetingHelpKind = GeneralHelpKind | TemplateHelpKind;

/** The buttons a meeting shows with this template: the general ones first. */
export const helpKindsFor = (template: MeetingHelpTemplate | null): readonly MeetingHelpKind[] => [
  ...GENERAL_HELP,
  ...(template ? TEMPLATE_HELP[template] : []),
];

/** How a button's Answer is laid out: options to say, readings of what they want, or short lines. */
export type HelpShape = "options" | "readings" | "lines";

export const HELP_SHAPE: Readonly<Record<MeetingHelpKind, HelpShape>> = {
  say: "options",
  answer: "options",
  want: "readings",
  sum: "lines",
  no: "options",
  ask: "options",
  check: "lines",
  objection: "options",
  nextStep: "options",
  facts: "lines",
  followUp: "options",
  leading: "options",
  notCovered: "lines",
  decisions: "lines",
  disagree: "lines",
};

/**
 * Whose newest line a button answers, for the heading over its suggestion: the other side's,
 * the User's own ("Am I leading them?"), or anyone's. Absent: it is about the whole call.
 */
export const HEARD_FROM: Partial<Record<MeetingHelpKind, "them" | "me" | "anyone">> = {
  say: "them",
  answer: "them",
  no: "them",
  ask: "them",
  objection: "them",
  nextStep: "them",
  followUp: "them",
  leading: "me",
  check: "anyone",
};

/** What each button says, which is also the Question it asks. */
export const helpLabel = (kind: MeetingHelpKind): MessageKey => `meetings.help.${kind}`;

export const templateLabel = (template: MeetingHelpTemplate): MessageKey =>
  `meetings.template.${template}`;

export const isMeetingTemplate = (value: unknown): value is MeetingHelpTemplate =>
  MEETING_TEMPLATES.some((template) => template === value);

export const isGeneralHelpKind = (value: unknown): value is GeneralHelpKind =>
  GENERAL_HELP.some((kind) => kind === value);

const ALL_HELP: readonly MeetingHelpKind[] = [
  ...GENERAL_HELP,
  ...MEETING_TEMPLATES.flatMap((template) => TEMPLATE_HELP[template]),
];

export const isMeetingHelpKind = (value: unknown): value is MeetingHelpKind =>
  ALL_HELP.some((kind) => kind === value);

/**
 * The global shortcuts during a call, in Settings' order: Call help's, which shows or hides the
 * panel the buttons are in, then each general button's, then Pause my mic's.
 */
export const HELP_SHORTCUTS = ["panel", ...GENERAL_HELP, "mic"] as const;
export type HelpShortcut = (typeof HELP_SHORTCUTS)[number];

export const isHelpShortcut = (value: unknown): value is HelpShortcut =>
  HELP_SHORTCUTS.some((shortcut) => shortcut === value);

export const helpShortcutLabel = (shortcut: HelpShortcut): MessageKey =>
  shortcut === "panel"
    ? "meetings.callHelp"
    : shortcut === "mic"
      ? "meetings.mic.pause"
      : helpLabel(shortcut);

/**
 * A shortcut by default on macOS only: ⌃⌥1–7, ⌃⌥H and ⌃⌥M, which Zoom, Teams and Mac apps leave
 * free. Elsewhere none: the apps a call runs beside use Ctrl+Shift+1–9 (Excel's number formats),
 * Ctrl+Alt is AltGr on many European layouts, and no app's keys can all be known. The buttons and
 * ⌘K do everything, and the User sets keys in Settings › Meetings.
 */
export function defaultHelpKeys(shortcut: HelpShortcut, mac: boolean): string | null {
  if (!mac) return null;
  if (shortcut === "panel") return "Ctrl+Alt+H";
  if (shortcut === "mic") return "Ctrl+Alt+M";
  return `Ctrl+Alt+${GENERAL_HELP.indexOf(shortcut) + 1}`;
}

/** The shortcuts the User set in Settings › Meetings; "" for one they left without keys. */
export type HelpKeys = Partial<Record<HelpShortcut, string>>;

/** The keys a shortcut has on this device: the User's, or the default. Null: none. */
export function helpKeysOf(shortcut: HelpShortcut, chosen: HelpKeys, mac: boolean): string | null {
  const keys = chosen[shortcut] ?? defaultHelpKeys(shortcut, mac);
  return keys || null;
}

const MODIFIERS = new Set(["Cmd", "Ctrl", "Alt", "Shift"]);

/**
 * A global shortcut the User can choose: a letter, digit or F-key, held with
 * ⌘, ⌃ or ⌥ (Shift alone would take a character from the meeting app).
 */
export function isGlobalKeys(value: string): boolean {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key)) return false;
  if (parts.length === 0 || new Set(parts).size !== parts.length) return false;
  if (!parts.every((part) => MODIFIERS.has(part))) return false;
  return parts.some((part) => part !== "Shift");
}

export const isHelpKeys = (value: unknown): value is HelpKeys =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(
    ([kind, keys]) =>
      isHelpShortcut(kind) && typeof keys === "string" && (keys === "" || isGlobalKeys(keys)),
  );
