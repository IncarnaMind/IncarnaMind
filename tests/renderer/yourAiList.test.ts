import { describe, expect, it } from "vitest";
import type { AgentClient, AgentClientId, AgentPairing } from "../../src/core/api";
import {
  firstTicked,
  foundApps,
  monogram,
  stillNeedsUser,
} from "../../src/renderer/src/components/firstRun/yourAiList";

/**
 * First run's Your AI list (#3791): the apps found on this computer in the order the step shows
 * them, the one ticked as it opens, and when an app connected still needs the User.
 */

const client = (id: AgentClientId, installed = true): AgentClient => ({
  id,
  name: id,
  otherNames: [],
  chat: false,
  installed,
  setup: "file",
  skillPath: null,
});

const pairing = (client: string, lastUsedAt: string | null = null): AgentPairing => ({
  id: `pairing-${client}`,
  name: client,
  folderIds: [],
  client,
  propose: true,
  lastUsedAt,
  createdAt: "2026-11-25T00:00:00.000Z",
});

describe("the apps found", () => {
  // protects=the step leads with the apps that can answer in IncarnaMind's window, then the chat apps, as the owner ordered them; fails_when=the list's own order or an app not found leads
  it("lists Claude Code, then ChatGPT and Codex, then Claude, then the rest in the list's order", () => {
    const clients = [
      client("claude-desktop"),
      client("cursor"),
      client("codex"),
      client("zed", false),
      client("claude-code"),
      client("vscode"),
      client("other"),
    ];
    expect(foundApps(clients, false).map((each) => each.id)).toEqual([
      "claude-code",
      "codex",
      "claude-desktop",
      "cursor",
      "vscode",
    ]);
  });

  // protects=Claude Code counts as found once the one-press install put it here, before the apps are read again; fails_when=the installed Claude Code is missing from the list
  it("counts Claude Code once it is installed here, though the list hasn't found it yet", () => {
    const clients = [client("claude-desktop"), client("claude-code", false)];
    expect(foundApps(clients, false).map((each) => each.id)).toEqual(["claude-desktop"]);
    expect(foundApps(clients, true).map((each) => each.id)).toEqual([
      "claude-code",
      "claude-desktop",
    ]);
  });

  // protects=only one app is ticked as the step opens, and none for a User who came back with one connected; fails_when=every app starts ticked, or a connected app is ticked again
  it("ticks the first not yet connected, and none once one is connected", () => {
    const found = foundApps([client("codex"), client("claude-code")], false);
    expect(firstTicked(found, [])).toBe("claude-code");
    expect(firstTicked(found, [pairing("claude-code")])).toBeNull();
    expect(firstTicked([], [])).toBeNull();
  });
});

describe("an app connected", () => {
  // protects=the step moves on only once every app chosen works, and stays while one waits for its own Install or a line to paste; fails_when=an app waiting for the User reads as ready, or one written to its settings reads as waiting
  it("still needs the User until its Install is pressed or its line is pasted", () => {
    const waiting = pairing("claude-desktop");
    expect(stillNeedsUser({ kind: "wrote", path: "/home/.claude.json" }, undefined, [])).toBe(
      false,
    );
    expect(stillNeedsUser({ kind: "opened", how: "bundle" }, waiting, [waiting.id])).toBe(true);
    expect(stillNeedsUser({ kind: "opened", how: "bundle" }, waiting, [])).toBe(false);
    const pasted = {
      kind: "copy",
      how: "command",
      text: "claude mcp add",
      shown: "claude mcp add",
      skill: "",
    } as const;
    expect(stillNeedsUser(pasted, pairing("opencode"), [])).toBe(true);
    expect(stillNeedsUser(pasted, pairing("opencode", "2026-11-25T01:00:00.000Z"), [])).toBe(false);
  });
});

describe("an app's mark", () => {
  it("takes the first letters of its name, two at most", () => {
    expect(monogram("Claude Code")).toBe("CC");
    expect(monogram("Claude")).toBe("C");
    expect(monogram("ChatGPT app and Codex")).toBe("C");
    expect(monogram("VS Code")).toBe("VC");
  });
});
