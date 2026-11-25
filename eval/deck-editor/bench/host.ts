/**
 * The bake-off's bench (../README.md): one Electron window, the app's own
 * runtime, showing one arm's page. The page reads and writes deck files and
 * asks for arm A's patches through the preload; the patches run here, in a
 * Node process, as the core does in the app. Every request the page makes is
 * logged, and every one that isn't a file of the page's own is refused.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { applyShapeEdits } from "../../../src/core/exports/pptxPatch/edits";
import type { ShapeEdit } from "../../../src/core/exports/pptxPatch/shapeEdit";

const argument = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const page = argument("--page");
const requests = argument("--requests");
const data = argument("--data");
if (!page || !requests || !data) {
  throw new Error("The bench needs --page <index.html>, --requests <log> and --data <folder>.");
}
// Electron's own folders ignore HOME on macOS: the bench names its own.
app.setPath("userData", data);
app.setPath("sessionData", data);

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    appendFileSync(
      requests,
      `${JSON.stringify({ url: details.url.slice(0, 300), type: details.resourceType })}\n`,
    );
    const own =
      details.url.startsWith("file://") ||
      details.url.startsWith("data:") ||
      details.url.startsWith("blob:") ||
      details.url.startsWith("devtools:");
    callback({ cancel: !own });
  });
  ipcMain.handle("bench:read", (_event, path: string) => new Uint8Array(readFileSync(path)));
  ipcMain.handle("bench:write", (_event, path: string, bytes: Uint8Array) =>
    writeFileSync(path, bytes),
  );
  ipcMain.handle("bench:edit", (_event, bytes: Uint8Array, edits: ShapeEdit[]) =>
    applyShapeEdits(bytes, edits),
  );
  const window = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  void window.loadFile(page);
});

app.on("window-all-closed", () => app.quit());
