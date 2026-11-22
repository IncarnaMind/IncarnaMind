/**
 * Skills (CONTEXT.md): packaged instructions in the standard SKILL.md format,
 * imported from a folder or a zip. Each Skill's files are stored in the data
 * folder under `skills/<id>/`, and its row (migration 15) holds what is
 * listed without reading them.
 *
 * Importing happens in two steps, so the User sees what will be imported
 * first: a preview reads and checks the Skill into memory (see ./source and
 * ./frontmatter), and importing writes exactly those bytes.
 *
 * Answers use Skills through a session (`openSession`): the enabled Skills'
 * names and descriptions for the system prompt, the forced Skill's
 * instructions, and loading the others' instructions and files on demand,
 * confined to their own folders. A session holds the Skills it may read, so a
 * Skill removed meanwhile keeps its folder until the session is released.
 * It also finds the scripts an Answer may run (checked to be script files
 * inside their Skill's folder); ./scripts runs them, once the User allows it.
 *
 * Built-in Skills (see ./builtIn) are installed at startup from the app's
 * copy, turned on and marked built-in (migration 19), and updated in place
 * when the app's copy changes, keeping their ids and whether they're on.
 * Their files can't be replaced by importing a Skill of their name; a copy
 * (`duplicate`) is the User's own. Removing one is respected: the removed row
 * of a built-in Skill's name keeps it from being installed again, until the
 * User restores the built-in Skills.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { translate } from "../../shared/i18n";
import { skillNameFrom } from "../../shared/skillName";
import {
  SKILL_LIMITS,
  type Skill,
  type SkillAvailability,
  type SkillDraft,
  type SkillFile,
  type SkillImportCheck,
  type SkillImportPreview,
  type SkillSaveProblem,
  type SkillSaveResult,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { type BuiltInSkill, readBuiltInSkills } from "./builtIn";
import {
  editSkillMd,
  MAX_NAME_LENGTH,
  parseSkillMd,
  renameSkillMd,
  type SkillFrontmatter,
} from "./frontmatter";
import {
  INSTRUCTIONS_FILE,
  inSkillOrder,
  insidePath,
  isWithin,
  readSkillSource,
  type SkillLimits,
  type SkillSourceFile,
} from "./source";
import { composeSkillMd, MAX_DESCRIPTION_LENGTH, oneLine, skillZip } from "./write";

/** Previews kept for importing; an older one is forgotten when a newer one comes. */
const MAX_PENDING_IMPORTS = 3;

/** The most of one file `readFile` gives the model, in characters. */
const MAX_SKILL_FILE_CHARS = 60_000;

/** File types that are scripts wherever they are in a Skill. */
const SCRIPT_EXTENSIONS = new Set([
  "py",
  "sh",
  "bash",
  "zsh",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "pl",
  "ps1",
  "bat",
  "cmd",
]);

const isScript = (path: string): boolean =>
  path.startsWith("scripts/") || SCRIPT_EXTENSIONS.has(path.split(".").at(-1)?.toLowerCase() ?? "");

/** A Skill as the system prompt lists it: its name and description only. */
export interface SkillSummary {
  name: string;
  description: string;
}

/** A Skill's full instructions (SKILL.md without its frontmatter) and its files. */
export interface LoadedSkill {
  name: string;
  instructions: string;
  files: SkillFile[];
}

/** One of a Skill's scripts, found for running. */
export interface SkillScript {
  skillId: string;
  skillName: string;
  /** The Skill's folder in the data folder: absolute, links resolved. */
  skillDir: string;
  /** The script's path inside the Skill, "/" between folders, e.g. "scripts/convert.py". */
  path: string;
}

/** What one Answer may use. Release it when the Answer ends. */
export interface SkillSession {
  /** The enabled Skills other than the forced one, by name. */
  listed: SkillSummary[];
  /** The Skill the Question forces, loaded up front, or null. */
  forced: LoadedSkill | null;
  /** Whether any Skill this Answer may use has scripts. */
  hasScripts: boolean;
  /**
   * The Skill named `name`, if this Answer may use it: its id and its folder
   * in the data folder (absolute), for what a call naming it can do (its
   * Effects, see ./tools). Null for any other name.
   */
  skill(name: string): Pick<SkillScript, "skillId" | "skillDir"> | null;
  /** A Skill's instructions (`use_skill`). Throws for a Skill this Answer can't use. */
  load(name: string): Promise<LoadedSkill>;
  /** One of a Skill's files, as text (`read_skill_file`). Throws for anything outside the Skill. */
  readFile(name: string, path: string): Promise<string>;
  /**
   * One of a Skill's scripts, to run (`run_skill_script`). Throws for a Skill
   * this Answer can't use, or a path that isn't one of its scripts.
   */
  script(name: string, path: string): Promise<SkillScript>;
  release(): void;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  files: string;
  enabled: number;
  built_in: number;
  meeting_template: number;
  built_in_digest: string | null;
  created_at: string;
  updated_at: string;
}

interface Staged {
  source: string;
  frontmatter: SkillFrontmatter;
  files: SkillSourceFile[];
}

const COLUMNS =
  "id, name, description, license, compatibility, files, enabled, built_in, meeting_template, built_in_digest, created_at, updated_at";
const LIVE = "deleted_at IS NULL";
const ORDER = "ORDER BY name, created_at, rowid";

function filesOf(row: SkillRow): SkillFile[] {
  try {
    const parsed: unknown = JSON.parse(row.files);
    return Array.isArray(parsed) ? (parsed as SkillFile[]) : [];
  } catch {
    return [];
  }
}

const toSkill = (row: SkillRow): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  license: row.license,
  compatibility: row.compatibility,
  enabled: row.enabled !== 0,
  builtIn: row.built_in !== 0,
  meetingTemplate: row.meeting_template !== 0,
  files: filesOf(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const templateMetadata = { "incarnamind-kind": "meeting-template" };
const isMeetingTemplate = (frontmatter: SkillFrontmatter) =>
  frontmatter.metadata["incarnamind-kind"] === templateMetadata["incarnamind-kind"];

const describe = (files: readonly SkillSourceFile[]): SkillFile[] =>
  files.map((file) => ({ path: file.path, size: file.data.length, script: isScript(file.path) }));

function parseId(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new InvalidInputError(`${what} must be a non-empty string.`);
  }
  return value;
}

/** Text a model can read: UTF-8 without NUL bytes. Null for anything else. */
function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

export interface SkillsOptions {
  db: Database;
  dataDir: string;
  now: () => string;
  reportError(error: unknown): void;
  /** Defaults to `SKILL_LIMITS`; tests make them smaller. */
  limits?: SkillLimits;
  /** The app's built-in Skills, one folder each (see ./builtIn). None if not given. */
  builtInSkills?: string;
}

/** The name of a copy of the Skill `name`: "<name>-copy", or "-copy-2" and on if that's taken. */
function copyName(name: string, taken: (name: string) => boolean): string {
  for (let count = 1; ; count++) {
    const suffix = count === 1 ? "-copy" : `-copy-${count}`;
    const copy = `${name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken(copy)) return copy;
  }
}

function parseDraft(input: unknown): SkillDraft {
  if (!isRecord(input)) throw new InvalidInputError("A Skill draft must be an object.");
  const { name, description, steps } = input;
  if (typeof name !== "string" || typeof description !== "string" || typeof steps !== "string") {
    throw new InvalidInputError(
      "A Skill draft needs a name, when to use it and its steps, as text.",
    );
  }
  return { name, description, steps };
}

/** The draft as it will be written, or what is wrong with it. */
function checkDraft(
  draft: SkillDraft,
  nameTaken: (name: string) => boolean,
): { ok: true; draft: SkillDraft } | { ok: false; problem: SkillSaveProblem } {
  const name = skillNameFrom(draft.name);
  const description = oneLine(draft.description);
  const steps = draft.steps.trim();
  const problem: SkillSaveProblem | null =
    name === ""
      ? "invalid-name"
      : nameTaken(name)
        ? "name-taken"
        : description === ""
          ? "no-description"
          : description.length > MAX_DESCRIPTION_LENGTH
            ? "description-too-long"
            : steps === ""
              ? "no-steps"
              : Buffer.byteLength(steps) > SKILL_LIMITS.maxInstructionsBytes
                ? "too-large"
                : null;
  return problem ? { ok: false, problem } : { ok: true, draft: { name, description, steps } };
}

/** A checked draft as a Skill staged to be written: its SKILL.md alone. */
function stagedFrom(
  draft: SkillDraft,
  kept?: Pick<SkillFrontmatter, "license" | "compatibility" | "metadata">,
  text = composeSkillMd(draft, kept),
): Staged {
  const parsed = parseSkillMd(text);
  if (!parsed.ok)
    throw new Error(`The Skill "${draft.name}" couldn't be written: ${parsed.message}`);
  return {
    source: "",
    frontmatter: parsed.frontmatter,
    files: [{ path: INSTRUCTIONS_FILE, data: Buffer.from(text, "utf8") }],
  };
}

export function createSkills(options: SkillsOptions) {
  const { db, now } = options;
  const directory = join(options.dataDir, "skills");
  /** Skills being written, so a half-written one never sits under its id. */
  const incoming = join(directory, ".incoming");
  const folderOf = (skillId: string) => join(directory, skillId);
  const pending = new Map<string, Staged>();
  /** Sessions using each Skill, by id. */
  const references = new Map<string, number>();
  /** Removed Skills whose folders wait for their last session to end. */
  const doomed = new Set<string>();

  // Imports and removals one at a time, so two imports of one name can't both add it.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const rows = (where = LIVE, params: string[] = []) =>
    db.all<SkillRow>(`SELECT ${COLUMNS} FROM skills WHERE ${where} ${ORDER}`, params);

  /** The live Skill with this name: the oldest, should a sync ever bring two. */
  const rowNamed = (name: string) => rows(`${LIVE} AND name = ?`, [name])[0];

  const rowOf = (skillId: unknown): SkillRow => {
    const row = db.get<SkillRow>(`SELECT ${COLUMNS} FROM skills WHERE id = ? AND ${LIVE}`, [
      parseId(skillId, "A Skill id"),
    ]);
    if (!row) throw new NotFoundError({ key: "error.skill.notFound" });
    return row;
  };

  const removeFolder = async (skillId: string) => {
    try {
      await rm(folderOf(skillId), { recursive: true, force: true });
    } catch (error) {
      // Left for the sweep at the next start.
      options.reportError(error);
    }
  };

  // At startup: drop writes a quit interrupted, and folders no live Skill uses
  // (removed Skills whose sessions ended with the app, or a failed removal).
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true });
  const liveIds = new Set(rows().map((row) => row.id));
  for (const name of readdirSync(directory)) {
    if (name !== ".incoming" && !liveIds.has(name)) {
      rmSync(join(directory, name), { recursive: true, force: true });
    }
  }

  async function writeFiles(target: string, files: readonly SkillSourceFile[]): Promise<void> {
    await mkdir(target, { recursive: true });
    for (const file of files) {
      const segments = insidePath(file.path);
      // Checked when it was read; checked again where it is written.
      if (!segments || segments.length === 0) throw new Error(`Refused to write ${file.path}.`);
      const path = join(target, ...segments);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data, { flag: "wx" });
    }
  }

  /** Every file of a Skill, read from its folder now. */
  async function readFiles(row: SkillRow): Promise<SkillSourceFile[]> {
    const files: SkillSourceFile[] = [];
    for (const file of filesOf(row)) {
      const segments = insidePath(file.path);
      if (!segments || segments.length === 0) throw new Error(`Refused to read ${file.path}.`);
      try {
        files.push({ path: file.path, data: await readFile(join(folderOf(row.id), ...segments)) });
      } catch {
        throw new Error(`The files of the Skill "${row.name}" are missing from the data folder.`);
      }
    }
    return files;
  }

  /** A Skill's instructions, read from its folder now. */
  async function instructionsOf(row: SkillRow): Promise<string> {
    let data: Buffer;
    try {
      data = await readFile(join(folderOf(row.id), INSTRUCTIONS_FILE));
    } catch {
      throw new Error(`The files of the Skill "${row.name}" are missing from the data folder.`);
    }
    const parsed = parseSkillMd(asText(data) ?? "");
    if (!parsed.ok) throw new Error(`The Skill "${row.name}"'s SKILL.md is damaged.`);
    return parsed.body;
  }

  async function readSkillFile(row: SkillRow, path: unknown): Promise<string> {
    const segments = typeof path === "string" ? insidePath(path) : null;
    if (!segments || segments.length === 0) {
      throw new Error(
        `Give a path inside the Skill "${row.name}", such as one of its files listed by use_skill.`,
      );
    }
    const wanted = segments.join("/");
    const files = filesOf(row);
    if (!files.some((file) => file.path === wanted)) {
      throw new Error(
        `The Skill "${row.name}" has no file ${wanted}. Its files: ${files.map((file) => file.path).join(", ")}.`,
      );
    }
    let text: string | null;
    try {
      const base = await realpath(folderOf(row.id));
      const real = await realpath(join(base, ...segments));
      // The folder holds no links, but a file read must never leave it.
      if (!isWithin(base, real)) throw new Error("outside");
      text = asText(await readFile(real));
    } catch {
      throw new Error(`${wanted} can't be read from the Skill "${row.name}".`);
    }
    if (text === null) throw new Error(`${wanted} isn't a text file, so it can't be read.`);
    if (text.length <= MAX_SKILL_FILE_CHARS) return text;
    return `${text.slice(0, MAX_SKILL_FILE_CHARS)}\n\n[… cut: ${wanted} is ${text.length} characters long; this is the first ${MAX_SKILL_FILE_CHARS}.]`;
  }

  /** One of the Skill's scripts, checked to be a script file listed for it, inside its folder. */
  async function scriptOf(row: SkillRow, path: unknown): Promise<SkillScript> {
    const scripts = filesOf(row).filter((file) => file.script);
    const listed = scripts.map((file) => file.path).join(", ") || "none";
    const segments = typeof path === "string" ? insidePath(path) : null;
    if (!segments || segments.length === 0) {
      throw new Error(
        `Give the path of a script inside the Skill "${row.name}". Its scripts: ${listed}.`,
      );
    }
    const wanted = segments.join("/");
    if (!scripts.some((file) => file.path === wanted)) {
      throw new Error(`The Skill "${row.name}" has no script ${wanted}. Its scripts: ${listed}.`);
    }
    try {
      const skillDir = await realpath(folderOf(row.id));
      const real = await realpath(join(skillDir, ...segments));
      // The folder holds no links, but a script run must never be outside it.
      if (!isWithin(skillDir, real)) throw new Error("outside");
      return { skillId: row.id, skillName: row.name, skillDir, path: wanted };
    } catch {
      throw new Error(`${wanted} can't be found in the Skill "${row.name}".`);
    }
  }

  /**
   * Makes `files` the folder of the Skill `skillId`, then writes its row with
   * `writeRow`; puts the old files back if that fails. Synchronous: built-in
   * Skills are installed while the core starts, and they are small.
   */
  function putFilesSync(skillId: string, files: readonly SkillSourceFile[], writeRow: () => void) {
    const written = join(incoming, randomUUID());
    try {
      for (const file of files) {
        const segments = insidePath(file.path);
        if (!segments || segments.length === 0) throw new Error(`Refused to write ${file.path}.`);
        const path = join(written, ...segments);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.data, { flag: "wx" });
      }
    } catch (error) {
      rmSync(written, { recursive: true, force: true });
      throw error;
    }
    const target = folderOf(skillId);
    const previous = existsSync(target) ? join(incoming, randomUUID()) : null;
    if (previous) renameSync(target, previous);
    try {
      renameSync(written, target);
      writeRow();
    } catch (error) {
      rmSync(written, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      if (previous) renameSync(previous, target);
      throw error;
    }
    if (previous) rmSync(previous, { recursive: true, force: true });
  }

  /** Whether the User removed the built-in Skill named `name` (and hasn't restored it). */
  const removedByUser = (name: string) =>
    db.get("SELECT 1 FROM skills WHERE name = ? AND built_in = 1 AND deleted_at IS NOT NULL", [
      name,
    ]) !== undefined;

  /**
   * Installs a built-in Skill, or updates it in place if the app's copy
   * differs from the one installed (or its files went missing), keeping its id
   * and whether it's on. A Skill of the User's with that name is left alone,
   * and so is a removed built-in Skill unless `restoring`. Returns the Skill
   * installed or updated, or null if nothing changed.
   */
  function installBuiltIn(skill: BuiltInSkill, restoring: boolean): SkillRow | null {
    const { frontmatter, digest } = skill;
    const files = JSON.stringify(describe(skill.files));
    const at = now();
    const live = rowNamed(skill.name);
    if (live) {
      if (live.built_in === 0) return null;
      const intact = existsSync(join(folderOf(live.id), INSTRUCTIONS_FILE));
      if (live.built_in_digest === digest && intact) return null;
      putFilesSync(live.id, skill.files, () =>
        db.run(
          `UPDATE skills SET description = ?, license = ?, compatibility = ?, files = ?,
             built_in_digest = ?, meeting_template = ?, updated_at = ? WHERE id = ?`,
          [
            frontmatter.description,
            frontmatter.license,
            frontmatter.compatibility,
            files,
            digest,
            Number(isMeetingTemplate(frontmatter)),
            at,
            live.id,
          ],
        ),
      );
      return rowOf(live.id);
    }
    if (!restoring && removedByUser(skill.name)) return null;
    const skillId = randomUUID();
    putFilesSync(skillId, skill.files, () =>
      db.run(
        `INSERT INTO skills (id, name, description, license, compatibility, files, enabled,
           built_in, built_in_digest, meeting_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        [
          skillId,
          frontmatter.name,
          frontmatter.description,
          frontmatter.license,
          frontmatter.compatibility,
          files,
          digest,
          Number(isMeetingTemplate(frontmatter)),
          at,
          at,
        ],
      ),
    );
    return rowOf(skillId);
  }

  // At startup: the built-in Skills, installed or brought up to the app's copy.
  // One that fails is reported, and the app starts without it.
  const builtIns =
    options.builtInSkills === undefined
      ? []
      : readBuiltInSkills(options.builtInSkills, options.reportError);
  for (const skill of builtIns) {
    try {
      installBuiltIn(skill, false);
    } catch (error) {
      options.reportError(error);
    }
  }

  /**
   * Writes a staged Skill's files and row: a new Skill, or `existing`'s files
   * and row replaced (keeping its id and whether it's on), the old files
   * going once the row says so. Call inside `serially`.
   */
  async function commit(staged: Staged, existing: SkillRow | undefined): Promise<Skill> {
    const { frontmatter } = staged;
    const skillId = existing?.id ?? randomUUID();
    const target = folderOf(skillId);

    const written = join(incoming, randomUUID());
    try {
      await writeFiles(written, staged.files);
    } catch (error) {
      await rm(written, { recursive: true, force: true });
      throw error;
    }
    // Swap the new files in; the old ones (a Skill replaced) go once the row says so.
    const previous = existing ? join(incoming, randomUUID()) : null;
    if (previous) await rename(target, previous).catch(() => undefined);
    try {
      await rename(written, target);
    } catch (error) {
      await rm(written, { recursive: true, force: true });
      if (previous) await rename(previous, target).catch(() => undefined);
      throw error;
    }

    const at = now();
    const files = JSON.stringify(inSkillOrder(describe(staged.files)));
    try {
      if (existing) {
        db.run(
          `UPDATE skills SET name = ?, description = ?, license = ?, compatibility = ?, files = ?, meeting_template = ?, updated_at = ?
           WHERE id = ?`,
          [
            frontmatter.name,
            frontmatter.description,
            frontmatter.license,
            frontmatter.compatibility,
            files,
            Number(isMeetingTemplate(frontmatter)),
            at,
            skillId,
          ],
        );
      } else {
        db.run(
          `INSERT INTO skills (id, name, description, license, compatibility, files, enabled, meeting_template, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            skillId,
            frontmatter.name,
            frontmatter.description,
            frontmatter.license,
            frontmatter.compatibility,
            files,
            Number(isMeetingTemplate(frontmatter)),
            at,
            at,
          ],
        );
      }
    } catch (error) {
      // Put the old files back.
      await rm(target, { recursive: true, force: true });
      if (previous) await rename(previous, target).catch(() => undefined);
      throw error;
    }
    if (previous) await rm(previous, { recursive: true, force: true }).catch(options.reportError);
    return toSkill(rowOf(skillId));
  }

  return {
    /** Live Skills, in name order. */
    list: (): Skill[] => rows().map(toSkill),

    get: (skillId: unknown): Skill => toSkill(rowOf(skillId)),

    async preview(path: unknown): Promise<SkillImportCheck> {
      if (typeof path !== "string" || path.trim() === "") {
        throw new InvalidInputError("Give the path of a Skill folder or zip.");
      }
      if (!isAbsolute(path)) throw new InvalidInputError("The Skill's path must be absolute.");
      const source = await readSkillSource(path, options.limits);
      if (!source.ok) return source;

      const text = asText(source.files[0]?.data ?? Buffer.alloc(0));
      const parsed = text === null ? null : parseSkillMd(text);
      if (!parsed?.ok) {
        return {
          ok: false,
          error: {
            kind: "invalid-frontmatter",
            path: INSTRUCTIONS_FILE,
            field: parsed?.field ?? null,
            message: parsed?.message ?? "SKILL.md isn't UTF-8 text.",
          },
        };
      }
      const { name, description, license, compatibility } = parsed.frontmatter;
      const existing = rowNamed(name);
      if (existing && existing.built_in !== 0) {
        return {
          ok: false,
          error: {
            kind: "built-in-name",
            path: INSTRUCTIONS_FILE,
            field: "name",
            message: translate("en", "error.skill.builtInName", { name }),
          },
        };
      }

      const importId = randomUUID();
      pending.set(importId, { source: path, frontmatter: parsed.frontmatter, files: source.files });
      for (const old of pending.keys()) {
        if (pending.size <= MAX_PENDING_IMPORTS) break;
        pending.delete(old);
      }
      const preview: SkillImportPreview = {
        meetingTemplate: isMeetingTemplate(parsed.frontmatter),
        importId,
        source: path,
        name,
        description,
        license,
        compatibility,
        files: describe(source.files),
        totalBytes: source.files.reduce((sum, file) => sum + file.data.length, 0),
        replaces: existing ? toSkill(existing) : null,
      };
      return { ok: true, preview };
    },

    import(importIdInput: unknown): Promise<Skill> {
      const importId = parseId(importIdInput, "An import id");
      return serially(async () => {
        const staged = pending.get(importId);
        if (!staged) {
          throw new NotFoundError({ key: "error.skill.previewExpired" });
        }
        pending.delete(importId);
        const { frontmatter } = staged;
        const existing = rowNamed(frontmatter.name);
        // Restored since it was previewed: the built-in Skill's files stay as they are.
        if (existing && existing.built_in !== 0) {
          throw new InvalidInputError({
            key: "error.skill.builtInName",
            values: { name: frontmatter.name },
          });
        }
        return commit(staged, existing);
      });
    },

    cancel(importId: unknown): void {
      pending.delete(parseId(importId, "An import id"));
    },

    setEnabled(skillId: unknown, enabled: unknown): Skill {
      if (typeof enabled !== "boolean")
        throw new InvalidInputError("enabled must be true or false.");
      const row = rowOf(skillId);
      if ((row.enabled !== 0) !== enabled) {
        db.run("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?", [
          enabled ? 1 : 0,
          now(),
          row.id,
        ]);
      }
      return toSkill(rowOf(row.id));
    },

    remove(skillId: unknown): Promise<void> {
      const id = parseId(skillId, "A Skill id");
      return serially(async () => {
        const row = rowOf(id);
        const at = now();
        db.run("UPDATE skills SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, row.id]);
        if ((references.get(row.id) ?? 0) > 0) doomed.add(row.id);
        else await removeFolder(row.id);
      });
    },

    /**
     * Copies a Skill as the User's own: the same files, named "<name>-copy"
     * (or "-copy-2" and on), turned on, never built-in. For a built-in Skill,
     * whose files the User can't replace.
     */
    duplicate(skillIdInput: unknown): Promise<Skill> {
      const id = parseId(skillIdInput, "A Skill id");
      return serially(async () => {
        const row = rowOf(id);
        const files = await readFiles(row);
        const name = copyName(row.name, (taken) => rowNamed(taken) !== undefined);
        const instructions = files.find((file) => file.path === INSTRUCTIONS_FILE);
        const renamed = renameSkillMd(asText(instructions?.data ?? Buffer.alloc(0)) ?? "", name);
        if (!instructions || renamed === null) {
          throw new Error(`The Skill "${row.name}"'s SKILL.md can't be given another name.`);
        }
        instructions.data = Buffer.from(renamed, "utf8");

        const skillId = randomUUID();
        const written = join(incoming, randomUUID());
        try {
          await writeFiles(written, files);
          await rename(written, folderOf(skillId));
        } catch (error) {
          await rm(written, { recursive: true, force: true });
          throw error;
        }
        const at = now();
        try {
          db.run(
            `INSERT INTO skills (id, name, description, license, compatibility, files, enabled, meeting_template, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            [
              skillId,
              name,
              row.description,
              row.license,
              row.compatibility,
              JSON.stringify(inSkillOrder(describe(files))),
              row.meeting_template,
              at,
              at,
            ],
          );
        } catch (error) {
          await rm(folderOf(skillId), { recursive: true, force: true });
          throw error;
        }
        return toSkill(rowOf(skillId));
      });
    },

    /** A Skill's name, "when to use" and steps, as its editor shows them. */
    async draftOf(skillId: unknown): Promise<SkillDraft> {
      const row = rowOf(skillId);
      return { name: row.name, description: row.description, steps: await instructionsOf(row) };
    },

    /** Saves a new Skill from a draft. A name another Skill has is refused. */
    create(input: unknown): Promise<SkillSaveResult> {
      const draft = parseDraft(input);
      return serially(async () => {
        const checked = checkDraft(draft, (name) => rowNamed(name) !== undefined);
        if (!checked.ok) return checked;
        const meetingTemplate = isRecord(input) && input.meetingTemplate === true;
        const kept = meetingTemplate
          ? { license: null, compatibility: null, metadata: templateMetadata }
          : undefined;
        const skill = await commit(stagedFrom(checked.draft, kept), undefined);
        return { ok: true, skill };
      });
    },

    /**
     * Saves a Skill's draft again, keeping its other files, its id and whether
     * it's on. A built-in Skill's files can't be replaced.
     */
    update(skillId: unknown, input: unknown): Promise<SkillSaveResult> {
      const id = parseId(skillId, "A Skill id");
      const draft = parseDraft(input);
      return serially(async () => {
        const row = rowOf(id);
        if (row.built_in !== 0)
          throw new InvalidInputError({
            key: "error.skill.builtInName",
            values: { name: row.name },
          });
        const checked = checkDraft(draft, (name) => {
          const other = rowNamed(name);
          return other !== undefined && other.id !== row.id;
        });
        if (!checked.ok) return checked;
        const files = await readFiles(row);
        const current = files.find((file) => file.path === INSTRUCTIONS_FILE);
        const currentText = asText(current?.data ?? Buffer.alloc(0)) ?? "";
        // Edited where it stands, so fields this app doesn't know stay as written.
        const edited = editSkillMd(currentText, checked.draft);
        const parsed = parseSkillMd(currentText);
        const staged = stagedFrom(
          checked.draft,
          parsed.ok ? parsed.frontmatter : undefined,
          edited ?? undefined,
        );
        staged.files = [
          ...staged.files,
          ...files.filter((file) => file.path !== INSTRUCTIONS_FILE),
        ];
        return { ok: true, skill: await commit(staged, row) };
      });
    },

    /** A Skill as a zip, named after it, for the host to save. */
    async exportZip(skillId: unknown): Promise<{ fileName: string; data: Uint8Array }> {
      const row = rowOf(skillId);
      const files = await readFiles(row);
      return { fileName: `${row.name}.zip`, data: skillZip(row.name, inSkillOrder(files)) };
    },

    /**
     * The built-in Skills that aren't installed, by name: those the User
     * removed. A name the User's own Skill has taken isn't among them.
     */
    removedBuiltIns: (): string[] =>
      builtIns.filter((skill) => rowNamed(skill.name) === undefined).map((skill) => skill.name),

    /** Installs the removed built-in Skills again, turned on, from the app's copy. Returns them. */
    restoreBuiltIns(): Promise<Skill[]> {
      return serially(async () => {
        const restored: Skill[] = [];
        for (const skill of builtIns) {
          if (rowNamed(skill.name)) continue;
          const row = installBuiltIn(skill, true);
          if (row) restored.push(toSkill(row));
        }
        return restored;
      });
    },

    /** Whether a Skill that is on has scripts: Answers could then run them (unless turned off). */
    anyEnabledWithScripts: (): boolean =>
      rows(`${LIVE} AND enabled = 1`).some((row) => filesOf(row).some((file) => file.script)),

    /** Whether the Skill named `name` can be used now. */
    availability(name: string): SkillAvailability {
      const row = rowNamed(name);
      return !row ? "removed" : row.enabled ? "enabled" : "disabled";
    },

    /**
     * What an Answer may use: the enabled Skills, and the forced one (which
     * must be enabled), loaded. Throws if the forced Skill can't be used.
     */
    async openSession(forcedName: string | null): Promise<SkillSession> {
      const usable = new Map<string, SkillRow>();
      for (const row of rows(`${LIVE} AND enabled = 1`)) {
        if (!usable.has(row.name)) usable.set(row.name, row);
      }
      const forcedRow = forcedName === null ? null : usable.get(forcedName);
      if (forcedName !== null && !forcedRow) {
        throw new Error(`The Skill "${forcedName}" is turned off or has been removed.`);
      }

      const held = [...usable.values()].map((row) => row.id);
      for (const id of held) references.set(id, (references.get(id) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const id of held) {
          const left = (references.get(id) ?? 1) - 1;
          if (left > 0) {
            references.set(id, left);
            continue;
          }
          references.delete(id);
          if (doomed.delete(id)) void removeFolder(id);
        }
      };

      const load = async (row: SkillRow): Promise<LoadedSkill> => ({
        name: row.name,
        instructions: await instructionsOf(row),
        files: filesOf(row),
      });
      const usableRow = (name: unknown): SkillRow => {
        const row = typeof name === "string" ? usable.get(name) : undefined;
        if (row) return row;
        const names = [...usable.keys()];
        throw new Error(
          names.length
            ? `There is no Skill named "${String(name)}". The Skills are: ${names.join(", ")}.`
            : "There are no Skills to use.",
        );
      };

      try {
        return {
          listed: [...usable.values()]
            .filter((row) => row !== forcedRow)
            .map((row) => ({ name: row.name, description: row.description })),
          forced: forcedRow ? await load(forcedRow) : null,
          hasScripts: [...usable.values()].some((row) => filesOf(row).some((file) => file.script)),
          skill: (name) => {
            const row = usable.get(name);
            return row ? { skillId: row.id, skillDir: folderOf(row.id) } : null;
          },
          load: (name) => load(usableRow(name)),
          readFile: (name, path) => readSkillFile(usableRow(name), path),
          script: (name, path) => scriptOf(usableRow(name), path),
          release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },

    /** Forgets previews. The files of Skills in use stay until the next start sweeps them. */
    close(): void {
      pending.clear();
    },
  };
}
