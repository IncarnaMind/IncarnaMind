/**
 * The desktop app's `AgentSkillFiles` (#3430): the Agent Skill's one file, read, written and
 * removed with its folder where Node reaches it. Pure Node, so it is tested without Electron.
 */
import { readFileSync } from "node:fs";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSkillFiles } from "../core/adapters";

export function createAgentSkillFiles(): AgentSkillFiles {
  return {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async write(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },

    async remove(path) {
      await unlink(path);
      // The folder goes too, unless the User keeps something else in it.
      await rmdir(dirname(path)).catch(() => undefined);
    },
  };
}
