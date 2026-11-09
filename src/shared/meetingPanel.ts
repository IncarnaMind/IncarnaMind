/**
 * The floating panel during a call: a small window above the meeting
 * app, with the help buttons and the latest suggestion. It shares the app's
 * preload, which gives its page the core and this bridge for the argument.
 */
import type { GeneralHelpKind, HelpShortcut } from "./meetingHelp";

export const MEETING_PANEL_ARGUMENT = "--incarnamind-meeting-panel";
export const MEETING_PANEL_BRIDGE_KEY = "incarnamindMeetingPanel";

/**
 * Whether the panel and Settings say the panel is left out of the User's screen share. Off until
 * real Zoom, Teams and Meet shares on macOS 15 and 26 and on Windows confirm it: capture built on
 * ScreenCaptureKit may not honour content protection on every macOS version. The protection is
 * on either way.
 */
export const SAYS_HIDDEN_FROM_SHARES: boolean = false;

/** The global shortcuts the main process holds now. */
export type HeldKeys = Partial<Record<HelpShortcut, string>>;

/** What ⌘K in the app's window asks of the panel: pin its latest suggestion, or fold or unfold it. */
export type PanelCommand = "pin" | "fold";

/** The panel as the app's window knows it, for ⌘K's labels. */
export interface PanelState {
  shown: boolean;
  folded: boolean;
  /** Its latest suggestion is pinned. */
  pinned: boolean;
}

export const MEETING_PANEL_CHANNELS = {
  /** Page → main: make the window this size, in CSS pixels, keeping its top right corner. */
  size: "meetingPanel:size",
  /** Page → main: the User closed it; it comes back with the next meeting, or from ⌘K. */
  close: "meetingPanel:close",
  /** Page → main: bring the app's window to the front, at Settings › Models to set up a model. */
  setUp: "meetingPanel:setUp",
  /** Page → main: the shortcuts held now (`HeldKeys`). */
  keys: "meetingPanel:keys",
  /** Main → page: the shortcuts held changed. */
  keysChanged: "meetingPanel:keysChanged",
  /** Main → page: a button's shortcut was pressed. */
  help: "meetingPanel:help",
  /** Page → main: whether it is folded and its latest suggestion pinned. */
  state: "meetingPanel:state",
  /** Main → page: ⌘K asked for a `PanelCommand`. */
  command: "meetingPanel:command",
} as const;

export interface MeetingPanelBridge {
  resize(width: number, height: number): void;
  close(): void;
  setUp(): void;
  keys(): Promise<HeldKeys>;
  onKeys(listener: (keys: HeldKeys) => void): () => void;
  onHelp(listener: (kind: GeneralHelpKind) => void): () => void;
  state(state: Omit<PanelState, "shown">): void;
  onCommand(listener: (command: PanelCommand) => void): () => void;
}
