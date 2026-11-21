import { useEffect, useState } from "react";
import type { OrganizeAgents, OrganizeTarget } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";

export function useOrganizeAgents(target: OrganizeTarget): OrganizeAgents | null {
  const [choice, setChoice] = useState<{ target: OrganizeTarget; agents: OrganizeAgents } | null>(
    null,
  );
  useEffect(() => {
    let version = 0;
    const read = () => {
      const current = ++version;
      core.agentsForOrganize(target).then(
        (agents) => {
          if (current === version) setChoice({ target, agents });
        },
        (error: unknown) => {
          if (current !== version) return;
          setChoice({ target, agents: { connected: false, eligible: [] } });
          useAppStore.getState().reportError(error);
        },
      );
    };
    read();
    const stops = [
      core.on("agents.changed", read),
      core.on("library.changed", read),
      core.on("library.assignments", read),
      core.on("settings.changed", read),
      core.on("dataFlows.changed", read),
    ];
    return () => {
      version++;
      for (const stop of stops) stop();
    };
  }, [target]);
  return choice?.target === target ? choice.agents : null;
}
