import { useEffect, useRef, useState } from "react";
import type { RegisteredDataFlow, TaggingFlow, TaggingRoute } from "../../../core/api";
import { core } from "../core";
import { useAppStore } from "../store";
import { serviceOf, type TaggingService, unknownService } from "../taggingDestination";

/**
 * Where automatic tagging, or Organize, sends now, and whether the User allowed
 * it; read while `watching`. The model's route and the flows are read apart, so
 * the row can name the service before the flows are known; a failed read keeps
 * the last answer, and the flows alone never say a model is on this computer.
 */
export function useTaggingService(flow: TaggingFlow, watching: boolean): TaggingService {
  const [service, setService] = useState<TaggingService>(unknownService);
  const route = useRef<TaggingRoute | null>(null);

  useEffect(() => {
    route.current = null;
    setService(unknownService);
    if (!watching) return;
    let stopped = false;
    let generation = 0;
    const load = (reset = false) => {
      const reading = ++generation;
      if (reset) {
        route.current = null;
        setService(unknownService);
      }
      let nextRoute: TaggingRoute | null = null;
      let nextFlows: RegisteredDataFlow[] | null = null;
      const settle = () => {
        if (stopped || reading !== generation || !nextRoute) return;
        if (nextFlows) {
          route.current = nextRoute;
          setService(serviceOf(flow, nextRoute, nextFlows));
        } else if (JSON.stringify(nextRoute) !== JSON.stringify(route.current)) {
          setService(serviceOf(flow, nextRoute, null));
        }
      };
      core.getTaggingRoute(flow).then(
        (next) => {
          nextRoute = next;
          settle();
        },
        (error: unknown) => useAppStore.getState().reportError(error),
      );
      core.listRegisteredDataFlows().then(
        (next) => {
          nextFlows = next;
          settle();
        },
        (error: unknown) => useAppStore.getState().reportError(error),
      );
    };
    load();
    const stops = [
      core.on("dataFlows.changed", () => load(true)),
      core.on("jev.changed", () => load(true)),
      core.on("chatReadiness.changed", () => load(true)),
      core.on("library.changed", () => load()),
    ];
    return () => {
      stopped = true;
      for (const stop of stops) stop();
    };
  }, [flow, watching]);

  return service;
}
