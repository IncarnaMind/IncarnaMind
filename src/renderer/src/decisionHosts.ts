import { useEffect, useState } from "react";
import type { DecisionHostStatus } from "../../core/api";
import { core } from "./core";

/**
 * The decision model hosts (#1907) as the core last said, read when a view mounts and kept live:
 * a key kept or forgotten anywhere updates every view. Null until the first answer.
 */
export function useDecisionHosts(): [
  DecisionHostStatus[] | null,
  (hosts: DecisionHostStatus[]) => void,
] {
  const [hosts, setHosts] = useState<DecisionHostStatus[] | null>(null);
  useEffect(() => {
    core.listDecisionHosts().then(setHosts, (failure: unknown) => {
      console.error("The decision model hosts couldn't be read.", failure);
    });
    return core.on("decisions.changed", setHosts);
  }, []);
  return [hosts, setHosts];
}
