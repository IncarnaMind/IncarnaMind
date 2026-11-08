import { type BrowserWindow, Notification } from "electron";
import type { SystemNotifications } from "../core";

/**
 * The system's notifications (#126), for a Task that needs the User or has
 * finished while its Mind isn't on screen. Every app window is the core's
 * "main" window. Until the first window shows, nothing is decided: at start,
 * it may be about to show the very Mind a notification is about.
 */
export function createSystemNotifications(windows: () => BrowserWindow[]): SystemNotifications {
  let shown = false;
  let waiting: (() => void)[] = [];
  /** Kept until clicked or closed: a notification no one holds can't be clicked. */
  const live = new Set<Notification>();

  const front = () =>
    windows().filter(
      (window) =>
        !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.isFocused(),
    );

  const whenShown = (decide: () => void) => {
    if (shown) {
      decide();
      return;
    }
    const first = windows()[0];
    // Started at login without a window (#189): no window is about to show anything.
    if (!first) {
      shown = true;
      decide();
      return;
    }
    waiting.push(decide);
    const ready = () => {
      if (shown) return;
      shown = true;
      // Shown, it takes the focus on the next turn.
      setImmediate(() => {
        const decisions = waiting;
        waiting = [];
        for (const each of decisions) each();
      });
    };
    if (first.isVisible()) ready();
    else first.once("show", ready);
  };

  return {
    show(note, onScreen, onClick) {
      whenShown(() => {
        if (onScreen(front().map(() => "main"))) return;
        if (!Notification.isSupported()) return;
        const notification = new Notification({ title: note.title, body: note.body });
        live.add(notification);
        notification.on("close", () => live.delete(notification));
        notification.on("click", () => {
          live.delete(notification);
          const [window] = windows();
          if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          }
          onClick();
        });
        notification.show();
      });
    },
  };
}
