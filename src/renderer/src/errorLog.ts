import type { RendererErrorReport } from "../../shared/bridge";
import type { PanelName } from "../../shared/panels";
import { files } from "./core";

/** Chromium's notice that layout took two passes: harmless, and frequent. */
const RESIZE_OBSERVER_NOTICE = /^ResizeObserver loop/;

function report(
  kind: RendererErrorReport["kind"],
  reason: unknown,
  panel?: Pick<RendererErrorReport, "panel" | "componentStack">,
): void {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : typeof reason === "string" ? reason : "";
  if (RESIZE_OBSERVER_NOTICE.test(message)) return;
  try {
    files.logError({
      kind,
      name: error?.name ?? typeof reason,
      message,
      stack: error?.stack ?? "",
      ...panel,
    });
  } catch {
    // The log is a help, never a reason for another error.
  }
}

export const logCaught = (reason: unknown): void => report("error", reason);

/** An error a panel's boundary caught while it drew, with the components it was drawing. */
export const logPanelFailure = (panel: PanelName, reason: unknown, componentStack: string): void =>
  report("error", reason, { panel, componentStack });

/**
 * Sends errors nothing in the window caught to the log in the data folder.
 * The main process scrubs them of the User's content before writing them.
 */
export function installErrorLog(): void {
  window.addEventListener("error", (event) => report("error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report("rejection", event.reason));
}
