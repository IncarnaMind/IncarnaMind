/**
 * Starts IncarnaMind's log (./log) for the desktop app: the app's start (how it
 * ends is ./appEnd's), errors written to the console (which is where the core
 * and the main process report problems), errors nothing caught in the main
 * process, and windows and processes that crashed. The core logs through the
 * `log` adapter (./platform); the window's uncaught errors come over the files
 * bridge (./files).
 */
import { arch, release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { ANALYSIS_ORIGIN } from "../shared/analysisWindow";
import { pageName } from "./appEnd";
import { createScrubber } from "./crashScrubber";
import { createFileLogger, createLogFile, type FileLogger, logConsole, logsFolder } from "./log";

/** Starts the log in the data folder's `logs/`. Call once, as early as the data folder is known. */
export function startLogging(dataDir: string): FileLogger {
  const logger = createFileLogger({
    file: createLogFile({ directory: logsFolder(dataDir) }),
    scrubber: createScrubber({
      homeDir: app.getPath("home"),
      dataDir,
      others: [app.getPath("temp")],
    }),
    appPath: app.getAppPath(),
  });
  const printError = console.error.bind(console);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const ownPages = [
    pathToFileURL(join(__dirname, "../renderer/")).href,
    `${ANALYSIS_ORIGIN}/`,
    ...(rendererUrl ? [`${new URL(rendererUrl).origin}/`] : []),
  ];
  logConsole(logger);

  // A monitor, so Electron still handles the error as it would have.
  process.on("uncaughtExceptionMonitor", (error, origin) =>
    logger.exception("main.uncaught", error, { origin }),
  );
  if (process.env.INCARNAMIND_TEST_HOOKS === "1") {
    // Electron answers an uncaught main-process error with a synchronous error box. Nobody
    // dismisses one on a runner, so the main thread stays blocked and every later call times
    // out as an app that isn't answering, which hid the error itself (#1741). The monitor above
    // has logged it; an app a test drives goes on.
    process.on("uncaughtException", (error) => printError("Uncaught exception:", error));
  }
  // Electron's main process only warns about these; this logs them whole, and still warns.
  process.on("unhandledRejection", (reason) => {
    logger.exception("main.unhandledRejection", reason);
    printError("Unhandled promise rejection:", reason);
  });
  app.on("render-process-gone", (_event, contents, details) => {
    const fields = {
      page: pageName(contents.getURL(), ownPages),
      reason: details.reason,
      exitCode: details.exitCode,
    };
    if (details.reason === "clean-exit") logger.info("window.exited", fields);
    else logger.error("window.crashed", fields);
  });
  app.on("child-process-gone", (_event, details) => {
    const fields = {
      type: details.type,
      service: details.serviceName,
      reason: details.reason,
      exitCode: details.exitCode,
    };
    if (details.reason === "clean-exit") logger.info("process.exited", fields);
    else logger.error("process.crashed", fields);
  });

  logger.info("app.start", {
    version: app.getVersion(),
    electron: process.versions.electron,
    os: process.platform,
    osVersion: release(),
    arch: arch(),
    packaged: app.isPackaged,
    pid: process.pid,
  });
  return logger;
}
