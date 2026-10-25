import { useEffect, useState } from "react";
import type { ExternalService } from "../../../core/api";
import { core } from "../core";
import { useAppStore } from "../store";

export interface TaggingService {
  service: ExternalService;
  allowed: boolean;
}

/**
 * The service automatic tagging, or Organize, sends to now, and whether the
 * User has allowed it; null for a model on this computer. Tagging is
 * background work and never asks (ADR-0022): where its Documents wait says
 * so, and offers Allow in place. Read only while `watching`.
 */
export function useTaggingService(
  flow: "tagging" | "classification" | "scan-images",
  watching: boolean,
): TaggingService | null {
  const [tagging, setTagging] = useState<TaggingService | null>(null);

  useEffect(() => {
    if (!watching) {
      setTagging(null);
      return;
    }
    let stopped = false;
    const load = () => {
      core.listRegisteredDataFlows().then(
        (flows) => {
          if (stopped) return;
          // The flow goes only to the service the Tagging setting tags or organizes with now.
          const to = flows.find((each) => each.id === flow)?.services[0];
          setTagging(to ? { service: to.flow.service, allowed: to.consent === "accepted" } : null);
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

  return tagging;
}
