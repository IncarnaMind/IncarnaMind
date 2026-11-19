/**
 * Connecting an agent where the step turns connecting agents on (#3362): an attempt that fails
 * never turns it off while another attempt connected an agent, or is still under way.
 */
import { describe, expect, test } from "vitest";
import type { AgentPairing, SetUpAgent, SetUpAgentInput } from "../../src/core/api";
import { type AgentBridge, agentConnector } from "../../src/renderer/src/agentConnection";

/** A core whose setups wait until the test settles them, one by one. */
function bridgeOf() {
  const state = { enabled: false, pairings: [] as AgentPairing[] };
  const waiting = new Map<string, { connect(): void; fail(): void }>();
  const bridge: AgentBridge = {
    getAgents: async () => ({ enabled: state.enabled, pairings: [...state.pairings] }),
    setAgentsEnabled: async (enabled) => {
      state.enabled = enabled;
    },
    setUpAgent: (input: SetUpAgentInput) =>
      new Promise<SetUpAgent>((resolve, reject) => {
        waiting.set(String(input.client), {
          connect: () => {
            const pairing = { id: `pairing-${input.client}` } as AgentPairing;
            state.pairings.push(pairing);
            resolve({ pairing, result: { kind: "wrote", path: "" } } as SetUpAgent);
          },
          fail: () => reject(new Error("Couldn't set it up.")),
        });
      }),
  };
  const started = async (client: string) => {
    while (!waiting.has(client)) await new Promise((wait) => setTimeout(wait, 1));
    return waiting.get(client) as { connect(): void; fail(): void };
  };
  const rollbackProblems: unknown[] = [];
  const connect = agentConnector(bridge, (error) => rollbackProblems.push(error));
  return { state, bridge, connect, started, rollbackProblems };
}

const input = (client: string): SetUpAgentInput => ({
  client: client as SetUpAgentInput["client"],
  folderIds: ["not-in-a-folder"],
  propose: true,
});

describe("connecting an agent where connecting agents is turned on with it", () => {
  // protects=an agent the User connected stays reachable when another attempt fails; fails_when=a failed attempt's rollback turns connecting agents off for the whole app with an agent connected
  test("a failed attempt leaves it on while another attempt connected an agent", async () => {
    const { state, connect, started } = bridgeOf();
    const first = connect(input("cursor"), { enable: true });
    const cursor = await started("cursor");
    expect(state.enabled).toBe(true);
    const second = connect(input("claude-code"), { enable: true });
    (await started("claude-code")).connect();
    await second;
    cursor.fail();
    await expect(first).rejects.toThrow("Couldn't set it up.");
    expect(state.pairings).toHaveLength(1);
    expect(state.enabled).toBe(true);
  });

  // protects=nothing is left on that the User didn't get an agent from; fails_when=the switch stays on after every attempt failed, or goes off while one is still under way
  test("turns it off again once every attempt has failed, and not before", async () => {
    const { state, connect, started } = bridgeOf();
    const first = connect(input("cursor"), { enable: true });
    const cursor = await started("cursor");
    const second = connect(input("claude-code"), { enable: true });
    const claudeCode = await started("claude-code");
    cursor.fail();
    await expect(first).rejects.toThrow();
    expect(state.enabled).toBe(true);
    claudeCode.fail();
    await expect(second).rejects.toThrow();
    expect(state.enabled).toBe(false);
  });

  // protects=a switch left on by mistake is found; fails_when=a failed rollback is swallowed, or hides why the agent couldn't connect
  test("reports a rollback that fails, and keeps the reason the agent couldn't connect", async () => {
    const { bridge, connect, started, rollbackProblems } = bridgeOf();
    const attempt = connect(input("cursor"), { enable: true });
    const cursor = await started("cursor");
    bridge.setAgentsEnabled = async () => {
      throw new Error("Settings are read-only.");
    };
    cursor.fail();
    await expect(attempt).rejects.toThrow("Couldn't set it up.");
    expect(rollbackProblems).toEqual([new Error("Settings are read-only.")]);
  });

  // protects=Settings › Agents, which has its own switch, never turns it on or off; fails_when=connecting there changes the switch
  test("leaves the switch alone where it isn't asked to turn it on", async () => {
    const { state, connect, started } = bridgeOf();
    state.enabled = true;
    const attempt = connect(input("cursor"));
    (await started("cursor")).fail();
    await expect(attempt).rejects.toThrow();
    expect(state.enabled).toBe(true);
  });
});
