import type { BrowserWindow } from "electron";
import type { Language } from "../../core/language";
import { FILES_CHANNELS, type SummarySaveState } from "../../shared/bridge";
import { translate } from "../../shared/i18n";
import { showMessageBox } from "../systemDialogs";

interface SaveInWindow {
  state: SummarySaveState;
  close(): Promise<boolean>;
}
const open = new Set<SaveInWindow>();

export const summariesWaiting = () => [...open].some((entry) => entry.state !== "clear");

export async function settleSummaries(): Promise<boolean> {
  for (const entry of open) if (!(await entry.close())) return false;
  return true;
}

export function watchSummaryClosing(window: BrowserWindow, language: () => Promise<Language>) {
  let changed: (() => void) | undefined;
  let checking: Promise<boolean> | undefined;
  const set = (state: SummarySaveState) => {
    entry.state = state;
    changed?.();
  };
  const settle = async () => {
    while (entry.state === "saving")
      await new Promise<void>((resolve) => {
        changed = resolve;
      });
    if (entry.state === "clear") return true;
    const lang = await language();
    const choice = await showMessageBox(window, {
      type: "warning",
      message: translate(lang, "meetings.summary.content.closeMessage"),
      buttons: [
        translate(lang, "quit.unsaved.keep"),
        translate(lang, "meetings.summary.content.discard"),
      ],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return false;
    if (!window.isDestroyed()) window.webContents.send(FILES_CHANNELS.discardSummaryDrafts);
    set("clear");
    return true;
  };
  const entry: SaveInWindow = {
    state: "clear",
    close: () =>
      (checking ??= settle().finally(() => {
        checking = undefined;
      })),
  };
  open.add(entry);
  window.webContents.ipc.on(FILES_CHANNELS.summarySaveState, (event, state: unknown) => {
    if (event.senderFrame !== window.webContents.mainFrame) return;
    if (state === "clear" || state === "saving" || state === "problem") set(state);
  });
  window.webContents.on("render-process-gone", () => set("clear"));
  window.once("closed", () => {
    set("clear");
    open.delete(entry);
  });
  let closing = false;
  window.on("close", (event) => {
    if (entry.state === "clear") return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    entry
      .close()
      .then((allowed) => {
        if (allowed && !window.isDestroyed()) window.close();
      })
      .catch((error: unknown) => {
        console.error("Could not settle the meeting summary before closing its window", error);
      })
      .finally(() => {
        closing = false;
      });
  });
}
