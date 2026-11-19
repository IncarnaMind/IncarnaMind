/**
 * The list of agents to connect (#3374), in the setup's Your AI step and Settings › Agents: those
 * on this computer first, then the most used, and any other found by typing its name.
 */
import { describe, expect, it } from "vitest";
import { AGENT_CLIENT_DEFINITIONS } from "../../src/core/agents/clients";
import type { AgentClient } from "../../src/core/api";
import { agentsShown, LISTED_AT_FIRST } from "../../src/renderer/src/agentList";

/** The core's list, the found ones first, as `listAgentClients` gives it. */
function listed(found: readonly string[]): AgentClient[] {
  const all = AGENT_CLIENT_DEFINITIONS.map((each) => ({
    id: each.id,
    name: each.name,
    otherNames: [...(each.otherNames ?? [])],
    installed: found.includes(each.id),
    setup: each.setup,
    skillPath: null,
  }));
  return [...all.filter((each) => each.installed), ...all.filter((each) => !each.installed)];
}
const nameOf = (client: AgentClient) => (client.id === "other" ? "Other agent" : client.name);
const ids = (clients: readonly AgentClient[]) => clients.map((each) => each.id);

describe("the agents a list shows", () => {
  // protects=a long list stays short until the User types; fails_when=every agent shows at once, the found ones aren't first, or Other agent is missing
  it("shows the found agents first, then the most used, and Other agent last", () => {
    const shown = agentsShown(listed(["zed", "qwen-code"]), "", nameOf);
    expect(ids(shown)).toEqual([
      "zed",
      "qwen-code",
      "claude-desktop",
      "claude-code",
      "codex",
      "cursor",
      "vscode",
      "other",
    ]);
    expect(shown).toHaveLength(LISTED_AT_FIRST + 1);
  });

  // protects=every agent found on this computer is listed, however many; fails_when=a found agent is cut off by the length
  it("shows every found agent, even past the usual length", () => {
    const found = AGENT_CLIENT_DEFINITIONS.slice(5, 15).map((each) => each.id);
    const shown = agentsShown(listed(found), "", nameOf);
    expect(ids(shown)).toEqual([...found, "other"]);
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
