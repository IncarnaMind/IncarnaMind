import { useEffect, useState } from "react";
import type { DataFlowId } from "../../../core/api";
import { core } from "../core";
import { useAppStore } from "../store";
import {
  destinationFrom,
  type TaggingDestination,
  unknownDestination,
} from "../taggingDestination";

/**
 * The service automatic tagging, or Organize, sends to now, and whether the
 * User has allowed it; a model on this computer; or not known yet, until the
 * flows have been read. Tagging is background work and never asks (ADR-0022):
 * where its Documents wait says so, and offers Allow in place. Read only while
 * `watching`.
 */
export function useTaggingService(flow: DataFlowId, watching: boolean): TaggingDestination {
  const [destination, setDestination] = useState<TaggingDestination>(unknownDestination);

  useEffect(() => {
    if (!watching) {
      setDestination(unknownDestination);
      return;
    }
    let stopped = false;
    const load = () => {
      // Say nothing while a new answer is read: the last one may name the wrong service (#1021).
      setDestination(unknownDestination);
      destinationFrom(
        () => core.listRegisteredDataFlows(),
        flow,
        (error) => {
          if (!stopped) useAppStore.getState().reportError(error);
        },
      ).then((next) => {
        if (!stopped) setDestination(next);
      });
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

  return destination;
}
