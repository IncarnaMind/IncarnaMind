/**
 * Help during a call, on the desktop: the floating panel and the help
 * buttons' global shortcuts.
 *
 * The panel is a small window above the meeting app, full screen included,
 * that never takes the focus from it: a non-activating panel on macOS, a
 * window that can't be focused elsewhere. It appears when a Meeting starts
 * recording, if Settings › Meetings says so, and goes when it stops; the
 * User can close it until the next meeting. It is kept out of the User's
 * own screen share where the system honours content protection (macOS,
 * Windows 10 2004 and later).
 *
 * The shortcuts are held only while a Meeting records: never while it is paused
 * or after it stops, so other apps get their keys back. With a main window in
 * front they are held too, bar those the User set to a key the window binds
 * itself (`windowKeys`), which would take that keystroke from the window. A
 * button's press goes to the panel, or, with none shown, to the app's window,
 * which asks there; Call help's shows or hides the panel, and Pause my mic's
 * pauses or resumes the Meeting's microphone.
 */
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  screen,
} from "electron";
import type { Core, Logger } from "../../core";
import type { Meeting, Settings } from "../../core/api";
import { isRecord } from "../../core/errors";
import { FILES_CHANNELS } from "../../shared/bridge";
import { keysForm } from "../../shared/keyForms";
import { HELP_SHORTCUTS, type HelpShortcut, helpKeysOf } from "../../shared/meetingHelp";
import {
  type HeldKeys,
  MEETING_PANEL_ARGUMENT,
  MEETING_PANEL_CHANNELS,
  type PanelState,
} from "../../shared/meetingPanel";
import { handle } from "../ipc";

/** The panel's width before its page says its size, and its distance from the screen's top right corner. */
const FIRST_WIDTH = 408;
const FIRST_HEIGHT = 320;
const MARGIN = 24;

const panelWindows = new WeakSet<BrowserWindow>();
export const isPanelWindow = (window: BrowserWindow) => panelWindows.has(window);

export interface MeetingPanelOptions {
  rendererUrl: string | undefined;
  /** The app's windows, where a press goes when no panel is shown. */
  appWindows(): BrowserWindow[];
  /** Whether a call comes from IncarnaMind's own page. */
  trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean;
  /** On macOS the shortcuts have ⌃⌥ defaults; elsewhere none is held until the User sets one. */
  mac: boolean;
  log: Logger;
  /** A test build lets the smoke tests press a shortcut, which no test can send the system. */
  testHooks: boolean;
}

export function serveMeetingPanel(core: Core, options: MeetingPanelOptions): void {
  const { mac } = options;
  let meetings: Meeting[] = [];
  let settings: Settings | null = null;
  let panel: BrowserWindow | null = null;
  /**
   * The User showed or hid the panel for this Meeting: that holds until it ends, whatever
   * Settings › Meetings says.
   */
  let choice: { meetingId: string; shown: boolean } | null = null;
  /** The panel's top right corner where the User left it, for the next one this session. */
  let corner: { right: number; top: number } | null = null;
  const held = new Map<HelpShortcut, string>();
  /**
   * Keys the window binds itself, as the window last said. Over a main window (a Mind, Library or
   * Settings) a meeting key that is one of them is dropped, since the User is typing there (a key
   * set to Ctrl+Shift+9 would stop the notes making a checklist). Every other key stays held:
   * taking notes in the meeting's Mind is when Pause my mic is most wanted. The panel is the
   * meeting's own surface and never takes the focus from the call, so pointing at it keeps them
   * all held. A test build starts with another app in front, as a call is.
   */
  let windowKeys: ReadonlySet<string> = new Set();
  let frontOverride: boolean | null = options.testHooks ? false : null;
  const mainFocused = () =>
    frontOverride ??
    options.appWindows().some((window) => !window.isDestroyed() && window.isFocused());
  const keysWanted = () => liveMeeting()?.status === "recording";
  const takenByWindow = (keys: string) => mainFocused() && windowKeys.has(keysForm(keys, mac));
  /**
   * Keys the system refused while recording: not asked for again, nor logged, on every Meeting
   * update, until those keys or the recording change.
   */
  const refused = new Map<HelpShortcut, string>();

  // A voice memo has no call to help with (#1568).
  const liveMeeting = () =>
    meetings.find(
      (meeting) =>
        meeting.kind === "meeting" &&
        (meeting.status === "recording" || meeting.status === "paused"),
    );

  const heldKeys = (): HeldKeys => Object.fromEntries(held);

  /** What the panel's page last said of itself; reset when a panel opens. */
  let reported = { folded: false, pinned: false };
  const panelState = (): PanelState => ({ shown: !!panel, ...reported });
  const tellShown = () => {
    for (const window of options.appWindows()) {
      if (!window.isDestroyed()) window.webContents.send(FILES_CHANNELS.meetingPanel, panelState());
    }
  };

  function choose(shown: boolean): void {
    const meeting = liveMeeting();
    if (!meeting) return;
    choice = { meetingId: meeting.id, shown };
    sync();
  }

  function toggleMicrophone(): void {
    const meeting = liveMeeting();
    if (!meeting) return;
    core
      .setMeetingMicrophone({
        meetingId: meeting.id,
        paused: meeting.microphonePausedAtMs === null,
      })
      .catch((error: unknown) =>
        options.log.error("meeting.microphoneFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  function press(kind: HelpShortcut): void {
    if (kind === "panel") {
      choose(!panel);
      return;
    }
    if (kind === "mic") {
      toggleMicrophone();
      return;
    }
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send(MEETING_PANEL_CHANNELS.help, kind);
      return;
    }
    const [front] = options.appWindows();
    front?.webContents.send(FILES_CHANNELS.meetingHelp, kind);
  }

  function holdKeys(active: boolean): void {
    const wanted = new Map<HelpShortcut, string>();
    if (active && settings) {
      for (const kind of HELP_SHORTCUTS) {
        const keys = helpKeysOf(kind, settings.device.meetingHelpKeys, mac);
        if (keys && !takenByWindow(keys)) wanted.set(kind, keys);
      }
    }
    if (!active) refused.clear();
    let changed = false;
    for (const [kind, keys] of held) {
      if (wanted.get(kind) === keys) continue;
      globalShortcut.unregister(keys);
      held.delete(kind);
      changed = true;
    }
    for (const [kind, keys] of wanted) {
      if (held.has(kind) || refused.get(kind) === keys) continue;
      refused.delete(kind);
      let taken = false;
      try {
        taken = !globalShortcut.register(keys, () => press(kind));
      } catch (error) {
        options.log.warn("meeting.helpKeysRefused", {
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        refused.set(kind, keys);
        continue;
      }
      // Another app holds them: the button works without its shortcut.
      if (taken) {
        options.log.info("meeting.helpKeysTaken", { kind });
        refused.set(kind, keys);
      } else {
        held.set(kind, keys);
        changed = true;
      }
    }
    if (changed && panel && !panel.isDestroyed()) {
      panel.webContents.send(MEETING_PANEL_CHANNELS.keysChanged, heldKeys());
    }
  }

  function place(width: number, height: number): Electron.Rectangle {
    if (corner) return { x: corner.right - width, y: corner.top, width, height };
    const [front] = options.appWindows();
    const display = front
      ? screen.getDisplayMatching(front.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    return {
      x: area.x + area.width - width - MARGIN,
      y: area.y + MARGIN,
      width,
      height,
    };
  }

  function open(): void {
    const window = new BrowserWindow({
      ...place(FIRST_WIDTH, FIRST_HEIGHT),
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Clicking a button leaves the meeting app in front: the panel never takes the focus.
      focusable: false,
      acceptFirstMouse: true,
      hasShadow: true,
      title: "IncarnaMind",
      backgroundColor: "#FFFFFF",
      // A panel floats over a full-screen app on macOS, and clicking it doesn't activate the app.
      ...(mac && { type: "panel" }),
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [MEETING_PANEL_ARGUMENT],
      },
    });
    panelWindows.add(window);
    panel = window;
    reported = { folded: false, pinned: false };
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setContentProtection(settings?.device.meetingPanelHidden ?? true);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.showInactive();
    });
    window.on("moved", () => {
      const bounds = window.getBounds();
      corner = { right: bounds.x + bounds.width, top: bounds.y };
    });
    window.on("closed", () => {
      if (panel === window) {
        panel = null;
        tellShown();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    if (options.rendererUrl) {
      void window.loadURL(new URL("meetingPanel.html", `${options.rendererUrl}/`).href);
    } else {
      void window.loadFile(join(__dirname, "../renderer/meetingPanel.html"));
    }
    tellShown();
  }

  function sync(): void {
    const meeting = liveMeeting();
    if (!meeting) choice = null;
    // A Meeting recovered as paused at launch opens no panel: it opens only once one records.
    const byDefault =
      !!settings?.device.meetingPanel && (meeting?.status === "recording" || !!panel);
    const wanted = !!meeting && (choice?.meetingId === meeting.id ? choice.shown : byDefault);
    if (wanted && !panel) open();
    else if (!wanted && panel) panel.destroy();
    if (panel && settings) panel.setContentProtection(settings.device.meetingPanelHidden);
    holdKeys(keysWanted());
  }

  const fromPanel = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !!panel && event.sender === panel.webContents;

  ipcMain.on(MEETING_PANEL_CHANNELS.size, (event, width: unknown, height: unknown) => {
    if (!fromPanel(event) || !panel || typeof width !== "number" || typeof height !== "number")
      return;
    const size = { width: Math.ceil(width), height: Math.ceil(height) };
    if (size.width < 1 || size.height < 1) return;
    const bounds = panel.getBounds();
    if (bounds.width === size.width && bounds.height === size.height) return;
    panel.setBounds({ x: bounds.x + bounds.width - size.width, y: bounds.y, ...size });
  });
  ipcMain.on(MEETING_PANEL_CHANNELS.close, (event) => {
    if (fromPanel(event)) choose(false);
  });
  ipcMain.on(MEETING_PANEL_CHANNELS.setUp, (event) => {
    if (!fromPanel(event)) return;
    const [front] = options.appWindows();
    if (!front) return;
    if (front.isMinimized()) front.restore();
    front.show();
    front.focus();
    front.webContents.send(FILES_CHANNELS.setUpModel);
  });
  handle(MEETING_PANEL_CHANNELS.keys, (event) => {
    if (!fromPanel(event)) throw new Error("Refused a call from an unknown page.");
    return heldKeys();
  });
  handle(FILES_CHANNELS.globalKeysFree, (event, keys: unknown) => {
    if (!options.trusted(event)) throw new Error("Refused a call from an unknown page.");
    if (typeof keys !== "string") throw new Error("Keys must be an accelerator.");
    if ([...held.values()].includes(keys)) return true;
    try {
      if (!globalShortcut.register(keys, () => undefined)) return false;
    } catch {
      return false;
    }
    globalShortcut.unregister(keys);
    return true;
  });
  ipcMain.on(FILES_CHANNELS.windowKeys, (event, forms: unknown) => {
    if (!options.trusted(event) || !Array.isArray(forms)) return;
    windowKeys = new Set(forms.filter((form): form is string => typeof form === "string"));
    holdKeys(keysWanted());
  });
  ipcMain.on(FILES_CHANNELS.showMeetingPanel, (event, shown: unknown) => {
    if (options.trusted(event) && typeof shown === "boolean") choose(shown);
  });
  ipcMain.on(FILES_CHANNELS.meetingPanelWanted, (event) => {
    if (options.trusted(event)) event.sender.send(FILES_CHANNELS.meetingPanel, panelState());
  });
  ipcMain.on(FILES_CHANNELS.meetingPanelCommand, (event, command: unknown) => {
    if (!options.trusted(event) || (command !== "pin" && command !== "fold")) return;
    if (panel && !panel.isDestroyed())
      panel.webContents.send(MEETING_PANEL_CHANNELS.command, command);
  });
  ipcMain.on(MEETING_PANEL_CHANNELS.state, (event, state: unknown) => {
    if (!fromPanel(event) || !isRecord(state)) return;
    const { folded, pinned } = state;
    if (typeof folded !== "boolean" || typeof pinned !== "boolean") return;
    reported = { folded, pinned };
    tellShown();
  });

  app.on("browser-window-focus", () => holdKeys(keysWanted()));
  app.on("browser-window-blur", () => holdKeys(keysWanted()));

  core.on("meetings.changed", (listed) => {
    meetings = listed;
    sync();
  });
  core.on("settings.changed", (changed) => {
    settings = changed;
    sync();
  });
  Promise.all([core.listMeetings(), core.getSettings()]).then(
    ([listed, read]) => {
      meetings = listed;
      settings = read;
      sync();
    },
    (error: unknown) =>
      options.log.error("meeting.panelFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
  );

  if (options.testHooks) {
    Object.assign(globalThis, {
      incarnamindMainFocused(focused: boolean) {
        frontOverride = focused;
        holdKeys(keysWanted());
      },
      incarnamindPressHelpKeys(kind: HelpShortcut) {
        if (!held.has(kind)) throw new Error(`The shortcut for ${kind} isn't held.`);
        press(kind);
      },
    });
  }
}
