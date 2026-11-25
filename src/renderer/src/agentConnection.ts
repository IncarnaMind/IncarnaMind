/**
 * Connecting an agent, wherever the User does it (#351, #3362): Settings › AI and the setup's
 * Your AI step call the same core setup, so the agent is the one Settings lists. Pure: the bridge
 * is passed in, so the tests drive it.
 */
import type {
  AgentClient,
  AgentPairing,
  AgentSettings,
  AgentSetupResult,
  SetUpAgent,
  SetUpAgentInput,
} from "../../core/api";

export interface AgentBridge {
  getAgents(): Promise<Pick<AgentSettings, "enabled" | "pairings">>;
  setAgentsEnabled(enabled: boolean): Promise<unknown>;
  setUpAgent(input: SetUpAgentInput): Promise<SetUpAgent>;
}

export type ConnectAgent = (
  input: SetUpAgentInput,
  options?: { enable?: boolean },
) => Promise<SetUpAgent>;

/** The settled result of connecting one app in a multi-app pass (#3644). */
export type AgentConnectOutcome =
  | { kind: "connected"; client: AgentClient; pairing: AgentPairing; result: AgentSetupResult }
  | { kind: "failed"; client: AgentClient; error: unknown };

export type ConnectManyAgents = (
  clients: readonly AgentClient[],
  choice: { folderIds: string[]; propose: boolean },
  options?: { enable?: boolean },
) => Promise<AgentConnectOutcome[]>;

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

/**
 * Connects several apps one after another under one choice of folders and write grant (#3644).
 * Sequential because two apps can share a Skill folder; one failure never stops the others, and
 * `enable` turns connecting agents back off only if every app failed with nothing connected.
 */
export function manyAgentsConnector(
  bridge: AgentBridge,
  rollbackFailed: (error: unknown) => void,
): ConnectManyAgents {
  return async (clients, choice, { enable = false } = {}) => {
    let turnedOn = false;
    if (enable && !(await bridge.getAgents()).enabled) {
      await bridge.setAgentsEnabled(true);
      turnedOn = true;
    }
    const outcomes: AgentConnectOutcome[] = [];
    try {
      for (const client of clients) {
        try {
          const { pairing, result } = await bridge.setUpAgent({
            client: client.id,
            folderIds: choice.folderIds,
            propose: choice.propose,
          });
          turnedOn = false;
          outcomes.push({ kind: "connected", client, pairing, result });
        } catch (error) {
          outcomes.push({ kind: "failed", client, error });
        }
      }
      return outcomes;
    } finally {
      if (turnedOn) {
        await bridge
          .getAgents()
          .then(async (current) => {
            if (current.pairings.length === 0) await bridge.setAgentsEnabled(false);
          })
          .catch(rollbackFailed);
      }
    }
  };
}
