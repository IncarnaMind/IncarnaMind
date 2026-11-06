import { useEffect, useState } from "react";
import { core } from "./core";
import { checksWaitNow } from "./selfChecks";
import { useAppStore } from "./store";

/**
 * Whether checks wait for the User to allow what they send now (#2525). Once the User allows it,
 * in the dialog or in Settings › Privacy, what waited says only that it wasn't checked.
 */
export function useChecksWaitForConsent(): boolean {
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    let stopped = false;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      void checksWaitNow(
        () => core.listRegisteredDataFlows(),
        (error) => useAppStore.getState().reportError(error),
      ).then((now) => {
        if (!stopped && mine === latest) setWaiting(now);
      });
    };
    load();
    // A dialog answered in place changes the decision without the flows changing.
    const stops = [core.on("dataFlows.changed", load), core.on("consent.resolved", load)];
    return () => {
      stopped = true;
      for (const stop of stops) stop();
    };
  }, []);
  return waiting;
}
