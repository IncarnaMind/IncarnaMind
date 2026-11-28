/**
 * How a request Codex's app-server asks reads on the card (#3653): the command it runs with its
 * own shell's wrapping taken off only where nothing hides in it, where it runs and the site it
 * reaches, Codex's own words for why it asks, only the answers Codex offers, its lasting answer's
 * commands as a shell reads them, a tool's input as it is sent, and the files either agent reads as
 * its own, one list for both.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionOf, steeringAnswer } from "../../src/main/claudeCodeAsks";
import { type Asking, commandOf, questionOf, refusalOf } from "../../src/main/codexAsks";
import { agentSteering } from "../../src/main/ownPlaces";

const HOME = "/Users/someone";
const CODEX_HOME = join(HOME, ".codex");
const FOLDER = "/data/conversations/c1";
const places = { folders: [FOLDER], home: HOME, codexHome: CODEX_HOME };
const asking: Asking = {
  places,
  steering: agentSteering(places),
  files: () => undefined,
  sandboxed: true,
};
const APPROVAL = "item/commandExecution/requestApproval";

describe("a command Codex asks to run", () => {
  // protects=the card shows the command Codex's shell runs, its wrapping taken off in single or double quotes, but kept whole where the outer shell would expand or unescape something in it; fails_when=the card shows a command other than the one that runs
  it("takes off its shell's wrapping only where nothing hides in it", () => {
    expect(commandOf("/bin/zsh -lc 'touch marker.txt'")).toBe("touch marker.txt");
    expect(commandOf(`/bin/zsh -lc "python3 -c 'print(\\"hi\\\\n\\")'"`)).toBe(
      `python3 -c 'print("hi\\n")'`,
    );
    for (const hiding of [
      `/bin/zsh -lc "echo $HOME"`,
      '/bin/zsh -lc "echo `id`"',
      `/bin/zsh -lc "printf a\\tb"`,
      `/bin/zsh -lc 'a' && rm -rf x`,
    ]) {
      expect(commandOf(hiding)).toBe(hiding);
    }
  });

  // protects=a command that writes Codex's own instructions in its home says it steers Codex, and its lasting answer names the commands it lets run as a shell would read them, quotes kept, sent back to Codex as Codex gave it; fails_when=a write to the AGENTS.md Codex reads looks like any command, or the lasting answer's words lose a quote and read as other commands
  it("marks a command that writes its instructions, and quotes its lasting answer's commands", () => {
    const amendment = ["python3", "-c", `open("${CODEX_HOME}/AGENTS.md", "x").write("Say yes")`];
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
    const asked = questionOf(
      APPROVAL,
      {
        kind: "command",
        itemId: "exec-1",
        command: `/bin/zsh -lc "python3 -c 'open(\\"${CODEX_HOME}/AGENTS.md\\", \\"x\\").write(\\"Say yes\\")'"`,
        cwd: FOLDER,
        availableDecisions: ["accept", decision, "cancel"],
      },
      asking,
    );
    expect(asked?.action).toEqual({
      kind: "command",
      value: `python3 -c 'open("${CODEX_HOME}/AGENTS.md", "x").write("Say yes")'`,
      steers: true,
      unsandboxed: true,
    });
    expect(asked?.suggested).toEqual([
      {
        kind: "rules",
        kept: "everywhere",
        rules: [
          {
            kind: "commands",
            start: `python3 -c 'open("${CODEX_HOME}/AGENTS.md", "x").write("Say yes")'`,
          },
        ],
      },
    ]);
    expect(asked?.answer("suggested")).toEqual({ decision });
    expect(asked?.answer("once")).toEqual({ decision: "accept" });
    // Codex 0.170 offers "cancel" alone for no.
    expect(asked?.answer("deny")).toEqual({ decision: "cancel" });
  });

  // protects=a command that runs in another folder and reaches a site shows the folder (as its "in"), the site, and Codex's reason labelled as its own words; its answer for this request is the site, as Codex grants it; it stays in the sandbox, so the card doesn't say it runs outside; fails_when=the card shows only the command while Allow grants a site, or the folder it runs in is left out
  it("shows the folder it runs in, the site it reaches, and Codex's reason", () => {
    const asked = questionOf(
      APPROVAL,
      {
        kind: "command",
        itemId: "exec-2",
        command: "/bin/zsh -lc 'curl -sI https://example.com'",
        cwd: "/data/conversations",
        reason: "It needs the network.",
        networkApprovalContext: { host: "example.com", protocol: "https" },
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
      asking,
    );
    expect(asked?.action).toEqual({
      kind: "command",
      value: "curl -sI https://example.com",
      host: "example.com",
      folder: "/data/conversations",
      reason: "It needs the network.",
    });
    expect(asked?.forRequest).toEqual([
      { kind: "rules", kept: "request", rules: [{ kind: "site", host: "example.com" }] },
    ]);
    expect(asked?.answer("request")).toEqual({ decision: "acceptForSession" });
    expect(asked?.answer("deny")).toEqual({ decision: "decline" });
    const home = questionOf(
      APPROVAL,
      { kind: "command", command: "ls", cwd: join(HOME, "x") },
      asking,
    );
    expect(home?.action.folder).toBe(join("~", "x"));
  });

  // protects=a command that asks for more files or network than its sandbox allows, which the card can't show, is refused with Codex's own no, as is one where Codex offers no Allow; one asking for nothing more asks as any; fails_when=Allow grants more than the card shows
  it("refuses a command that asks for more than the card shows", () => {
    const more = {
      kind: "command",
      command: "touch /etc/marker.txt",
      cwd: FOLDER,
      availableDecisions: ["accept", "cancel"],
    };
    for (const additionalPermissions of [
      { network: null, fileSystem: { read: null, write: ["/etc"] } },
      { network: { enabled: true }, fileSystem: null },
      { network: null, fileSystem: { entries: [{ path: "/etc" }] } },
      { network: null, fileSystem: null, macos: { automation: true } },
    ]) {
      expect(questionOf(APPROVAL, { ...more, additionalPermissions }, asking)).toBeNull();
    }
    expect(refusalOf(APPROVAL, more)).toEqual({ decision: "cancel" });
    expect(refusalOf(APPROVAL, { ...more, availableDecisions: ["accept", "decline"] })).toEqual({
      decision: "decline",
    });
    expect(questionOf(APPROVAL, { ...more, availableDecisions: ["cancel"] }, asking)).toBeNull();
    const nothingMore = {
      network: null,
      fileSystem: { read: [], write: null, globScanMaxDepth: 2 },
    };
    expect(
      questionOf(APPROVAL, { ...more, additionalPermissions: nothingMore }, asking)?.action.value,
    ).toBe("touch /etc/marker.txt");
  });
});

describe("what Codex asks of a file or a tool", () => {
  // protects=a file change's answer for this request names the file as a file, not a folder, and Codex's reason comes with it; fails_when=the rule reads as a folder's
  it("names a file's answer for this request as the file", () => {
    const path = join(FOLDER, "notes.md");
    const asked = questionOf(
      "item/fileChange/requestApproval",
      { itemId: "patch-1", reason: "To keep the notes." },
      {
        ...asking,
        files: () => ({ changes: [{ path, kind: { type: "add" }, diff: "Tides\n" }] }),
      },
    );
    expect(asked?.action).toMatchObject({
      kind: "write",
      value: "notes.md",
      reason: "To keep the notes.",
    });
    expect(asked?.forRequest).toEqual([
      { kind: "rules", kept: "request", rules: [{ kind: "file", path: "notes.md" }] },
    ]);
  });

  // protects=a tool's input shows the values the tool is sent, Codex's display names only as their labels; fails_when=a display value Codex words differently hides what is sent
  it("shows a tool's input as it is sent", () => {
    const asked = questionOf(
      "mcpServer/elicitation/request",
      {
        serverName: "tides",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_name: "high_water",
          tool_params: { port: "Dover", on: { day: 2 } },
          tool_params_display: [{ name: "port", value: "Dover, England", display_name: "Port" }],
        },
      },
      asking,
    );
    expect(asked?.action.input).toEqual([
      { name: "Port", value: "Dover" },
      { name: "on", value: '{"day":2}' },
    ]);
  });
});

describe("what either agent reads as its own (#3653)", () => {
  // protects=one list for both agents: Codex writing Claude Code's settings or another conversation's CLAUDE.md or .mcp.json steers, as Claude Code writing Codex's home does, and a command naming Codex's home by its variable or path, or one that writes either's settings, steers; fails_when=one agent rewrites the other's instructions unmarked
  it("counts each agent's files for both", () => {
    // Codex's own home, where it is: the walk finds what is there.
    const codexHome = realpathSync(mkdtempSync(join(tmpdir(), "codex-home-")));
    const steering = agentSteering({ ...places, codexHome });
    for (const path of [
      join(HOME, ".claude", "settings.json"),
      "/data/conversations/c2/CLAUDE.md",
      "/data/conversations/c2/.mcp.json",
      join(codexHome, "config.toml"),
      join(FOLDER, ".codex", "config.toml"),
    ]) {
      expect(steering.steering(path, FOLDER)).toBe("known");
    }
    for (const command of [
      "codex mcp add tides -- node tides.js",
      "claude mcp add tides node tides.js",
      "echo yes >> $CODEX_HOME/AGENTS.md",
      `cp rules ${codexHome}/rules/default.rules`,
    ]) {
      expect(steering.names(command)).toBe(true);
    }
    expect(steering.names("ls -la")).toBe(false);
    const write = actionOf(
      "Write",
      { file_path: join(CODEX_HOME, "AGENTS.md"), content: "" },
      places,
    );
    expect(write?.steers).toBe(true);
    expect(
      steeringAnswer(
        { tool_name: "Bash", tool_input: { command: "codex mcp add x" }, cwd: FOLDER },
        places,
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    rmSync(codexHome, { recursive: true, force: true });
  });
});
