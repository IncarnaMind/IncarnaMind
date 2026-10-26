/**
 * The main window's size and place, kept per device in the data folder
 * (window.json), so the app opens as it was left. A place no display shows
 * any more (a screen unplugged since) is dropped and the window is centred;
 * the size never exceeds the display it opens on.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, type Rectangle, screen } from "electron";

const FILE = "window.json";
const SAVE_DELAY_MS = 500;
/** How much of the window's top edge must be on a display to open there: enough to grab it. */
const VISIBLE_PX = 64;

interface SavedWindow {
  bounds: Rectangle;
  maximized: boolean;
}

export interface WindowPlace {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function read(dataDir: string): SavedWindow | null {
  try {
    const saved = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as Partial<SavedWindow>;
    const bounds = saved.bounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(isNumber)) return null;
    return { bounds, maximized: saved.maximized === true };
  } catch {
    return null;
  }
}

/** Whether a display shows enough of the window's top edge to grab it. */
function grabbable({ x, y, width }: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    const across = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
    return across >= VISIBLE_PX && y >= workArea.y && y < workArea.y + workArea.height - VISIBLE_PX;
  });
}

/** Where the window opens: as it was left, if that is still on a display; else centred at `fallback`. */
export function windowPlace(
  dataDir: string,
  fallback: { width: number; height: number },
  minimum: { width: number; height: number },
): WindowPlace {
  const saved = read(dataDir);
  if (!saved) return { ...fallback, maximized: false };
  const onScreen = grabbable(saved.bounds);
  const { workArea } = onScreen
    ? screen.getDisplayMatching(saved.bounds)
    : screen.getPrimaryDisplay();
  const width = Math.max(minimum.width, Math.min(saved.bounds.width, workArea.width));
  const height = Math.max(minimum.height, Math.min(saved.bounds.height, workArea.height));
  return {
    ...(onScreen ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    width,
    height,
    maximized: saved.maximized,
  };
}

/** Saves the window's size and place as it moves and resizes, and as it closes. */
export function keepWindowPlace(window: BrowserWindow, dataDir: string): void {
  let pending = false;
  let saveAt: number | undefined;
  const save = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const saved: SavedWindow = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    };
    try {
      writeFileSync(join(dataDir, FILE), JSON.stringify(saved));
    } catch {
      // Not worth failing over: the window opens at its default size next time.
    }
  };
  const saveWhenQuiet = () => {
    pending = false;
    if (saveAt === undefined) return;
    const remaining = saveAt - performance.now();
    if (remaining > 0) {
      schedule(remaining);
      return;
    }
    saveAt = undefined;
    save();
  };
  const schedule = (delay: number) => {
    if (pending) return;
    pending = true;
    setTimeout(saveWhenQuiet, delay);
  };
  const saveSoon = () => {
    // A native resize can reenter Node's timer dispatch before its callback runs (#1244).
    // Move the deadline without clearing the callback Node is about to invoke.
    saveAt = performance.now() + SAVE_DELAY_MS;
    schedule(SAVE_DELAY_MS);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"] as const) {
    window.on(event as "resize", saveSoon);
  }
  window.on("close", () => {
    saveAt = undefined;
    save();
  });
}
