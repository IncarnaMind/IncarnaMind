import { useEffect, useState } from "react";
import { core } from "./core";
import { checksWaitIn } from "./selfChecks";
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
      core.listRegisteredDataFlows().then(
        (flows) => {
          if (!stopped && mine === latest) setWaiting(checksWaitIn(flows));
        },
        (error: unknown) => useAppStore.getState().reportError(error),
      );
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
