import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  BUILT_IN_SKILLS_SOURCE,
  type Core,
  type Skill,
  type SkillImportPreview,
} from "../../src/core";
import { BUILT_IN_SKILL_NAMES } from "../../src/core/usageEvents";
import { createTempDataFolder } from "./core";

/** The repository's root. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The built-in Skills the app ships, in the repository. */
export const BUILT_IN_SKILLS_DIR = join(REPO_ROOT, BUILT_IN_SKILLS_SOURCE);

/** The names of the built-in Skills, in name order (the core's list). */
export { BUILT_IN_SKILL_NAMES };

/**
 * A copy of the built-in Skills in a temporary folder, deleted when the test
 * finishes: a test changes it to play a newer version of the app.
 */
export async function copyBuiltInSkills(): Promise<string> {
  const folder = join(await createTempDataFolder(), "skills");
  await cp(BUILT_IN_SKILLS_DIR, folder, { recursive: true });
  return folder;
}

/** SKILL.md text: frontmatter (given as YAML lines), then the instructions. */
export function skillMd(frontmatter: string, body = "Follow these steps."): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body}\n`;
}

/** A Skill's SKILL.md with just a name and a description. */
export const simpleSkillMd = (name: string, description: string, body?: string) =>
  skillMd(`name: ${name}\ndescription: ${description}`, body);

/** Writes files (by path inside the folder, "/" between folders) into a new folder under `parent`. */
export async function writeFolder(
  parent: string,
  folderName: string,
  files: Record<string, string | Buffer>,
): Promise<string> {
  const root = join(parent, folderName);
  await mkdir(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

/** Previews a Skill and expects it to be importable. */
export async function previewOk(core: Core, path: string): Promise<SkillImportPreview> {
  const check = await core.previewSkillImport(path);
  if (!check.ok) throw new Error(`The Skill can't be imported: ${JSON.stringify(check.error)}`);
  return check.preview;
}

/** Previews and imports a Skill. */
export async function importSkill(core: Core, path: string): Promise<Skill> {
  const preview = await previewOk(core, path);
  return core.importSkill(preview.importId);
}

/** Previews a Skill and expects it to be refused; returns why. */
export async function previewRefused(core: Core, path: string) {
  const check = await core.previewSkillImport(path);
  expect(check.ok).toBe(false);
  if (check.ok) throw new Error("The Skill was accepted.");
  return check.error;
}
