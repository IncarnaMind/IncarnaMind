import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSkillFiles } from "../../src/main/agentSkillFiles";
import { createTempDataFolder } from "../helpers/core";

it("reads a file's text, or null where there is none, and writes with the folders above it", async () => {
  const home = await createTempDataFolder();
  const files = createAgentSkillFiles();
  const file = join(home, ".agents", "skills", "incarnamind", "SKILL.md");

  expect(files.read(file)).toBeNull();
  await files.write(file, "A Skill.\n");
  expect(files.read(file)).toBe("A Skill.\n");
  await files.write(file, "A newer Skill.\n");
  expect(await readFile(file, "utf8")).toBe("A newer Skill.\n");
  // What is at the path is no file: that is a failure, not "there is none".
  expect(() => files.read(join(home, ".agents"))).toThrow();
});

it("removes the file and the folder that held it, unless something else is in the folder", async () => {
  const home = await createTempDataFolder();
  const files = createAgentSkillFiles();
  const folder = join(home, ".claude", "skills", "incarnamind");
  const file = join(folder, "SKILL.md");

  await files.write(file, "A Skill.\n");
  await files.remove(file);
  await expect(stat(folder)).rejects.toThrow(/ENOENT/);
  expect(await readdir(join(home, ".claude", "skills"))).toEqual([]);

  await files.write(file, "A Skill.\n");
  await mkdir(join(folder, "references"));
  await writeFile(join(folder, "references", "notes.md"), "The User's own.\n");
  await files.remove(file);
  expect(await readdir(folder)).toEqual(["references"]);
  await expect(files.remove(file)).rejects.toThrow(/ENOENT/);
});
