import { useEffect, useState } from "react";
import type { JevSettings, RegisteredDataFlow } from "../../../core/api";
import { secondLookOn } from "../checkSecondLook";
import { core } from "../core";
import { useAppStore } from "../store";

/**
 * Whether a check's second look catches a change of obligation now (#1926):
 * Jev with its key, and the checks flow allowed to send a Supported sentence
 * and its quote to it. False until #1926 adds that consent, so the card says
 * the limit.
 */
export function useCheckSecondLook(): boolean {
  const [jev, setJev] = useState<JevSettings | null>(null);
  const [flows, setFlows] = useState<readonly RegisteredDataFlow[]>([]);
  useEffect(() => {
    let stopped = false;
    const failed = (error: unknown) => {
      if (!stopped) useAppStore.getState().reportError(error);
    };
    const loadJev = () => {
      core.getJevSettings().then((next) => {
        if (!stopped) setJev(next);
      }, failed);
    };
    const loadFlows = () => {
      core.listRegisteredDataFlows().then((next) => {
        if (!stopped) setFlows(next);
      }, failed);
    };
    loadJev();
    loadFlows();
    const stops = [
      core.on("jev.changed", setJev),
      core.on("dataFlows.changed", setFlows),
      core.on("consent.resolved", loadFlows),
      core.on("chatReadiness.changed", loadFlows),
    ];
    return () => {
      stopped = true;
      for (const stop of stops) stop();
    };
  }, []);
  return secondLookOn(jev, flows);
}
