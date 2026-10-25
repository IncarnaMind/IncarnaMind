/**
 * The guide beside System Settings (#1105), for a permission the User must add by hand: the
 * microphone, or on macOS the computer's sound. A small window next to System Settings says what
 * to click, notices when the system has granted the permission, and closes itself; where the
 * screen has no room beside System Settings, the app's window shows the same steps as text.
 *
 * It never takes the focus from System Settings: it opens without it, and takes it only if the
 * User clicks it, when Esc closes it. The page is src/renderer/src/permissionGuide.
 */
import { join } from "node:path";
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  screen,
  systemPreferences,
} from "electron";
import type { AudioSource } from "../../core/api";
import { FILES_CHANNELS } from "../../shared/bridge";
import {
  GUIDE_MARGIN,
  GUIDE_WIDTH,
  type GuidePlacement,
  guidePlacement,
  isGranted,
  MEDIA_ACCESS_OF,
  PERMISSION_GUIDE_ARGUMENT,
  PERMISSION_GUIDE_CHANNELS,
  type PermissionGuideState,
} from "../../shared/permissionGuide";
import { handle } from "../ipc";

const POLL_MS = 1000;
/** How long the done message stays in the window beside System Settings; the app's window keeps it until the User dismisses it. */
const WINDOW_DONE_MS = 2500;
const FIRST_HEIGHT = 280;

const guideWindows = new WeakSet<BrowserWindow>();
export const isGuideWindow = (window: BrowserWindow) => guideWindows.has(window);

export interface PermissionGuideOptions {
  rendererUrl: string | undefined;
  /** The app's windows, which show the steps as text where the guide can't sit beside System Settings. */
  appWindows(): BrowserWindow[];
  /** Whether a call comes from IncarnaMind's own page. */
  trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean;
  /**
   * A test build lets the smoke tests say where the guide goes (INCARNAMIND_TEST_GUIDE) and what
   * the system answers (`globalThis.incarnamindFakePermission`), which no test can ask of the system.
   */
  testHooks: boolean;
}

const isSource = (value: unknown): value is AudioSource =>
  value === "microphone" || value === "system";

export function servePermissionGuide(options: PermissionGuideOptions): void {
  let state: PermissionGuideState | null = null;
  let guide: BrowserWindow | null = null;
  let polling: ReturnType<typeof setInterval> | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;

  const accessOf = (source: AudioSource): string => {
    if (options.testHooks) {
      // A test never asks the system: the permission is missing until the test grants it.
      const fake = (
        globalThis as { incarnamindFakePermission?: Partial<Record<AudioSource, string>> }
      ).incarnamindFakePermission?.[source];
      return fake ?? "denied";
    }
    if (process.platform !== "darwin") return "unknown";
    return systemPreferences.getMediaAccessStatus(MEDIA_ACCESS_OF[source]);
  };

  const displayArea = () => {
    const [front] = options.appWindows();
    const display = front
      ? screen.getDisplayMatching(front.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return display.workArea;
  };

  const placementNow = (): GuidePlacement => {
    const forced = options.testHooks ? process.env.INCARNAMIND_TEST_GUIDE : undefined;
    if (forced === "beside" || forced === "inline") return forced;
    return guidePlacement(process.platform, displayArea().width);
  };

  const tell = () => {
    for (const window of options.appWindows()) {
      if (!window.isDestroyed()) window.webContents.send(FILES_CHANNELS.permissionGuide, state);
    }
    if (guide && !guide.isDestroyed())
      guide.webContents.send(PERMISSION_GUIDE_CHANNELS.state, state);
  };

  function end(): void {
    clearInterval(polling);
    clearTimeout(leaving);
    polling = undefined;
    leaving = undefined;
    const window = guide;
    guide = null;
    state = null;
    if (window && !window.isDestroyed()) window.destroy();
    tell();
  }

  function open(): void {
    const area = displayArea();
    const window = new BrowserWindow({
      x: area.x + area.width - GUIDE_WIDTH - GUIDE_MARGIN,
      y: Math.round(area.y + (area.height - FIRST_HEIGHT) / 2),
      width: GUIDE_WIDTH,
      height: FIRST_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      hasShadow: true,
      title: "IncarnaMind",
      backgroundColor: "#FFFFFF",
      ...(process.platform === "darwin" && { type: "panel" }),
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [PERMISSION_GUIDE_ARGUMENT],
      },
    });
    guideWindows.add(window);
    guide = window;
    // As the meeting's floating panel is, so it follows the User into a full-screen Space.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.on("closed", () => {
      if (guide === window) end();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    if (options.rendererUrl) {
      void window.loadURL(new URL("permissionGuide.html", `${options.rendererUrl}/`).href);
    } else {
      void window.loadFile(join(__dirname, "../renderer/permissionGuide.html"));
    }
  }

  function granted(): void {
    if (!state || state.status === "granted") return;
    state = { ...state, status: "granted" };
    clearInterval(polling);
    polling = undefined;
    tell();
    if (state.placement === "beside") leaving = setTimeout(end, WINDOW_DONE_MS);
  }

  function show(source: AudioSource): GuidePlacement {
    const placement = placementNow();
    if (placement === "none") return "none";
    end();
    state = { source, placement, status: "waiting" };
    if (placement === "beside") open();
    tell();
    if (isGranted(accessOf(source))) granted();
    else {
      polling = setInterval(() => {
        if (state && isGranted(accessOf(state.source))) granted();
      }, POLL_MS);
    }
    return placement;
  }

  const fromGuide = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !!guide && !guide.isDestroyed() && event.sender === guide.webContents;

  handle(FILES_CHANNELS.showPermissionGuide, (event, source: unknown) => {
    if (!options.trusted(event)) throw new Error("Refused a call from an unknown page.");
    if (!isSource(source)) throw new Error('The source must be "microphone" or "system".');
    return show(source);
  });
  ipcMain.on(FILES_CHANNELS.closePermissionGuide, (event) => {
    if (options.trusted(event)) end();
  });
  ipcMain.on(FILES_CHANNELS.permissionGuideWanted, (event) => {
    if (options.trusted(event)) event.sender.send(FILES_CHANNELS.permissionGuide, state);
  });
  handle(PERMISSION_GUIDE_CHANNELS.state, (event) => {
    if (!fromGuide(event)) throw new Error("Refused a call from an unknown page.");
    return state;
  });
  ipcMain.on(PERMISSION_GUIDE_CHANNELS.close, (event) => {
    if (fromGuide(event)) end();
  });
  ipcMain.on(PERMISSION_GUIDE_CHANNELS.size, (event, width: unknown, height: unknown) => {
    if (!fromGuide(event) || !guide || typeof width !== "number" || typeof height !== "number")
      return;
    const size = { width: Math.ceil(width), height: Math.ceil(height) };
    if (size.width < 1 || size.height < 1) return;
    const bounds = guide.getBounds();
    if (bounds.width !== size.width || bounds.height !== size.height) {
      guide.setBounds({ x: bounds.x + bounds.width - size.width, y: bounds.y, ...size });
    }
    // Shown once the page has drawn its steps and told its size: never as a blank box.
    if (!guide.isVisible()) guide.showInactive();
  });
}
