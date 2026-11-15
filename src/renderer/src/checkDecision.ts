import { useEffect, useState } from "react";
import type { CheckDecisionStatus } from "../../core/api";
import { core } from "./core";

const CHANGES = [
  "settings.changed",
  "decisions.changed",
  "privacy.changed",
  "dataFlows.changed",
] as const;

/**
 * The decision model for checks (#3118) as the core says now, read again whenever what it rests
 * on changes. Undefined until the first answer; null when the core can't say, so a page that
 * waits for it still opens, without its row.
 */
export function useCheckDecision(): CheckDecisionStatus | null | undefined {
  const [status, setStatus] = useState<CheckDecisionStatus | null | undefined>(undefined);
  useEffect(() => {
    let newest = 0;
    const read = () => {
      newest += 1;
      const mine = newest;
      core.getCheckDecision().then(
        (next) => {
          if (mine === newest) setStatus(next);
        },
        (failure: unknown) => {
          console.error("The decision model for checks couldn't be read.", failure);
          if (mine === newest) setStatus(null);
        },
      );
    };
    read();
    const stops = CHANGES.map((event) => core.on(event, read));
    return () => {
      newest = Number.NaN;
      for (const stop of stops) stop();
    };
  }, []);
  return status;
}
