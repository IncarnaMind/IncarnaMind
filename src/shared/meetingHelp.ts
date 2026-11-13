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

/**
 * A form call help is asked and read in other than today's, while its trial runs (#2847): "fact
 * lines", where each fact an option rests on is a line of its own apart from the line to say; or
 * "as before", today's without the rule that takes a marker off a "→" line and a reading's first
 * line. Only tests and the evaluation choose one.
 */
export type CallHelpForm = "fact lines" | "as before";

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
 * The marks a help Answer's lines start with, as the panel reads them: the recommended option or
 * reading, what an option leads to, and a short line. Bold marks a model adds are not part of a
 * line (`plainLine`).
 */
export const RECOMMENDED_MARK = /^(?:★|⭐)\s*/;
export const EFFECT_MARK = /^(?:→|->)\s*/;
export const LINE_MARK = /^(?:[-*•]|\d+[.)])\s+/;
export const plainLine = (line: string) => line.replace(/\*\*|__/g, "").trim();

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
 * panel the buttons are in, then each general button's, then the quick note's, which puts the
 * cursor in the panel's field (#2925), then Pause my mic's.
 */
export const HELP_SHORTCUTS = ["panel", ...GENERAL_HELP, "note", "mic"] as const;
export type HelpShortcut = (typeof HELP_SHORTCUTS)[number];

export const isHelpShortcut = (value: unknown): value is HelpShortcut =>
  HELP_SHORTCUTS.some((shortcut) => shortcut === value);

/**
 * The shortcuts a system has: on Linux, none for the quick note, as the panel has no field there
 * (#2925). Under X11 a window made unable to take the keyboard, as the panel is so a click on it
 * leaves the keys with the meeting app, can't take it later, and Wayland lets no app take it.
 */
export const helpShortcutsOn = (linux: boolean): readonly HelpShortcut[] =>
  linux ? HELP_SHORTCUTS.filter((shortcut) => shortcut !== "note") : HELP_SHORTCUTS;

export function helpShortcutLabel(shortcut: HelpShortcut): MessageKey {
  if (shortcut === "panel") return "meetings.callHelp";
  if (shortcut === "note") return "meetings.quickNote";
  if (shortcut === "mic") return "meetings.mic.pause";
  return helpLabel(shortcut);
}

/**
 * A shortcut by default on macOS only: ⌃⌥1–7, ⌃⌥H, ⌃⌥N and ⌃⌥M, which Zoom, Teams and Mac apps
 * leave free. Elsewhere none: the apps a call runs beside use Ctrl+Shift+1–9 (Excel's number
 * formats), Ctrl+Alt is AltGr on many European layouts, and no app's keys can all be known. The
 * buttons and ⌘K do everything, and the User sets keys in Settings › Meetings.
 */
export function defaultHelpKeys(shortcut: HelpShortcut, mac: boolean): string | null {
  if (!mac) return null;
  if (shortcut === "panel") return "Ctrl+Alt+H";
  if (shortcut === "mic") return "Ctrl+Alt+M";
  if (shortcut === "note") return "Ctrl+Alt+N";
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
