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
 * Shared enable/rollback scope across one or many agent setup calls: `enable` turns connecting
 * agents on first, and only turns it back off when the last in-flight attempt settles with no
 * agent connected, so concurrent retries or a multi-app batch never turn agents off under one
 * that connected or is still connecting.
 */
function enableGuard(bridge: AgentBridge, rollbackFailed: (error: unknown) => void) {
  let going = 0;
  let turnedOn = false;
  const rollBack = async () => {
    turnedOn = false;
    if ((await bridge.getAgents()).pairings.length === 0) await bridge.setAgentsEnabled(false);
  };
  return async <T>(enable: boolean, run: (markConnected: () => void) => Promise<T>): Promise<T> => {
    going += 1;
    try {
      if (enable && !(await bridge.getAgents()).enabled) {
        await bridge.setAgentsEnabled(true);
        turnedOn = true;
      }
      return await run(() => {
        turnedOn = false;
      });
    } finally {
      going -= 1;
      if (going === 0 && turnedOn) await rollBack().catch(rollbackFailed);
    }
  };
}

/**
 * One-app and many-app connectors sharing a single in-flight enable/rollback guard (#3644), so a
 * failed one-app attempt can never turn connecting agents off while a many-app batch is still under
 * way, or vice versa.
 */
export function createAgentConnectors(
  bridge: AgentBridge,
  rollbackFailed: (error: unknown) => void,
): { connectOne: ConnectAgent; connectMany: ConnectManyAgents } {
  const guarded = enableGuard(bridge, rollbackFailed);
  const connectOne: ConnectAgent = (input, { enable = false } = {}) =>
    guarded(enable, async (markConnected) => {
      const setUp = await bridge.setUpAgent(input);
      markConnected();
      return setUp;
    });
  const connectMany: ConnectManyAgents = (clients, choice, { enable = false } = {}) =>
    guarded(enable, async (markConnected) => {
      const outcomes: AgentConnectOutcome[] = [];
      for (const client of clients) {
        try {
          const { pairing, result } = await bridge.setUpAgent({
            client: client.id,
            folderIds: choice.folderIds,
            propose: choice.propose,
          });
          markConnected();
          outcomes.push({ kind: "connected", client, pairing, result });
        } catch (error) {
          outcomes.push({ kind: "failed", client, error });
        }
      }
      return outcomes;
    });
  return { connectOne, connectMany };
}

/**
 * `enable` turns connecting agents on first, for a place with no switch of its own. It goes back
 * off only when the last attempt under way has settled with no agent connected, so a failed
 * attempt never turns agents off under one that connected or is still connecting.
 */
export function agentConnector(
  bridge: AgentBridge,
  rollbackFailed: (error: unknown) => void,
): ConnectAgent {
  return createAgentConnectors(bridge, rollbackFailed).connectOne;
}

/**
 * Connects several apps one after another under one choice of folders and write grant (#3644).
 * Sequential because two apps can share a Skill folder; one failure never stops the others, and
 * shares the `going` rollback guard across batches and concurrent retries.
 */
export function manyAgentsConnector(
  bridge: AgentBridge,
  rollbackFailed: (error: unknown) => void,
): ConnectManyAgents {
  return createAgentConnectors(bridge, rollbackFailed).connectMany;
}
