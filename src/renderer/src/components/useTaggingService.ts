import { useEffect, useRef, useState } from "react";
import type { DataFlowId, RegisteredDataFlow, TaggingRoute } from "../../../core/api";
import { core } from "../core";
import { useAppStore } from "../store";
import { serviceOf, type TaggingService, unknownService } from "../taggingDestination";

/**
 * Where automatic tagging, or Organize, sends now, and whether the User allowed
 * it; read while `watching`. The model's route and the flows are read apart, so
 * the row can name the service before the flows are known; a failed read keeps
 * the last answer, and the flows alone never say a model is on this computer.
 */
export function useTaggingService(flow: DataFlowId, watching: boolean): TaggingService {
  const [service, setService] = useState<TaggingService>(unknownService);
  const route = useRef<TaggingRoute | null>(null);
  const flows = useRef<RegisteredDataFlow[] | null>(null);

  useEffect(() => {
    route.current = null;
    flows.current = null;
    setService(unknownService);
    if (!watching) return;
    let stopped = false;
    const settle = () => {
      if (!stopped)
        setService(serviceOf(flow, flow === "tagging" ? route.current : null, flows.current));
    };
    const load = () => {
      if (flow === "tagging") {
        core.getTaggingRoute().then(
          (next) => {
            route.current = next;
            settle();
          },
          (error: unknown) => useAppStore.getState().reportError(error),
        );
      }
      core.listRegisteredDataFlows().then(
        (next) => {
          flows.current = next;
          settle();
        },
        (error: unknown) => useAppStore.getState().reportError(error),
      );
    };
    load();
    const stops = [
      core.on("dataFlows.changed", load),
      core.on("jev.changed", load),
      core.on("chatReadiness.changed", load),
      core.on("library.changed", load),
    ];
    return () => {
      stopped = true;
      for (const stop of stops) stop();
    };
  }, [flow, watching]);

  return service;
}
