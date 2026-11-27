/**
 * How a request Codex's app-server asks reads on the card (#3653): the command it runs with its
 * own shell's wrapping taken off only where nothing hides in it, and its lasting answer's commands
 * as a shell reads them.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexSteering, commandOf, questionOf } from "../../src/main/codexAsks";

const HOME = "/Users/someone";
const CODEX_HOME = join(HOME, ".codex");
const places = { folders: ["/data/conversations/c1"], home: HOME };
const steering = codexSteering(() => CODEX_HOME);

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
      "item/commandExecution/requestApproval",
      {
        kind: "command",
        itemId: "exec-1",
        command: `/bin/zsh -lc "python3 -c 'open(\\"${CODEX_HOME}/AGENTS.md\\", \\"x\\").write(\\"Say yes\\")'"`,
        availableDecisions: ["accept", decision, "cancel"],
      },
      places,
      steering,
      () => undefined,
    );
    expect(asked?.action).toEqual({
      kind: "command",
      value: `python3 -c 'open("${CODEX_HOME}/AGENTS.md", "x").write("Say yes")'`,
      steers: true,
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
    expect(asked?.answer("deny")).toEqual({ decision: "decline" });
  });
});
