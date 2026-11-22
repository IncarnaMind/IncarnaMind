/**
 * The command an AI app is given to start IncarnaMind's agent connection (#3643): from an AppImage,
 * whose program lives in a folder of that start only, a script in the data folder that names this
 * start's program; elsewhere the program itself.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_LAUNCHER_SCRIPT, agentLauncher } from "../../src/main/agentLauncher";

const made: string[] = [];
afterEach(async () => {
  for (const folder of made.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** A folder as an AppImage mounts one, with a stand-in program that says how it was started. */
async function mount(name: string): Promise<{ program: string; shim: string }> {
  const folder = await mkdtemp(join(tmpdir(), `${name} 'mount' `));
  made.push(folder);
  const program = join(folder, "incarnamind");
  await writeFile(
    program,
    '#!/bin/sh\necho "node mode: $ELECTRON_RUN_AS_NODE"\nfor arg in "$@"; do echo "arg: $arg"; done\n',
  );
  await chmod(program, 0o755);
  const shim = join(folder, "resources", "app.asar", "out", "main", "agentShim.js");
  return { program, shim };
}

async function dataFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "launcher-data-"));
  made.push(folder);
  return folder;
}

const run = (command: string) => spawnSync(command, [], { encoding: "utf8" });

describe.skipIf(process.platform === "win32")("the agent connection's command", () => {
  // protects=a .deb, macOS or Windows install keeps its program where it is: the command is the program itself, as plain Node, running the shim (#351); fails_when=a script is written where no AppImage runs
  it("is the program itself, running the shim as plain Node, where IncarnaMind isn't an AppImage", async () => {
    const data = await dataFolder();
    expect(
      agentLauncher({
        execPath: "/opt/IncarnaMind/incarnamind",
        shim: "/opt/IncarnaMind/resources/app.asar/out/main/agentShim.js",
        appImage: undefined,
        dataFolder: data,
      }),
    ).toEqual({
      command: "/opt/IncarnaMind/incarnamind",
      args: ["/opt/IncarnaMind/resources/app.asar/out/main/agentShim.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    await expect(stat(join(data, AGENT_LAUNCHER_SCRIPT))).rejects.toThrow();
  });

  // protects=from an AppImage the command an AI app keeps is a path that stays, which starts this start's program as plain Node with its shim, and after the next start that start's (#3643); fails_when=the command names the mount of one start, so a connection stops working once IncarnaMind starts again
  it("from an AppImage is a script that stays, starting the program of whichever start wrote it last", async () => {
    const data = await dataFolder();
    const first = await mount("first");
    const launcher = agentLauncher({
      execPath: first.program,
      shim: first.shim,
      appImage: "/home/user/Apps/IncarnaMind.AppImage",
      dataFolder: data,
    });
    expect(launcher).toEqual({ command: join(data, AGENT_LAUNCHER_SCRIPT), args: [], env: {} });
    expect(run(launcher.command).stdout).toBe(`node mode: 1\narg: ${first.shim}\n`);

    const second = await mount("second");
    const again = agentLauncher({
      execPath: second.program,
      shim: second.shim,
      appImage: "/home/user/Apps/IncarnaMind.AppImage",
      dataFolder: data,
    });
    expect(again.command).toBe(launcher.command);
    expect(run(launcher.command).stdout).toBe(`node mode: 1\narg: ${second.shim}\n`);
  });

  // protects=the script is its owner's alone and carries no token: the token stays in the AI app's own settings, as before (#3643); fails_when=anyone else may write or run it, or it holds the pairing's token
  it("is its owner's alone to read, write and run, and holds no token", async () => {
    const data = await dataFolder();
    const { program, shim } = await mount("owner");
    const { command } = agentLauncher({
      execPath: program,
      shim,
      appImage: "/tmp/IncarnaMind.AppImage",
      dataFolder: data,
    });
    expect((await stat(command)).mode & 0o777).toBe(0o700);
    expect(await readFile(command, "utf8")).not.toContain("TOKEN");
  });

  // protects=with IncarnaMind closed its last start's program is gone, and the script says so in plain words rather than failing with a missing file (#3643); fails_when=it runs nothing and says nothing, or an error names only a path
  it("says IncarnaMind isn't open once the start that wrote it has ended", async () => {
    const data = await dataFolder();
    const folder = await mkdtemp(join(tmpdir(), "gone-"));
    made.push(folder);
    await mkdir(join(folder, "kept"));
    const { command } = agentLauncher({
      execPath: join(folder, "incarnamind"),
      shim: join(folder, "agentShim.js"),
      appImage: "/tmp/IncarnaMind.AppImage",
      dataFolder: data,
    });
    const ended = run(command);
    expect(ended.status).toBe(1);
    expect(ended.stdout).toBe("");
    expect(ended.stderr).toContain("IncarnaMind isn't open.");
  });
});
