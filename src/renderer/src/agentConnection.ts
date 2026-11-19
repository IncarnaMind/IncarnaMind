/**
 * Connecting an agent, wherever the User does it (#351, #3362): Settings › Agents and the setup's
 * Your AI step call the same core setup, so the agent is the one Settings lists. Pure: the bridge
 * is passed in, so the tests drive it.
 */
import type { AgentSettings, SetUpAgent, SetUpAgentInput } from "../../core/api";

export interface AgentBridge {
  getAgents(): Promise<Pick<AgentSettings, "enabled" | "pairings">>;
  setAgentsEnabled(enabled: boolean): Promise<unknown>;
  setUpAgent(input: SetUpAgentInput): Promise<SetUpAgent>;
}

export type ConnectAgent = (
  input: SetUpAgentInput,
  options?: { enable?: boolean },
) => Promise<SetUpAgent>;

/**
 * `enable` turns connecting agents on first, for a place with no switch of its own. It goes back
 * off only when the last attempt under way has settled with no agent connected, so a failed
 * attempt never turns agents off under one that connected or is still connecting.
 */
export function agentConnector(
  bridge: AgentBridge,
  rollbackFailed: (error: unknown) => void,
): ConnectAgent {
  let going = 0;
  let turnedOn = false;
  const rollBack = async () => {
    turnedOn = false;
    if ((await bridge.getAgents()).pairings.length === 0) await bridge.setAgentsEnabled(false);
  };
  return async (input, { enable = false } = {}) => {
    going += 1;
    try {
      if (enable && !(await bridge.getAgents()).enabled) {
        await bridge.setAgentsEnabled(true);
        turnedOn = true;
      }
      const setUp = await bridge.setUpAgent(input);
      turnedOn = false;
      return setUp;
    } finally {
      going -= 1;
      if (going === 0 && turnedOn) await rollBack().catch(rollbackFailed);
    }
  };
}
