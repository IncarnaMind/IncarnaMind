/**
 * Connecting an agent where the step turns connecting agents on (#3362): an attempt that fails
 * never turns it off while another attempt connected an agent, or is still under way.
 */
import { describe, expect, test } from "vitest";
import type {
  AgentClient,
  AgentPairing,
  AgentSetupResult,
  SetUpAgent,
  SetUpAgentInput,
} from "../../src/core/api";
import {
  type AgentBridge,
  agentConnector,
  createAgentConnectors,
  manyAgentsConnector,
} from "../../src/renderer/src/agentConnection";
import { doneWords, setupProblem } from "../../src/renderer/src/components/agents/agentWords";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

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

  // protects=Settings › AI, which has its own switch, never turns it on or off; fails_when=connecting there changes the switch
  test("leaves the switch alone where it isn't asked to turn it on", async () => {
    const { state, connect, started } = bridgeOf();
    state.enabled = true;
    const attempt = connect(input("cursor"));
    (await started("cursor")).fail();
    await expect(attempt).rejects.toThrow();
    expect(state.enabled).toBe(true);
  });
});

describe("connecting several AI apps in one press (#3644)", () => {
  const clientOf = (id: AgentClient["id"], setup: AgentClient["setup"] = "file"): AgentClient => ({
    id,
    name: id,
    otherNames: [],
    chat: false,
    installed: true,
    setup,
    skillPath: null,
  });

  test("connects each app sequentially, and one failure leaves the others connected", async () => {
    const order: string[] = [];
    const state = { enabled: false, pairings: [] as AgentPairing[] };
    const bridge: AgentBridge = {
      getAgents: async () => ({ enabled: state.enabled, pairings: [...state.pairings] }),
      setAgentsEnabled: async (enabled) => {
        state.enabled = enabled;
      },
      setUpAgent: async (each) => {
        order.push(String(each.client));
        if (each.client === "cursor") throw new Error("No app can open this link.");
        const pairing = { id: `pairing-${each.client}`, client: each.client } as AgentPairing;
        state.pairings.push(pairing);
        return { pairing, result: { kind: "wrote", path: "" } } as SetUpAgent;
      },
    };
    const rollbackProblems: unknown[] = [];
    const connectMany = manyAgentsConnector(bridge, (error) => rollbackProblems.push(error));
    const outcomes = await connectMany(
      [clientOf("codex"), clientOf("cursor", "link"), clientOf("claude-code")],
      { folderIds: ["not-in-a-folder"], propose: true },
      { enable: true },
    );

    expect(order).toEqual(["codex", "cursor", "claude-code"]);
    expect(outcomes.map((each) => [each.client.id, each.kind])).toEqual([
      ["codex", "connected"],
      ["cursor", "failed"],
      ["claude-code", "connected"],
    ]);
    expect(state.enabled).toBe(true);
    expect(state.pairings).toHaveLength(2);
    expect(rollbackProblems).toEqual([]);
  });

  test("turns connecting agents back off when every app in the batch fails", async () => {
    const state = { enabled: false, pairings: [] as AgentPairing[] };
    const bridge: AgentBridge = {
      getAgents: async () => ({ enabled: state.enabled, pairings: [...state.pairings] }),
      setAgentsEnabled: async (enabled) => {
        state.enabled = enabled;
      },
      setUpAgent: async () => {
        throw new Error("Permission denied.");
      },
    };
    const connectMany = manyAgentsConnector(bridge, () => undefined);
    const outcomes = await connectMany(
      [clientOf("codex"), clientOf("claude-code")],
      { folderIds: ["not-in-a-folder"], propose: true },
      { enable: true },
    );

    expect(outcomes.every((each) => each.kind === "failed")).toBe(true);
    expect(state.enabled).toBe(false);
  });

  test("concurrent Try again keeps connecting agents on when one fails and the other connects", async () => {
    const { state, bridge, started, rollbackProblems } = bridgeOf();
    const connectMany = manyAgentsConnector(bridge, (error) => rollbackProblems.push(error));
    const first = connectMany(
      [clientOf("claude-code")],
      { folderIds: ["not-in-a-folder"], propose: true },
      { enable: true },
    );
    const claude = await started("claude-code");
    expect(state.enabled).toBe(true);
    const second = connectMany(
      [clientOf("codex")],
      { folderIds: ["not-in-a-folder"], propose: true },
      { enable: true },
    );
    const codex = await started("codex");
    claude.fail();
    const [failed] = await first;
    expect(failed?.kind).toBe("failed");
    expect(state.enabled).toBe(true);
    codex.connect();
    const [connected] = await second;
    expect(connected?.kind).toBe("connected");
    expect(state.enabled).toBe(true);
    expect(rollbackProblems).toEqual([]);
  });

  test("surfaces an enable failure without running any app setup", async () => {
    const called: string[] = [];
    const bridge: AgentBridge = {
      getAgents: async () => ({ enabled: false, pairings: [] }),
      setAgentsEnabled: async () => {
        throw new Error("Settings are read-only.");
      },
      setUpAgent: async (each) => {
        called.push(String(each.client));
        throw new Error("Should not run.");
      },
    };
    const connectMany = manyAgentsConnector(bridge, () => undefined);
    await expect(
      connectMany(
        [clientOf("codex"), clientOf("claude-code")],
        { folderIds: ["not-in-a-folder"], propose: true },
        { enable: true },
      ),
    ).rejects.toThrow("Settings are read-only.");
    expect(called).toEqual([]);
  });

  test("many-app copy instructions never claim the clipboard was written, even for unreadable settings files", () => {
    const pairing = {
      id: "p1",
      name: "Claude Code",
      client: "claude-code",
      folderIds: [],
      propose: true,
      lastUsedAt: null,
      createdAt: "2026-11-25T00:00:00.000Z",
    } as AgentPairing;
    const cases: AgentSetupResult[] = [
      {
        kind: "copy",
        how: "settings",
        text: "{}",
        shown: "{}",
        path: "/tmp/.workbuddy/mcp.json",
        skill: "",
      },
      {
        kind: "copy",
        how: "command",
        text: "claude mcp add",
        shown: "claude mcp add",
        path: "/tmp/.claude.json",
        skill: "",
      },
      { kind: "copy", how: "settings", text: "{}", shown: "{}", skill: "" },
      { kind: "copy", how: "command", text: "gemini mcp add", shown: "gemini mcp add", skill: "" },
    ];
    for (const language of ["en", "zh-CN"] as const) {
      const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
      for (const result of cases) {
        const line = doneWords(result, pairing, t, { copied: false });
        expect(line).not.toMatch(/Copied/i);
        expect(line).not.toContain("已复制");
        if (result.kind === "copy" && result.how === "settings" && result.path) {
          expect(line).toContain(result.path);
        }
      }
    }
    const other: AgentPairing = { ...pairing, client: "other", name: "Other agent" };
    expect(
      doneWords(
        { kind: "copy", how: "settings", text: "{}", shown: "{}", skill: "" },
        other,
        (key, params) => translate("en", key, params),
      ),
    ).toContain("Copied.");
    const kilo: AgentPairing = { ...pairing, client: "kilo-code", name: "Kilo Code" };
    expect(
      doneWords(
        { kind: "copy", how: "settings", text: "{}", shown: "{}", skill: "" },
        kilo,
        (key, params) => translate("en", key, params),
      ),
    ).not.toContain("Copied.");
  });

  // protects=one-app and many-app connectors share one in-flight counter so a failed one-app attempt never turns connecting off under a many-app batch (#3644); fails_when=agents.enabled flips false while the many-app batch is still running
  test("a failed one-app attempt never turns connecting off while a many-app batch is still under way", async () => {
    const { state, bridge, started } = bridgeOf();
    const { connectOne, connectMany } = createAgentConnectors(bridge, () => {});
    const batch = connectMany(
      [clientOf("cursor"), clientOf("codex")],
      { folderIds: ["not-in-a-folder"], propose: true },
      { enable: true },
    );
    const cursor = await started("cursor");
    expect(state.enabled).toBe(true);

    const single = connectOne(input("windsurf"), { enable: true });
    (await started("windsurf")).fail();
    await expect(single).rejects.toThrow();
    // The many-app batch is still in flight, so connecting must stay on.
    expect(state.enabled).toBe(true);

    cursor.connect();
    (await started("codex")).connect();
    await batch;
    expect(state.enabled).toBe(true);
    expect(state.pairings).toHaveLength(2);
  });

  // protects=setup failures outside the paste fallback show plain translated words in both EN and ZH rather than raw English OS messages (#3644); fails_when=EACCES/ENOSPC or raw English strings leak into the Chinese interface
  test("setupProblem gives plain words in both EN and ZH for system errors and unexpected failures", () => {
    const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
    const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

    const eacces = new Error("EACCES: permission denied, open '/etc/readonly.json'");
    expect(setupProblem(eacces, en)).toBe(en("error.system.notAllowed"));
    expect(setupProblem(eacces, zh)).toBe(zh("error.system.notAllowed"));

    const enospc = new Error("ENOSPC: no space left on device");
    expect(setupProblem(enospc, en)).toBe(en("error.system.full"));
    expect(setupProblem(enospc, zh)).toBe(zh("error.system.full"));

    const raw = new Error("spawn claude ENOENT raw unexpected");
    expect(setupProblem(raw, en)).toBe(en("agents.setup.failed"));
    expect(setupProblem(raw, zh)).toBe(zh("agents.setup.failed"));
    expect(setupProblem(raw, zh)).not.toMatch(/[A-Za-z]/);
  });
});
