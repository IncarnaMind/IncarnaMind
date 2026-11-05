/**
 * electron-updater, which ./updater imports dynamically: it takes tens of
 * milliseconds to load, and only a packaged app checks for updates, after
 * startup.
 */
import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { autoUpdater } from "electron-updater";

interface UpdaterInternals {
  stagingUserIdPromise: { value: Promise<string> };
  computeFinalHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders;
}

// electron-updater 6.8.10 keeps a random install ID in `.updaterId` and sends it on
// every check as `x-user-staging-id`, with no option to turn it off (#2557). The check
// sends no identifier of the install, so the ID is made for this run only, for a
// release's staged rollout percentage, and the header is dropped before a request leaves.
// A field that moves would let the header back in, so a check does not run without both.
export function stripInstallId(updater: Partial<UpdaterInternals>): boolean {
  if (updater.stagingUserIdPromise == null || typeof updater.computeFinalHeaders !== "function") {
    console.error(
      "The update check is off: electron-updater no longer exposes the fields that keep its install ID off the request (#2557).",
    );
    return false;
  }
  updater.stagingUserIdPromise = { value: Promise.resolve(randomUUID()) };
  const finalHeaders = updater.computeFinalHeaders.bind(updater);
  updater.computeFinalHeaders = (headers) => {
    const merged = finalHeaders(headers);
    for (const name of Object.keys(merged)) {
      if (name.toLowerCase() === "x-user-staging-id") delete merged[name];
    }
    return merged;
  };
  return true;
}

export const updateCheckSendsNoInstallId = stripInstallId(
  autoUpdater as unknown as Partial<UpdaterInternals>,
);
export { autoUpdater };
