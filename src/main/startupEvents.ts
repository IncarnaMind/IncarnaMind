import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { app } from "electron";

/**
 * Probe for #2104: the app records its startup steps and its windows' load events in the
 * lifecycle test's retained log, so every packaged spec sees the same events. No test folder
 * is set outside those specs, so a release build writes nothing.
 */
const folder =
  process.env.INCARNAMIND_TEST_STARTUP_DIR ?? process.env.INCARNAMIND_TEST_UPDATE_FOLDER;

export function recordStartupEvent(kind: string, extra: Record<string, unknown> = {}): void {
  if (!folder) return;
  appendFileSync(
    join(folder, "events.jsonl"),
    `${JSON.stringify({ kind, at: new Date().toISOString(), pid: process.pid, ...extra })}\n`,
  );
}

export function attachStartupEvents(): void {
  if (!folder) return;
  (
    globalThis as {
      incarnamindStartupProbe?: {
        step: (name: string, extra?: Record<string, unknown>) => void;
      };
    }
  ).incarnamindStartupProbe = {
    step: (name, extra = {}) => recordStartupEvent(`main-${name}`, extra),
  };

  let beats = 0;
  let recordedBeats = 0;
  const beatStart = performance.now();
  setInterval(() => {
    beats++;
    if (recordedBeats >= 240) return;
    const lagMs = Math.round(performance.now() - (beatStart + beats * 250));
    if (lagMs >= 100 || beats % 8 === 0) {
      recordedBeats++;
      recordStartupEvent("heartbeat", { tick: beats, lagMs });
    }
  }, 250).unref();

  let gone = 0;
  app.on("child-process-gone", (_event, details) => {
    if (gone >= 10) return;
    gone++;
    recordStartupEvent("child-process-gone", {
      process: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });

  app.on("browser-window-created", (_event, window) => {
    const windowId = window.id;
    window.webContents.on("dom-ready", () => recordStartupEvent("dom-ready", { windowId }));
    window.webContents.on("did-stop-loading", () =>
      recordStartupEvent("did-stop-loading", { windowId }),
    );
    window.webContents.on("preload-error", (_event, preloadPath, error) =>
      recordStartupEvent("window-preload-error", {
        windowId,
        preloadPath,
        message: error.message,
      }),
    );
    window.webContents.on("render-process-gone", (_event, details) =>
      recordStartupEvent("window-renderer-gone", { windowId, ...details }),
    );
    window.on("unresponsive", () => recordStartupEvent("unresponsive", { windowId }));
    window.on("responsive", () => recordStartupEvent("responsive", { windowId }));
    window.webContents.on("did-start-navigation", (details, url, isInPlace, isMainFrame) =>
      recordStartupEvent("window-navigation-started", {
        windowId,
        url: details.url ?? url,
        isSameDocument: details.isSameDocument ?? isInPlace,
        isMainFrame: details.isMainFrame ?? isMainFrame,
      }),
    );
    let sampled = false;
    window.webContents.on("did-start-loading", () => {
      recordStartupEvent("window-loading", { windowId, url: window.webContents.getURL() });
      if (sampled) return;
      sampled = true;
      for (const delay of [250, 1_000, 2_500, 4_000]) {
        const due = performance.now() + delay;
        setTimeout(() => {
          if (window.isDestroyed()) return;
          let rendererPid: number | null;
          try {
            rendererPid = window.webContents.getOSProcessId();
          } catch {
            rendererPid = null;
          }
          recordStartupEvent("renderer-sample", {
            windowId,
            dueInMs: delay,
            lateMs: Math.round(performance.now() - due),
            rendererPid,
            loading: window.webContents.isLoading(),
            crashed: window.webContents.isCrashed(),
            url: window.webContents.getURL(),
          });
        }, delay);
      }
    });
    let consoleErrors = 0;
    window.webContents.on("console-message", (details, level, message, line) => {
      const severity = details.level ?? (level === 3 ? "error" : undefined);
      if (severity !== "error" || consoleErrors >= 20) return;
      consoleErrors++;
      recordStartupEvent("window-console-error", {
        windowId,
        message: String(details.message ?? message ?? "").slice(0, 300),
        url: String(details.sourceId ?? "").slice(0, 300),
        line: details.lineNumber ?? line,
      });
    });
    window.webContents.on("did-finish-load", () =>
      recordStartupEvent("window-loaded", { windowId, url: window.webContents.getURL() }),
    );
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, url, isMainFrame) =>
        recordStartupEvent("window-load-failed", {
          windowId,
          errorCode,
          errorDescription,
          url,
          isMainFrame,
        }),
    );
    window.webContents.on(
      "did-fail-provisional-load",
      (_event, errorCode, errorDescription, url, isMainFrame) =>
        recordStartupEvent("window-provisional-load-failed", {
          windowId,
          errorCode,
          errorDescription,
          url,
          isMainFrame,
        }),
    );
  });
}
