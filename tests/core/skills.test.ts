import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  type CoreEvents,
  NotFoundError,
  SKILL_LIMITS,
  type Skill,
} from "../../src/core";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextEvent, queryDatabase, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, answerText, question, writeMind } from "../helpers/minds";
import {
  controlledModel,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import {
  importSkill,
  previewOk,
  previewRefused,
  simpleSkillMd,
  skillMd,
  writeFolder,
} from "../helpers/skills";
import { buildZip } from "../helpers/zip";

const BODY_MARKER = "TIDE-SKILL-BODY-7f3a";

/** A Skill about tide tables: instructions, a reference and a script. */
const TIDES_SKILL = {
  "SKILL.md": skillMd(
    [
      "name: tide-tables",
      "description: Reads tide tables and explains high and low water. Use for questions about tides.",
      "license: Apache-2.0",
      "compatibility: Works anywhere",
      "metadata:",
      "  author: harbour-office",
      '  version: "1.0"',
    ].join("\n"),
    `# Tide tables\n\n${BODY_MARKER}: read references/ports.md for the ports.`,
  ),
  "references/ports.md": "Brest, Plymouth and Saint-Malo.",
  "scripts/convert.py": "print('metres to feet')\n",
};

/** A core without a chat model, for importing and managing Skills. */
async function setUpCore() {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir);
  return { dataDir, sources, core };
}

/** What a Skill's folder in the data folder holds, by path. */
async function storedFiles(dataDir: string, skillId: string): Promise<string[]> {
  const root = join(dataDir, "skills", skillId);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort();
}

describe("Importing a Skill", () => {
  test("from a folder: the preview shows what will be imported, and importing adds it, turned on", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const folder = await writeFolder(sources, "tide-tables", TIDES_SKILL);

    const preview = await previewOk(core, folder);
    expect(preview).toEqual({
      importId: expect.any(String),
      source: folder,
      name: "tide-tables",
      description:
        "Reads tide tables and explains high and low water. Use for questions about tides.",
      license: "Apache-2.0",
      compatibility: "Works anywhere",
      files: [
        { path: "SKILL.md", size: Buffer.byteLength(TIDES_SKILL["SKILL.md"]), script: false },
        { path: "references/ports.md", size: 31, script: false },
        { path: "scripts/convert.py", size: 24, script: true },
      ],
      totalBytes: Buffer.byteLength(TIDES_SKILL["SKILL.md"]) + 31 + 24,
      replaces: null,
    });
    // Nothing is imported by a preview.
    expect(await core.listSkills()).toEqual([]);

    const changed = nextEvent(core, "skills.changed");
    const skill = await core.importSkill(preview.importId);
    expect(skill).toMatchObject({
      id: expect.any(String),
      name: "tide-tables",
      license: "Apache-2.0",
      enabled: true,
      files: preview.files,
    });
    expect(await changed).toEqual([skill]);
    expect(await core.listSkills()).toEqual([skill]);
    // The files are in the data folder, under the Skill's id.
    expect(await storedFiles(dataDir, skill.id)).toEqual([
      "SKILL.md",
      "references/ports.md",
      "scripts/convert.py",
    ]);
    expect(
      await readFile(join(dataDir, "skills", skill.id, "references", "ports.md"), "utf8"),
    ).toBe(TIDES_SKILL["references/ports.md"]);
    // A preview is used once.
    await expect(core.importSkill(preview.importId)).rejects.toThrow(NotFoundError);
  });

  test("from a zip, with the Skill in a top-level folder; what operating systems leave behind is left out", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const zip = join(sources, "tide-tables.zip");
    await writeFile(
      zip,
      buildZip([
        { name: "tide-tables/", folder: true },
        { name: "tide-tables/SKILL.md", data: TIDES_SKILL["SKILL.md"] },
        {
          name: "tide-tables/references/ports.md",
          data: TIDES_SKILL["references/ports.md"],
          store: true,
        },
        { name: "tide-tables/scripts/convert.py", data: TIDES_SKILL["scripts/convert.py"] },
        { name: "tide-tables/.DS_Store", data: "junk" },
        { name: "__MACOSX/tide-tables/._SKILL.md", data: "junk" },
      ]),
    );

    const preview = await previewOk(core, zip);
    expect(preview.name).toBe("tide-tables");
    expect(preview.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/ports.md",
      "scripts/convert.py",
    ]);
    const skill = await core.importSkill(preview.importId);
    expect(await storedFiles(dataDir, skill.id)).toEqual([
      "SKILL.md",
      "references/ports.md",
      "scripts/convert.py",
    ]);
  });

  test("frontmatter written the ways YAML allows is read: quotes, block text, comments", async () => {
    const { sources, core } = await setUpCore();
    const folder = await writeFolder(sources, "quoted", {
      "SKILL.md": skillMd(
        [
          "# A comment",
          'name: "quoted-skill"',
          "description: >",
          "  Folded over",
          "  two lines: with a colon.",
          "license: 'MIT, it''s short'",
          "compatibility: |",
          "  Needs nothing.",
          "allowed-tools: Read Bash(git:*)",
          "unknown-field:",
          "  - kept out",
        ].join("\n"),
      ),
    });

    const preview = await previewOk(core, folder);
    expect(preview).toMatchObject({
      name: "quoted-skill",
      description: "Folded over two lines: with a colon.",
      license: "MIT, it's short",
      compatibility: "Needs nothing.",
    });
  });

  test.each([
    ["no frontmatter", "# Just Markdown\n", null],
    ["frontmatter that isn't closed", "---\nname: x\ndescription: y\n", null],
    ["no name", skillMd("description: Does things."), "name"],
    ["a name with capitals", skillMd("name: Tide-Tables\ndescription: Does things."), "name"],
    ["a name with two hyphens in a row", skillMd("name: tide--tables\ndescription: x"), "name"],
    ["a name ending with a hyphen", skillMd("name: tides-\ndescription: x"), "name"],
    ["a name over 64 characters", skillMd(`name: ${"a".repeat(65)}\ndescription: x`), "name"],
    ["no description", skillMd("name: tides"), "description"],
    ["an empty description", skillMd('name: tides\ndescription: ""'), "description"],
    [
      "a description over 1024 characters",
      skillMd(`name: tides\ndescription: ${"x".repeat(1025)}`),
      "description",
    ],
    [
      "compatibility over 500 characters",
      skillMd(`name: tides\ndescription: x\ncompatibility: ${"y".repeat(501)}`),
      "compatibility",
    ],
    [
      "metadata that isn't a mapping",
      skillMd("name: tides\ndescription: x\nmetadata: plain"),
      "metadata",
    ],
    ["a key given twice", skillMd("name: tides\nname: again\ndescription: x"), null],
    ["a line that isn't YAML", skillMd("name: tides\ndescription: x\nnot a key"), null],
  ])("SKILL.md with %s is refused", async (_case, text, field) => {
    const { sources, core } = await setUpCore();
    const folder = await writeFolder(sources, "bad", { "SKILL.md": text });

    const error = await previewRefused(core, folder);
    expect(error).toMatchObject({ kind: "invalid-frontmatter", path: "SKILL.md", field });
    expect(error.message).not.toBe("");
  });

  test("a folder or zip without SKILL.md isn't a Skill; neither is a file that isn't a zip", async () => {
    const { sources, core } = await setUpCore();
    const folder = await writeFolder(sources, "notes", { "README.md": "Not a Skill." });
    const zip = join(sources, "two.zip");
    await writeFile(
      zip,
      buildZip([
        { name: "one/SKILL.md", data: simpleSkillMd("one", "First.") },
        { name: "two/SKILL.md", data: simpleSkillMd("two", "Second.") },
      ]),
    );
    const text = join(sources, "notes.txt");
    await writeFile(text, "Just text.");

    expect(await previewRefused(core, folder)).toMatchObject({ kind: "not-a-skill" });
    expect(await previewRefused(core, zip)).toMatchObject({ kind: "not-a-skill" });
    expect(await previewRefused(core, text)).toMatchObject({ kind: "invalid-zip" });
    expect(await previewRefused(core, join(sources, "missing"))).toMatchObject({
      kind: "unreadable",
    });
    await expect(core.previewSkillImport("relative/path")).rejects.toThrow(/absolute/);
  });

  test.each([
    ["climbs out with ../", "../escaped.txt"],
    ["climbs out from a folder", "tides/../../escaped.txt"],
    ["is absolute", "/tmp/escaped.txt"],
    ["names a drive", "C:\\escaped.txt"],
    ["climbs out with backslashes", "..\\escaped.txt"],
  ])(
    "a zip with an entry whose path %s is refused, and nothing is written",
    async (_case, name) => {
      const { dataDir, sources, core } = await setUpCore();
      const zip = join(sources, "evil.zip");
      await writeFile(
        zip,
        buildZip([
          { name: "SKILL.md", data: simpleSkillMd("evil", "Looks harmless.") },
          { name, data: "escaped" },
        ]),
      );

      expect(await previewRefused(core, zip)).toEqual({
        kind: "path-traversal",
        path: name,
        field: null,
        message: expect.any(String),
      });
      expect(existsSync(join(dataDir, "escaped.txt"))).toBe(false);
      expect(existsSync(join(sources, "escaped.txt"))).toBe(false);
      expect(await readdir(join(dataDir, "skills"))).toEqual([".incoming"]);
    },
  );

  test("a link to a file outside the Skill is refused; a link inside becomes a copy", async () => {
    const { dataDir, sources, core } = await setUpCore();
    await writeFile(join(sources, "secret.txt"), "Not for the Skill.");
    const outside = await writeFolder(sources, "outside", {
      "SKILL.md": simpleSkillMd("outside", "Links out."),
    });
    await symlink(join(sources, "secret.txt"), join(outside, "secret.txt"));
    const parent = await writeFolder(sources, "parent", {
      "SKILL.md": simpleSkillMd("parent", "Links to its parent folder."),
    });
    await symlink("..", join(parent, "up"));

    expect(await previewRefused(core, outside)).toMatchObject({
      kind: "link-outside",
      path: "secret.txt",
    });
    expect(await previewRefused(core, parent)).toMatchObject({ kind: "link-outside", path: "up" });

    const inside = await writeFolder(sources, "inside", {
      "SKILL.md": simpleSkillMd("inside", "Links within itself."),
      "references/ports.md": "Brest.",
    });
    await symlink(join("references", "ports.md"), join(inside, "ports.md"));
    const skill = await importSkill(core, inside);
    expect(skill.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "ports.md",
      "references/ports.md",
    ]);
    const copy = join(dataDir, "skills", skill.id, "ports.md");
    expect((await lstat(copy)).isSymbolicLink()).toBe(false);
    expect(await readFile(copy, "utf8")).toBe("Brest.");
  });

  test("in a zip too: a link outside is refused, a link inside becomes a copy", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const outside = join(sources, "outside.zip");
    await writeFile(
      outside,
      buildZip([
        { name: "SKILL.md", data: simpleSkillMd("outside", "Links out.") },
        { name: "references/passwd", link: "../../etc/passwd" },
      ]),
    );
    const inside = join(sources, "inside.zip");
    await writeFile(
      inside,
      buildZip([
        { name: "SKILL.md", data: simpleSkillMd("inside", "Links within itself.") },
        { name: "references/ports.md", data: "Brest." },
        { name: "ports.md", link: "references/ports.md" },
      ]),
    );

    expect(await previewRefused(core, outside)).toMatchObject({
      kind: "link-outside",
      path: "references/passwd",
    });
    const skill = await importSkill(core, inside);
    const copy = join(dataDir, "skills", skill.id, "ports.md");
    expect((await lstat(copy)).isSymbolicLink()).toBe(false);
    expect(await readFile(copy, "utf8")).toBe("Brest.");
  });

  // It writes and deflates tens of megabytes on purpose, so a busy machine needs longer than the default 5 s.
  test("a Skill over the size limits is refused, before a zip is inflated", {
    timeout: 30_000,
  }, async () => {
    const { sources, core } = await setUpCore();
    const big = await writeFolder(sources, "big", {
      "SKILL.md": simpleSkillMd("big", "Too big."),
      "assets/data.bin": Buffer.alloc(SKILL_LIMITS.maxBytes + 1),
    });
    // Twenty-odd megabytes of zeros deflate to a few kilobytes.
    const bomb = join(sources, "bomb.zip");
    await writeFile(
      bomb,
      buildZip([
        { name: "SKILL.md", data: simpleSkillMd("bomb", "Small zip, huge files.") },
        { name: "assets/zeros.bin", data: Buffer.alloc(SKILL_LIMITS.maxBytes + 1) },
      ]),
    );
    // An entry that says it's small but inflates further.
    const liar = join(sources, "liar.zip");
    await writeFile(
      liar,
      buildZip([
        { name: "SKILL.md", data: simpleSkillMd("liar", "Lies about a size.") },
        { name: "assets/zeros.bin", data: Buffer.alloc(100_000), declaredSize: 10 },
      ]),
    );
    const manyFiles: Record<string, string> = { "SKILL.md": simpleSkillMd("many", "Many files.") };
    for (let index = 0; index < SKILL_LIMITS.maxFiles; index++) {
      manyFiles[`assets/${index}.txt`] = "x";
    }
    const many = await writeFolder(sources, "many", manyFiles);
    const long = await writeFolder(sources, "long", {
      "SKILL.md": simpleSkillMd(
        "long",
        "Long instructions.",
        "x".repeat(SKILL_LIMITS.maxInstructionsBytes),
      ),
    });

    expect(await previewRefused(core, big)).toMatchObject({ kind: "too-large" });
    expect(await previewRefused(core, bomb)).toMatchObject({ kind: "too-large" });
    expect(await previewRefused(core, liar)).toMatchObject({ kind: "invalid-zip" });
    expect(await previewRefused(core, many)).toMatchObject({ kind: "too-many-files" });
    expect(await previewRefused(core, long)).toMatchObject({ kind: "too-large", path: "SKILL.md" });
  });

  test("a Skill of the same name replaces the one there, keeping its id and whether it's on", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const first = await importSkill(core, await writeFolder(sources, "v1", TIDES_SKILL));
    await core.setSkillEnabled(first.id, false);

    const v2 = await writeFolder(sources, "v2", {
      "SKILL.md": simpleSkillMd("tide-tables", "Version two."),
      "references/tables.md": "New tables.",
    });
    const preview = await previewOk(core, v2);
    expect(preview.replaces).toMatchObject({ id: first.id, description: first.description });
    const second = await core.importSkill(preview.importId);

    expect(second).toMatchObject({ id: first.id, description: "Version two.", enabled: false });
    expect(await core.listSkills()).toEqual([second]);
    expect(await storedFiles(dataDir, first.id)).toEqual(["SKILL.md", "references/tables.md"]);
  });

  test("a cancelled preview can't be imported", async () => {
    const { sources, core } = await setUpCore();
    const preview = await previewOk(core, await writeFolder(sources, "tides", TIDES_SKILL));

    await core.cancelSkillImport(preview.importId);

    await expect(core.importSkill(preview.importId)).rejects.toThrow(/expired/);
    expect(await core.listSkills()).toEqual([]);
  });
});

describe("Managing Skills", () => {
  test("Skills are listed by name, turned off and on, and removed: a soft delete, then the folder goes", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const tides = await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const almanac = await importSkill(
      core,
      await writeFolder(sources, "almanac", { "SKILL.md": simpleSkillMd("almanac", "Dates.") }),
    );
    expect((await core.listSkills()).map((skill) => skill.name)).toEqual([
      "almanac",
      "tide-tables",
    ]);

    const off = nextEvent(core, "skills.changed");
    const disabled = await core.setSkillEnabled(tides.id, false);
    expect(disabled.enabled).toBe(false);
    expect((await off).find((skill) => skill.id === tides.id)?.enabled).toBe(false);
    expect((await core.setSkillEnabled(tides.id, true)).enabled).toBe(true);

    const removed = nextEvent(core, "skills.changed");
    await core.removeSkill(almanac.id);
    expect((await removed).map((skill) => skill.name)).toEqual(["tide-tables"]);
    expect((await core.listSkills()).map((skill) => skill.name)).toEqual(["tide-tables"]);
    expect(
      queryDatabase<{ deleted_at: string | null }>(
        dataDir,
        "SELECT deleted_at FROM skills WHERE id = ?",
        [almanac.id],
      ),
    ).toEqual([{ deleted_at: expect.any(String) }]);
    expect(existsSync(join(dataDir, "skills", almanac.id))).toBe(false);
    expect(existsSync(join(dataDir, "skills", tides.id))).toBe(true);

    await expect(core.removeSkill(almanac.id)).rejects.toThrow(NotFoundError);
    await expect(core.setSkillEnabled(almanac.id, true)).rejects.toThrow(NotFoundError);
    await expect(core.setSkillEnabled(tides.id, "yes" as unknown as boolean)).rejects.toThrow(
      /true or false/,
    );
  });

  test("Skills follow the sync-ready rules: UUIDs, timestamps, and removal marks the row", async () => {
    const { dataDir, sources, core } = await setUpCore();
    const skill = await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    await core.removeSkill(skill.id);

    const rows = queryDatabase<Record<string, unknown>>(dataDir, "SELECT * FROM skills");
    expect(rows).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        name: "tide-tables",
        created_at: expect.any(String),
        updated_at: expect.any(String),
        deleted_at: expect.any(String),
      }),
    ]);
  });
});

/** A core with a local chat model (no consent needed), and a Mind with a client. */
async function setUpAnswers(model: MockLanguageModelV4, dataDir?: string) {
  const folder = dataDir ?? (await createTempDataFolder());
  const sources = await createTempDataFolder();
  const core = startCore(folder, { createChatModel: scriptedModels(model).createChatModel });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Harbour" });
  const client = await connectToMind(core, mind.id);
  return { core, dataDir: folder, sources, mind, client };
}

/** Resolves with the end of an Answer: "finished" or "failed". */
function answerEnded(core: Core, answerId: string) {
  return new Promise<{ event: "finished" | "failed"; payload: unknown }>((resolve) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "finished", payload });
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve({ event: "failed", payload });
      }),
    ];
  });
}

/** Writes a Question (forcing a Skill, if given), asks it, and waits for its Answer. */
async function askAndWait(
  core: Core,
  client: MindClient,
  mindId: string,
  text: string,
  forcedSkill?: string,
) {
  const asked = question(text);
  if (forcedSkill) Object.assign(asked.attrs, { forcedSkill });
  writeMind(client, [asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  return { answerId: result.answerId, ended };
}

/** The Tool calls stored on an Answer. */
function toolCallsOf(client: MindClient, answerId: string) {
  const stored = answerIn(client, answerId).attrs.toolCalls;
  return typeof stored === "string" ? (JSON.parse(stored) as unknown[]) : [];
}

describe("Answers use Skills", () => {
  test("the system prompt lists the enabled Skills' names and descriptions only, and offers use_skill even with no Documents", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: "Answered without a Skill." };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const off = await importSkill(
      core,
      await writeFolder(sources, "almanac", {
        "SKILL.md": simpleSkillMd("almanac", "Turned-off Skill about dates.", "ALMANAC-BODY"),
      }),
    );
    await core.setSkillEnabled(off.id, false);

    const { ended } = await askAndWait(core, client, mind.id, "What is the weather like?");

    expect(ended.event).toBe("finished");
    const [call] = calls;
    // The tide Skill has a script, so run_skill_script is offered too (tests/core/skillScripts.test.ts).
    expect(call?.tools.sort()).toEqual(["read_skill_file", "run_skill_script", "use_skill"]);
    expect(call?.system).toContain(
      '<skill name="tide-tables">Reads tide tables and explains high and low water. Use for questions about tides.</skill>',
    );
    expect(call?.system).toMatch(/call use_skill with its name/);
    // Only names and descriptions: no instructions, no files, nothing of the Skill turned off.
    expect(call?.system).not.toContain(BODY_MARKER);
    expect(call?.system).not.toContain("ports.md");
    expect(call?.system).not.toContain("almanac");
  });

  test("with no Skills turned on, nothing about Skills is sent, and a Mind without Documents gets a plain Answer", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: "Plain." };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    const skill = await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    await core.setSkillEnabled(skill.id, false);

    await askAndWait(core, client, mind.id, "Hello?");

    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.system).not.toMatch(/skill/i);
  });

  test("use_skill loads a Skill's full instructions on demand, and the Answer shows it as a Tool call", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      const loaded = call.results.find((result) => result.tool === "use_skill");
      if (!loaded) {
        return {
          text: "Let me check the Skill.",
          calls: [{ tool: "use_skill", input: { name: "tide-tables" } }],
        };
      }
      return { text: loaded.text.includes(BODY_MARKER) ? "Followed the Skill." : "No Skill." };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const started: CoreEvents["answer.toolCallStarted"][] = [];
    core.on("answer.toolCallStarted", (event) => started.push(event));

    const { answerId } = await askAndWait(core, client, mind.id, "When is high water in Brest?");

    // The preamble before loading the Skill was taken back.
    expect(answerText(client, answerId)).toBe("Followed the Skill.");
    const loaded = model.doStreamCalls[1]?.prompt
      .flatMap((message) => (message.role === "tool" ? message.content : []))
      .find((part) => part.type === "tool-result");
    const text =
      loaded?.type === "tool-result" && loaded.output.type === "text" ? loaded.output.value : "";
    expect(text).toContain('<skill name="tide-tables">');
    expect(text).toContain(BODY_MARKER);
    expect(text).toContain("- references/ports.md");
    expect(text).toContain(
      "- scripts/convert.py (a script: run_skill_script runs it when the instructions say to)",
    );
    expect(toolCallsOf(client, answerId)).toEqual([
      {
        id: expect.any(String),
        tool: "use_skill",
        source: "skill",
        input: { name: "tide-tables" },
        status: "done",
        resultCount: null,
      },
    ]);
    expect(started.map((event) => event.call.tool)).toEqual(["use_skill"]);
  });

  // protects=an Answer that follows a Skill naming no language is told the Question's language after the search's Passages, whether use_skill loaded the Skill or the User forced it, and one that follows a Skill naming a language, or has no Skill, is not (#1273); fails_when=the Passages' or the Skill's language wins, the note is far above the Passages, or it overrides a language the Skill sets; no_claim=what a real model does, which the everyday eval's summary cases check.
  describe("the Question's language after the Passages", { timeout: 30_000 }, () => {
    const note =
      "The Skill's instructions don't change the language of your Answer. The Question is written in English, so answer in English.";
    const FILES = [{ name: "Harbour.txt", contents: "Harbour tides rise twice a day.\n" }];

    /** Asks about the Harbour with the Skill `body` is the instructions of; the search result the model was given, and the first request's instructions. */
    async function searchedWith(body: string | null, how: "loaded" | "forced") {
      const calls: ModelCall[] = [];
      const model = scriptedModel((call): ScriptedReply => {
        calls.push(call);
        const used = call.results.some((result) => result.tool === "use_skill");
        const searched = call.results.some((result) => result.tool === "search_documents");
        if (how === "loaded" && body !== null && !used) {
          return { calls: [{ tool: "use_skill", input: { name: "tide-tables" } }] };
        }
        if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
        return { text: "Answered." };
      });
      const { core, client, mind } = await setUpWithDocuments(model, FILES);
      if (body !== null) {
        await importSkill(
          core,
          await writeFolder(await createTempDataFolder(), "tides", {
            "SKILL.md": simpleSkillMd("tide-tables", "Explains tides.", body),
          }),
        );
      }
      await askAndWait(
        core,
        client,
        mind.id,
        "When is high water in Brest?",
        how === "forced" && body !== null ? "tide-tables" : undefined,
      );
      const results = calls.flatMap((call) => call.results);
      return {
        search: results.find((result) => result.tool === "search_documents")?.text ?? "",
        skill: results.find((result) => result.tool === "use_skill")?.text ?? "",
        system: calls[0]?.system ?? "",
      };
    }

    test.each(["loaded", "forced"] as const)(
      "a Skill that names none, %s: the search says it after the Passages, and nothing else repeats it",
      async (how) => {
        const run = await searchedWith("Summarize the tides in three bullet points.", how);
        expect(run.search).toContain("Harbour tides rise twice a day");
        expect(run.search.endsWith(note)).toBe(true);
        expect(run.search.indexOf(note)).toBeGreaterThan(run.search.indexOf("Harbour tides"));
        expect(run.skill).not.toContain(note);
        expect(run.system).not.toContain(note);
        // The line for the Question itself still ends the instructions.
        expect(run.system.split("\n").at(-1)).toBe(
          "- The Question is written in English, so answer in English.",
        );
      },
    );

    test.each(["loaded", "forced"] as const)(
      "a Skill that names a language keeps it, %s",
      async (how) => {
        const run = await searchedWith("Write the summary in French, in three bullets.", how);
        expect(run.search).toContain("Harbour tides rise twice a day");
        expect(run.search).not.toContain(note);
      },
    );

    test("an Answer with no Skill hears nothing extra", async () => {
      const run = await searchedWith(null, "loaded");
      expect(run.search).toContain("Harbour tides rise twice a day");
      expect(run.search).not.toContain("Skill");
    });
  });

  test("use_skill can't load a Skill that's turned off or doesn't exist", async () => {
    const model = scriptedModel((call): ScriptedReply => {
      if (call.index === 0) {
        return {
          calls: [
            { tool: "use_skill", input: { name: "almanac" } },
            { tool: "use_skill", input: { name: "nonexistent" } },
          ],
        };
      }
      return { text: call.results.map((result) => result.text).join("\n") };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const off = await importSkill(
      core,
      await writeFolder(sources, "almanac", {
        "SKILL.md": simpleSkillMd("almanac", "Dates.", "ALMANAC-BODY"),
      }),
    );
    await core.setSkillEnabled(off.id, false);

    const { answerId } = await askAndWait(core, client, mind.id, "Dates?");

    const text = answerText(client, answerId);
    expect(text).toContain('There is no Skill named "almanac". The Skills are: tide-tables.');
    expect(text).toContain('There is no Skill named "nonexistent"');
    expect(text).not.toContain("ALMANAC-BODY");
    expect(toolCallsOf(client, answerId)).toMatchObject([
      { tool: "use_skill", status: "failed" },
      { tool: "use_skill", status: "failed" },
    ]);
  });

  test("read_skill_file reads a Skill's own files, and nothing outside it", async () => {
    const reads: { skill: string; path: string }[] = [
      { skill: "tide-tables", path: "references/ports.md" },
      { skill: "tide-tables", path: "./scripts//convert.py" },
      { skill: "tide-tables", path: "../../incarnamind.db" },
      { skill: "tide-tables", path: "/etc/passwd" },
      { skill: "tide-tables", path: "references/../../../secret.txt" },
      { skill: "tide-tables", path: "references/missing.md" },
      { skill: "almanac", path: "SKILL.md" },
    ];
    const model = scriptedModel((call): ScriptedReply => {
      if (call.index === 0) {
        return { calls: reads.map((input) => ({ tool: "read_skill_file", input })) };
      }
      return { text: call.results.map((result) => `[${result.text}]`).join("\n\n") };
    });
    const { core, dataDir, sources, mind, client } = await setUpAnswers(model);
    await writeFile(join(dataDir, "skills", "secret.txt"), "SECRET");
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const off = await importSkill(
      core,
      await writeFolder(sources, "almanac", {
        "SKILL.md": simpleSkillMd("almanac", "Dates.", "ALMANAC-BODY"),
      }),
    );
    await core.setSkillEnabled(off.id, false);

    const { answerId } = await askAndWait(core, client, mind.id, "Which ports?");

    const results = answerText(client, answerId).split("\n\n");
    expect(results[0]).toBe("[Brest, Plymouth and Saint-Malo.]");
    expect(results[1]).toBe("[print('metres to feet')]");
    expect(results[2]).toMatch(/Give a path inside the Skill "tide-tables"/);
    expect(results[3]).toMatch(/Give a path inside the Skill "tide-tables"/);
    expect(results[4]).toMatch(/Give a path inside the Skill "tide-tables"/);
    expect(results[5]).toMatch(/has no file references\/missing\.md/);
    expect(results[6]).toMatch(/There is no Skill named "almanac"/);
    const text = answerText(client, answerId);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("ALMANAC-BODY");
    expect(
      toolCallsOf(client, answerId).map((call) => (call as { status: string }).status),
    ).toEqual(["done", "done", "failed", "failed", "failed", "failed", "failed"]);
    expect(toolCallsOf(client, answerId)[0]).toMatchObject({
      tool: "read_skill_file",
      source: "skill",
      input: { skill: "tide-tables", path: "references/ports.md" },
    });
  });

  test("a forced Skill's instructions are loaded up front, shown as a Tool call the core made", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      return { text: call.system.includes(BODY_MARKER) ? "Followed the forced Skill." : "No." };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    await importSkill(
      core,
      await writeFolder(sources, "almanac", { "SKILL.md": simpleSkillMd("almanac", "Dates.") }),
    );
    const events: string[] = [];
    core.on("answer.toolCallStarted", ({ call }) =>
      events.push(`started ${call.tool} ${call.status}`),
    );
    core.on("answer.toolCallFinished", ({ call }) =>
      events.push(`finished ${call.tool} ${call.status}`),
    );

    const { answerId } = await askAndWait(
      core,
      client,
      mind.id,
      "When is high water?",
      "tide-tables",
    );

    expect(answerText(client, answerId)).toBe("Followed the forced Skill.");
    expect(calls).toHaveLength(1);
    const system = calls[0]?.system ?? "";
    expect(system).toContain('For this Question the User chose the Skill "tide-tables"');
    expect(system).toContain(BODY_MARKER);
    // Its files can be read; the other Skills can still be loaded.
    expect(system).toContain("- references/ports.md");
    expect(system).toContain('<skill name="almanac">Dates.</skill>');
    expect(system).not.toContain('<skill name="tide-tables">Reads tide tables');
    expect(calls[0]?.tools.sort()).toEqual(["read_skill_file", "run_skill_script", "use_skill"]);
    expect(toolCallsOf(client, answerId)).toEqual([
      {
        id: "forced-skill",
        tool: "use_skill",
        source: "skill",
        input: { name: "tide-tables" },
        status: "done",
        resultCount: null,
        forced: true,
      },
    ]);
    expect(events).toEqual(["started use_skill running", "finished use_skill done"]);
  });

  test("a forced Skill reaches a model that can't call Tools too", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      calls.push(call);
      if (call.tools.length > 0)
        return { error: { status: 400, message: "this model does not support tools" } };
      return { text: call.system.includes(BODY_MARKER) ? "Followed it." : "No." };
    });
    const { core, sources, mind, client } = await setUpAnswers(model);
    await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));

    const { answerId } = await askAndWait(core, client, mind.id, "High water?", "tide-tables");

    expect(answerText(client, answerId)).toBe("Followed it.");
    const plain = calls.at(-1);
    expect(plain?.tools).toEqual([]);
    // Without Tools its files can't be read, so they aren't offered.
    expect(plain?.system).not.toContain("read_skill_file");
  });

  test("a Question forcing a Skill that's off or removed isn't asked, and says which", async () => {
    const model = scriptedModel(() => ({ text: "Unused." }));
    const { core, sources, mind, client } = await setUpAnswers(model);
    const skill = await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    await core.setSkillEnabled(skill.id, false);
    const off = question("High water?");
    Object.assign(off.attrs, { forcedSkill: "tide-tables" });
    const gone = question("Low water?");
    Object.assign(gone.attrs, { forcedSkill: "nonexistent" });
    writeMind(client, [off, gone]);
    await client.settled();

    expect(await core.askQuestion({ mindId: mind.id, questionId: off.attrs.id })).toEqual({
      asked: false,
      reason: "skill-unavailable",
      skill: "tide-tables",
      state: "disabled",
    });
    expect(await core.askQuestion({ mindId: mind.id, questionId: gone.attrs.id })).toEqual({
      asked: false,
      reason: "skill-unavailable",
      skill: "nonexistent",
      state: "removed",
    });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  test("a Skill removed while an Answer uses it keeps its folder until the Answer ends", async () => {
    const controlled = controlledModel();
    const { core, dataDir, sources, mind, client } = await setUpAnswers(controlled.model);
    const skill = await importSkill(core, await writeFolder(sources, "tides", TIDES_SKILL));
    const asked = question("High water?");
    writeMind(client, [asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("Not asked.");
    await controlled.requested();

    await core.removeSkill(skill.id);
    expect(await core.listSkills()).toEqual([]);
    expect(existsSync(join(dataDir, "skills", skill.id))).toBe(true);

    const ended = answerEnded(core, result.answerId);
    controlled.push("Done.");
    controlled.finish();
    await ended;
    await vi.waitFor(() => expect(existsSync(join(dataDir, "skills", skill.id))).toBe(false));
  });
});

describe("A forced Skill with a Search scope", { timeout: 30_000 }, () => {
  test("both apply, when the Question is asked and when its Answer is regenerated", async () => {
    const calls: ModelCall[] = [];
    // Searches for tides once per Answer, then answers.
    const model = scriptedModel((call): ScriptedReply => {
      calls.push(call);
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      }
      return { text: "Answered." };
    });
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Harbour.txt", contents: "Harbour tides rise twice a day along the quay.\n" },
      { name: "Recipes.txt", contents: "Cook mussels at low tides, with garlic.\n" },
    ]);
    const harbour = documents.find((document) => document.name === "Harbour");
    if (!harbour) throw new Error("No Harbour Document.");
    await importSkill(core, await writeFolder(await createTempDataFolder(), "tides", TIDES_SKILL));
    const asked = question("What about tides?", undefined, { documentIds: [harbour.id] });
    Object.assign(asked.attrs, { forcedSkill: "tide-tables" });
    writeMind(client, [asked]);
    await client.settled();

    /** What the model was given in the Answer's requests from `from` on: instructions, and Documents searched. */
    const seen = (from: number) => {
      const answerCalls = calls.slice(from);
      const searched = answerCalls
        .flatMap((call) => call.results)
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text).map((passage) => passage.document));
      return {
        followsSkill: answerCalls.every((call) => call.system.includes(BODY_MARKER)),
        searched: [...new Set(searched)].sort(),
      };
    };

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    expect((await answerEnded(core, result.answerId)).event).toBe("finished");
    expect(seen(0)).toEqual({ followsSkill: true, searched: ["Harbour"] });
    expect(toolCallsOf(client, result.answerId)).toMatchObject([
      { tool: "use_skill", input: { name: "tide-tables" }, forced: true, status: "done" },
      { tool: "search_documents", source: "documents", status: "done" },
    ]);

    const before = calls.length;
    const again = await core.regenerateAnswer({ mindId: mind.id, answerId: result.answerId });
    if (!again.asked) throw new Error(`Not regenerated: ${JSON.stringify(again)}`);
    expect((await answerEnded(core, again.answerId)).event).toBe("finished");
    expect(calls.length).toBeGreaterThan(before);
    expect(seen(before)).toEqual({ followsSkill: true, searched: ["Harbour"] });
    expect(toolCallsOf(client, again.answerId)).toMatchObject([
      { tool: "use_skill", forced: true },
      { tool: "search_documents" },
    ]);
  });
});

describe("Skills after a restart", () => {
  test("are still there, on or off as they were, and a forced Skill still loads", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const first = startCore(dataDir);
    const tides = await importSkill(first, await writeFolder(sources, "tides", TIDES_SKILL));
    const almanac = await importSkill(
      first,
      await writeFolder(sources, "almanac", { "SKILL.md": simpleSkillMd("almanac", "Dates.") }),
    );
    await first.setSkillEnabled(almanac.id, false);
    const removed = await importSkill(
      first,
      await writeFolder(sources, "gone", { "SKILL.md": simpleSkillMd("gone", "Removed.") }),
    );
    await first.removeSkill(removed.id);
    const before: Skill[] = await first.listSkills();
    // A write a quit interrupted.
    await mkdir(join(dataDir, "skills", ".incoming", "half-written"), { recursive: true });
    first.close();

    const model = scriptedModel((call) => ({
      text: call.system.includes(BODY_MARKER) ? "Still follows it." : "No.",
    }));
    const { core, mind, client } = await setUpAnswers(model, dataDir);
    expect(await core.listSkills()).toEqual(before);
    expect(before.map((skill) => [skill.name, skill.enabled])).toEqual([
      ["almanac", false],
      ["tide-tables", true],
    ]);
    expect(await storedFiles(dataDir, tides.id)).toEqual([
      "SKILL.md",
      "references/ports.md",
      "scripts/convert.py",
    ]);
    expect((await readdir(join(dataDir, "skills"))).sort()).toEqual(
      [".incoming", almanac.id, tides.id].sort(),
    );
    expect(await readdir(join(dataDir, "skills", ".incoming"))).toEqual([]);

    const { answerId } = await askAndWait(core, client, mind.id, "High water?", "tide-tables");
    expect(answerText(client, answerId)).toBe("Still follows it.");
  });
});
