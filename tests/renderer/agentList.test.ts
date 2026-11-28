/**
 * The list of agents to connect (#3374), in the setup's Your AI step and Settings › AI: every one
 * (#3767), chat apps before coding tools (#3487), those on this computer first in each, and any
 * found by typing its name.
 */
import { describe, expect, it } from "vitest";
import { AGENT_CLIENT_DEFINITIONS } from "../../src/core/agents/clients";
import type { AgentClient } from "../../src/core/api";
import { agentsShown } from "../../src/renderer/src/agentList";

/** The core's list, the found ones first, as `listAgentClients` gives it. */
function listed(found: readonly string[]): AgentClient[] {
  const all = AGENT_CLIENT_DEFINITIONS.map((each) => ({
    id: each.id,
    name: each.name,
    otherNames: [...(each.otherNames ?? [])],
    chat: each.chat === true,
    installed: found.includes(each.id),
    setup: each.setup,
    skillPath: null,
  }));
  return [...all.filter((each) => each.installed), ...all.filter((each) => !each.installed)];
}
const nameOf = (client: AgentClient) => (client.id === "other" ? "Other agent" : client.name);
const ids = (clients: readonly AgentClient[]) => clients.map((each) => each.id);

describe("the agents a list shows", () => {
  // protects=every agent shows before anything is typed, chat apps first, the found ones first of each kind, and Other agent last (#3767); fails_when=an agent is missing, a coding tool comes before a chat app, or a found one after one not found of its kind
  it("shows every agent, chat apps first, the found ones first of each kind, then Other agent", () => {
    const shown = ids(agentsShown(listed(["zed", "qwen-code"]), "", nameOf));
    expect(shown).toHaveLength(AGENT_CLIENT_DEFINITIONS.length);
    expect(shown.slice(0, 3)).toEqual(["claude-desktop", "codex", "workbuddy"]);
    expect(shown.slice(3, 5)).toEqual(["zed", "qwen-code"]);
    expect(shown.at(-1)).toBe("other");
  });

  // protects=no agent leaves the list because another was found on this computer (#3767); fails_when=finding Claude Code takes Antigravity or any other off the list
  it("keeps every agent whether or not one is found", () => {
    const none = ids(agentsShown(listed([]), "", nameOf));
    const one = ids(agentsShown(listed(["claude-code"]), "", nameOf));
    expect([...one].sort()).toEqual([...none].sort());
  });

  // protects=any agent is found by typing its name, a part of it, or another name it goes by; fails_when=case, spaces or a former name stop a match
  it.each([
    ["kimi", ["kimi-code"]],
    ["WINDSURF", ["devin"]],
    ["vscode", ["vscode"]],
    ["copilot", ["vscode"]],
    ["gemini", ["antigravity", "gemini-cli"]],
    ["open", ["codex", "opencode", "openclaw"]],
    ["通义", ["qwen-code"]],
  ])("finds %s", (typed, found) => {
    expect(ids(agentsShown(listed([]), typed, nameOf))).toEqual([...found, "other"]);
  });

  // protects=Other agent is always there to connect an agent the list doesn't name; fails_when=a name with no match leaves nothing to choose
  it("keeps Other agent when nothing matches", () => {
    expect(ids(agentsShown(listed(["cursor"]), "goose", nameOf))).toEqual(["other"]);
  });
});
