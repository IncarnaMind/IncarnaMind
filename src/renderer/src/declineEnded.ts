import { useEffect, useState } from "react";
import { core } from "./core";
import { useAppStore } from "./store";

/**
 * Whether the service has no declined use left: after an Answer was refused for the User's
 * "Don't allow" (#1297), they allowed it, or let it ask again. Trying the Answer again then sends
 * only if the service is allowed, and asks where the User is if it is not. Read only while
 * `watching`.
 */
export function useDeclineEnded(serviceId: string | null, watching: boolean): boolean {
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!watching || serviceId === null) {
      setEnded(false);
      return;
    }
    let stopped = false;
    let latest = 0;
    const load = () => {
      const mine = ++latest;
      core.listRegisteredDataFlows().then(
        (flows) => {
          if (stopped || mine !== latest) return;
          setEnded(
            !flows.some((flow) =>
              flow.services.some(
                (use) => use.flow.service.id === serviceId && use.consent === "declined",
              ),
            ),
          );
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
  }, [serviceId, watching]);

  return ended;
}
