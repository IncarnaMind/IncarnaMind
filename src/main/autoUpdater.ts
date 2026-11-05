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
const internals = autoUpdater as unknown as UpdaterInternals;
internals.stagingUserIdPromise = { value: Promise.resolve(randomUUID()) };
const finalHeaders = internals.computeFinalHeaders.bind(internals);
internals.computeFinalHeaders = (headers) => {
  const merged = finalHeaders(headers);
  for (const name of Object.keys(merged)) {
    if (name.toLowerCase() === "x-user-staging-id") delete merged[name];
  }
  return merged;
};

export { autoUpdater };
