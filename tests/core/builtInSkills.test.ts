import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILT_IN_SKILLS_PACKAGED,
  BUILT_IN_SKILLS_SOURCE,
  type CoreAdapters,
  InvalidInputError,
  SKILL_LIMITS,
  type Skill,
} from "../../src/core";
import { parseSkillMd, renameSkillMd } from "../../src/core/skills/frontmatter";
import { readSkillSource } from "../../src/core/skills/source";
import { answerEnded, citationsIn, shownPassages } from "../helpers/citations";
import {
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  startCore,
  tickingClock,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, note, question, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import {
  BUILT_IN_SKILL_NAMES,
  BUILT_IN_SKILLS_DIR,
  copyBuiltInSkills,
  importSkill,
  previewOk,
  previewRefused,
  REPO_ROOT,
  simpleSkillMd,
  writeFolder,
} from "../helpers/skills";

/** Starts the core on `dataDir` with the built-in Skills in `builtIns` (the app's, by default). */
const startWithBuiltIns = (
  dataDir: string,
  builtIns = BUILT_IN_SKILLS_DIR,
  overrides: Partial<CoreAdapters> = {},
) => startCore(dataDir, { paths: { dataDir, builtInSkills: builtIns }, ...overrides });

/** A built-in Skill's SKILL.md as the app ships it, read and parsed. */
async function shipped(name: string, folder = BUILT_IN_SKILLS_DIR) {
  const text = await readFile(join(folder, name, "SKILL.md"), "utf8");
  const parsed = parseSkillMd(text);
  if (!parsed.ok) throw new Error(`${name}'s SKILL.md is invalid: ${parsed.message}`);
  return { text, ...parsed };
}

const named = (skills: readonly Skill[], name: string): Skill => {
  const skill = skills.find((each) => each.name === name);
  if (!skill) throw new Error(`No Skill named ${name}.`);
  return skill;
};

/** A stored Skill's file, from the data folder. */
const storedFile = (dataDir: string, skill: Skill, path = "SKILL.md") =>
  readFile(join(dataDir, "skills", skill.id, ...path.split("/")), "utf8");

describe("The built-in Skills", () => {
  test("are the app's SKILL.md folders, each a valid Skill that any Skill reader would import", async () => {
    const folders = (await readdir(BUILT_IN_SKILLS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(folders).toEqual(BUILT_IN_SKILL_NAMES);

    for (const name of folders) {
      // Read the way an imported Skill is: paths, links and sizes checked.
      const source = await readSkillSource(join(BUILT_IN_SKILLS_DIR, name));
      if (!source.ok) throw new Error(`${name}: ${source.error.message}`);
      expect(source.files.map((file) => file.path)).toEqual(["SKILL.md"]);

      const { text, frontmatter, body } = await shipped(name);
      // Named like its folder, as the SKILL.md convention has it; written in-house.
      expect(frontmatter).toMatchObject({
        name,
        license: "Apache-2.0",
        metadata: { author: "IncarnaMind" },
      });
      // The description is what the model picks Skills by: what it does, and when to use it.
      expect(frontmatter.description.length).toBeGreaterThanOrEqual(100);
      expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
      expect(frontmatter.description).toMatch(/\bUse when\b/);
      // Plain YAML anywhere: no ": " or " #" inside a plain value.
      expect(text.split("---")[1]).not.toMatch(/^description: .*(: | #)/m);
      // A forced Skill's instructions go with every request of its Answer: kept short.
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(6 * 1024);
      expect(Buffer.byteLength(text)).toBeLessThan(SKILL_LIMITS.maxInstructionsBytes);
      expect(body).toMatch(/^# /);

      // In English, written so the Answer follows the Question's language,
      expect(body).toContain("in the language the Question is written in");
      // cites through the normal Citation flow, inventing nothing,
      expect(body).toContain("the way your instructions for citing say");
      expect(body).toMatch(/don't write a list of sources/i);
      expect(body).toMatch(/never (cite|invent)/i);
      // and says plainly when the Documents don't support something.
      expect(body).toMatch(/say so plainly/);
      // No tables: Answers don't render them.
      expect(body).not.toMatch(/^\|/m);
    }
  });

  test("each does its own task: a summary, a review by theme, and a report from the Mind", async () => {
    const summary = (await shipped("summarise-document")).body;
    // A paper keeps its claims, method and limitations,
    for (const section of ["Key claims", "Methods or approach", "Limitations"]) {
      expect(summary).toContain(section);
    }
    // an agreement gets its own sections (#1175),
    for (const section of ["Parties", "Term", "Obligations", "Notice and termination"]) {
      expect(summary).toContain(section);
    }
    // no kind of Document takes another's, and no heading stands over nothing.
    expect(summary).toContain("a contract has no Methods or Limitations");
    expect(summary).toContain("is left out whole: no heading, and no line saying it is missing");
    // one rule for a missing section: search again, then leave it out; no line in the introduction,
    expect(summary).toContain(
      "search again with the Document's own words before you leave that section out",
    );
    expect(summary).not.toContain("in one sentence in the introduction");
    // and several Documents each in the structure for its kind.
    expect(summary).toContain("each in the structure for its kind but shorter");
    expect(summary).toContain("Search scope");

    const review = (await shipped("literature-review")).body;
    expect(review).toContain("organised by theme, never a summary of one Document after another");
    for (const section of ["Agreements and disagreements", "Gaps", "Conclusion"]) {
      expect(review).toContain(`**${section}**`);
    }
    expect(review).toContain("search_documents");

    const report = (await shipped("mind-to-report")).body;
    for (const section of ["Title", "Summary", "Sections", "Conclusion"]) {
      expect(report).toContain(`**${section}**`);
    }
    // Citations in the Mind reach the model as plain references: keep them, invent none.
    expect(report).toContain("[Attention Is All You Need, p. 3]");
    expect(report).toContain("Never invent a source");
  });

  /**
   * The finance and law Skills (#1938), and the instructions each matter's case
   * turns on: the elements the note must hold, and what to say when the record
   * lacks one. The hand run in eval/skills uses the same matters in both
   * languages.
   */
  const FINANCE_AND_LAW = [
    {
      name: "covenant-summary",
      terms: [
        "financial covenant",
        "Its level",
        "The latest figure",
        "Keep the level and the latest figure apart",
        "isn't in the Documents",
      ],
    },
    {
      name: "cim-red-flags",
      terms: [
        "confidential information memorandum",
        "The claim",
        "What the Documents show",
        "Why it is a red flag",
        "A red flag always cites the CIM's claim",
        "unsupported",
      ],
    },
    {
      name: "earnings-review",
      terms: ["Against the prior period", "Against guidance", "percentage point"],
    },
    {
      name: "credit-memo-outline",
      terms: [
        "Executive summary",
        "Borrower and group",
        "Transaction",
        "Financial analysis",
        "Risks and mitigants",
        "Recommendation",
        "left out whole",
      ],
    },
    {
      name: "deposition-summary",
      terms: [
        "page and line",
        "The topic",
        "The points",
        "Conflicts",
        "Never give a page or line the transcript doesn't show",
      ],
    },
    {
      name: "chronology",
      terms: [
        "date order",
        "The date",
        "The event",
        "Undated",
        "Never infer a date from a file's metadata",
        "they differ",
      ],
    },
  ] as const;

  test.each(FINANCE_AND_LAW)("$name holds its matter's case", async ({ name, terms }) => {
    const { body } = await shipped(name);
    for (const term of terms) expect(body).toContain(term);
    // A record that doesn't support part of the Question is said plainly, never filled in.
    expect(body).toContain("say so plainly");
    expect(body).toMatch(/Cite every (?:figure|filled fact|point|event)|Cite the CIM's claim/);
  });
});

describe("Installing the built-in Skills", () => {
  test("on first run they are installed, turned on and marked built-in, with the app's files", async () => {
    const dataDir = await createTempDataFolder();
    const core = startWithBuiltIns(dataDir);

    const skills = await core.listSkills();
    expect(skills.map((skill) => [skill.name, skill.builtIn, skill.enabled])).toEqual(
      BUILT_IN_SKILL_NAMES.map((name) => [name, true, true]),
    );
    for (const skill of skills) {
      const app = await shipped(skill.name);
      expect(skill).toMatchObject({
        description: app.frontmatter.description,
        license: "Apache-2.0",
        files: [{ path: "SKILL.md", size: Buffer.byteLength(app.text), script: false }],
      });
      expect(await storedFile(dataDir, skill)).toBe(app.text);
    }
    expect(
      queryDatabase<{ built_in: number; built_in_digest: string }>(
        dataDir,
        "SELECT built_in, built_in_digest FROM skills",
      ),
    ).toEqual(
      BUILT_IN_SKILL_NAMES.map(() => ({
        built_in: 1,
        built_in_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      })),
    );
    expect(await core.listRemovedBuiltInSkills()).toEqual([]);

    // The next start finds them there: nothing changes.
    core.close();
    const again = startWithBuiltIns(dataDir);
    expect(await again.listSkills()).toEqual(skills);
  });

  test("Skills the User imports aren't built-in, and a core given no built-in Skills has none", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    expect(await core.listSkills()).toEqual([]);
    expect(await core.listRemovedBuiltInSkills()).toEqual([]);
    expect(await core.restoreBuiltInSkills()).toEqual([]);
    const sources = await createTempDataFolder();
    const mine = await importSkill(
      core,
      await writeFolder(sources, "almanac", { "SKILL.md": simpleSkillMd("almanac", "Dates.") }),
    );
    expect(mine.builtIn).toBe(false);
  });

  test("a newer version of the app updates them in place, keeping their ids and whether they're on", async () => {
    const builtIns = await copyBuiltInSkills();
    const dataDir = await createTempDataFolder();
    const first = startWithBuiltIns(dataDir, builtIns, {
      now: tickingClock("2026-10-06T09:00:00.000Z"),
    });
    const review = named(await first.listSkills(), "literature-review");
    const turnedOff = await first.setSkillEnabled(review.id, false);
    const before = await first.listSkills();
    first.close();

    // The newer version: new instructions and description for one Skill, and a reference file.
    const instructions = join(builtIns, "literature-review", "SKILL.md");
    const old = await readFile(instructions, "utf8");
    await writeFile(
      instructions,
      old
        .replace(/^description: .*$/m, "description: Reviews the literature, second edition.")
        .replace(/^# .*$/m, "$&\n\nREVIEW-V2: read references/themes.md first."),
    );
    await mkdir(join(builtIns, "literature-review", "references"));
    await writeFile(join(builtIns, "literature-review", "references", "themes.md"), "Themes.\n");

    const second = startWithBuiltIns(dataDir, builtIns, {
      now: tickingClock("2026-10-07T09:00:00.000Z"),
    });
    const after = await second.listSkills();
    expect(after.map((skill) => skill.id)).toEqual(before.map((skill) => skill.id));
    const updated = named(after, "literature-review");
    expect(updated).toMatchObject({
      id: review.id,
      builtIn: true,
      enabled: false,
      description: "Reviews the literature, second edition.",
      files: [
        { path: "SKILL.md", script: false },
        { path: "references/themes.md", script: false },
      ],
    });
    expect(updated.updatedAt > turnedOff.updatedAt).toBe(true);
    expect(await storedFile(dataDir, updated)).toContain("REVIEW-V2");
    expect(await storedFile(dataDir, updated, "references/themes.md")).toBe("Themes.\n");
    // The others are as they were.
    expect(after.filter((skill) => skill.id !== review.id)).toEqual(
      before.filter((skill) => skill.id !== review.id),
    );
    // Nothing is left behind from the swap.
    expect(await readdir(join(dataDir, "skills", ".incoming"))).toEqual([]);
  });

  test("a built-in Skill whose files went missing from the data folder gets them back at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = startWithBuiltIns(dataDir);
    const summary = named(await first.listSkills(), "summarise-document");
    first.close();
    await rm(join(dataDir, "skills", summary.id, "SKILL.md"));

    const second = startWithBuiltIns(dataDir);
    expect(named(await second.listSkills(), "summarise-document").id).toBe(summary.id);
    expect(await storedFile(dataDir, summary)).toBe((await shipped("summarise-document")).text);
  });

  test("a removed built-in Skill stays removed, through updates too, until the User restores the built-in Skills", async () => {
    const builtIns = await copyBuiltInSkills();
    const dataDir = await createTempDataFolder();
    const first = startWithBuiltIns(dataDir, builtIns);
    const summary = named(await first.listSkills(), "summarise-document");
    await first.removeSkill(summary.id);
    expect(await first.listRemovedBuiltInSkills()).toEqual(["summarise-document"]);
    first.close();

    // Restarted, then updated: still removed.
    const second = startWithBuiltIns(dataDir, builtIns);
    expect((await second.listSkills()).map((skill) => skill.name)).toEqual(
      BUILT_IN_SKILL_NAMES.filter((name) => name !== "summarise-document"),
    );
    second.close();
    const instructions = join(builtIns, "summarise-document", "SKILL.md");
    await writeFile(
      instructions,
      (await readFile(instructions, "utf8")).replace(/^# .*$/m, "$&\n\nSUMMARY-V2."),
    );
    const third = startWithBuiltIns(dataDir, builtIns);
    expect((await third.listSkills()).map((skill) => skill.name)).not.toContain(
      "summarise-document",
    );
    expect(await third.listRemovedBuiltInSkills()).toEqual(["summarise-document"]);

    // Restored: installed again, turned on, with this version's files.
    const changed = nextEvent(third, "skills.changed");
    const restored = await third.restoreBuiltInSkills();
    expect(restored).toEqual([
      expect.objectContaining({ name: "summarise-document", builtIn: true, enabled: true }),
    ]);
    expect((await changed).map((skill) => skill.name)).toEqual(BUILT_IN_SKILL_NAMES);
    expect(await storedFile(dataDir, restored[0] as Skill)).toContain("SUMMARY-V2.");
    expect(await third.listRemovedBuiltInSkills()).toEqual([]);
    expect(await third.restoreBuiltInSkills()).toEqual([]);
    // The removal stays recorded (a deleted row); the restored Skill is a new one.
    expect(
      queryDatabase<{ deleted: number }>(
        dataDir,
        "SELECT deleted_at IS NOT NULL AS deleted FROM skills WHERE name = ? ORDER BY created_at, deleted_at IS NULL",
        ["summarise-document"],
      ),
    ).toEqual([{ deleted: 1 }, { deleted: 0 }]);
    third.close();

    const fourth = startWithBuiltIns(dataDir, builtIns);
    expect((await fourth.listSkills()).map((skill) => skill.name)).toEqual(BUILT_IN_SKILL_NAMES);
  });

  test("a Skill of the User's with a built-in Skill's name is left alone, and not offered for restoring", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const before = startCore(dataDir);
    const mine = await importSkill(
      before,
      await writeFolder(sources, "summary", {
        "SKILL.md": simpleSkillMd("summarise-document", "My own way of summarising."),
      }),
    );
    before.close();

    const core = startWithBuiltIns(dataDir);
    const skills = await core.listSkills();
    expect(skills.map((skill) => [skill.name, skill.builtIn])).toEqual(
      BUILT_IN_SKILL_NAMES.map((name) => [name, name !== "summarise-document"]),
    );
    expect(named(skills, "summarise-document")).toEqual(mine);
    expect(await core.listRemovedBuiltInSkills()).toEqual([]);
  });
});

describe("Built-in Skills are the app's", () => {
  test("importing can't replace one; duplicating it makes a copy that is the User's own", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startWithBuiltIns(dataDir);
    const review = named(await core.listSkills(), "literature-review");
    const app = await shipped("literature-review");

    const refused = await previewRefused(
      core,
      await writeFolder(sources, "review", {
        "SKILL.md": simpleSkillMd("literature-review", "Edited in place."),
      }),
    );
    expect(refused).toMatchObject({ kind: "built-in-name", path: "SKILL.md", field: "name" });
    expect(await storedFile(dataDir, review)).toBe(app.text);

    const changed = nextEvent(core, "skills.changed");
    const copy = await core.duplicateSkill(review.id);
    expect(copy).toMatchObject({
      name: "literature-review-copy",
      builtIn: false,
      enabled: true,
      description: review.description,
      license: "Apache-2.0",
      files: [{ path: "SKILL.md", script: false }],
    });
    expect(copy.id).not.toBe(review.id);
    expect((await changed).map((skill) => skill.name)).toContain("literature-review-copy");
    // The same instructions, under the copy's name.
    const copied = parseSkillMd(await storedFile(dataDir, copy));
    if (!copied.ok) throw new Error(copied.message);
    expect(copied.frontmatter).toEqual({ ...app.frontmatter, name: "literature-review-copy" });
    expect(copied.body).toBe(app.body);
    expect((await core.duplicateSkill(review.id)).name).toBe("literature-review-copy-2");

    // The copy is the User's: importing a Skill of its name replaces it.
    const preview = await previewOk(
      core,
      await writeFolder(sources, "mine", {
        "SKILL.md": simpleSkillMd("literature-review-copy", "My review."),
      }),
    );
    expect(preview.replaces?.id).toBe(copy.id);
    expect((await core.importSkill(preview.importId)).description).toBe("My review.");
    expect(named(await core.listSkills(), "literature-review")).toEqual(review);
  });

  test("once removed, its name is free for a Skill of the User's, which restoring leaves alone", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startWithBuiltIns(dataDir);
    const report = named(await core.listSkills(), "mind-to-report");
    await core.removeSkill(report.id);

    const folder = await writeFolder(sources, "report", {
      "SKILL.md": simpleSkillMd("mind-to-report", "My own report."),
    });
    // Restored between the preview and the import: the import is refused.
    const early = await previewOk(core, folder);
    expect(early.replaces).toBeNull();
    await core.restoreBuiltInSkills();
    await expect(core.importSkill(early.importId)).rejects.toThrow(InvalidInputError);
    expect(named(await core.listSkills(), "mind-to-report").builtIn).toBe(true);

    // Removed again, the User's Skill takes the name, and restoring skips it.
    await core.removeSkill(named(await core.listSkills(), "mind-to-report").id);
    const mine = await importSkill(core, folder);
    expect(mine).toMatchObject({ name: "mind-to-report", builtIn: false });
    expect(await core.listRemovedBuiltInSkills()).toEqual([]);
    expect(await core.restoreBuiltInSkills()).toEqual([]);
    expect(named(await core.listSkills(), "mind-to-report")).toEqual(mine);
  });
});

const TIDES = [
  "Tides rise and fall twice a day along the coast.",
  "Spring tides happen at new moon and at full moon.",
  "Neap tides come in between, when the pull of the Sun and the Moon is at right angles.",
].join("\n");
const SPRING = "Spring tides happen at new moon and at full moon.";

describe("Built-in Skills forced on a Question", { timeout: 30_000 }, () => {
  test.each(BUILT_IN_SKILL_NAMES)(
    "%s: its instructions are loaded up front, and the Answer cites the Documents through the normal Citation flow",
    async (name) => {
      const calls: ModelCall[] = [];
      // A model that follows the Skill: it searches, records its Citation, then writes.
      const model = scriptedModel((call): ScriptedReply => {
        calls.push(call);
        if (!call.tools.includes("search_documents")) return { text: "No search was offered." };
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const [passage] = shownPassages(searches.at(-1)?.text ?? "");
          if (!passage) return { text: "Nothing found." };
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: SPRING }] },
              },
            ],
          };
        }
        return { text: "Spring tides come at new and full moon [^1]." };
      });
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startWithBuiltIns(dataDir, BUILT_IN_SKILLS_DIR, {
        createChatModel: scriptedModels(model).createChatModel,
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      await addAndProcess(core, [await writeSourceFile(sources, "Tides.txt", TIDES)]);
      const mind = await core.createMind({ title: "Tides" });
      const client = await connectToMind(core, mind.id);
      // A Note holding a Citation, which Question context shows as a reference.
      const cited = note("The Moon drives the tides");
      cited.content?.push(
        {
          type: "citation",
          attrs: {
            passageId: "p",
            documentId: "d",
            documentName: "Tides",
            contentHash: "h",
            pageFrom: null,
            pageTo: null,
            quote: "Tides rise and fall twice a day along the coast.",
            check: "found",
          },
        },
        { type: "text", text: "." },
      );
      const asked = question("When are spring tides?");
      Object.assign(asked.attrs, { forcedSkill: name });
      writeMind(client, [cited, asked]);
      await client.settled();

      const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
      if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
      const ended = await answerEnded(core, result.answerId);
      if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));

      // Every request carried the Skill's instructions, as the app ships them.
      const { body } = await shipped(name);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect(call.system).toContain(`For this Question the User chose the Skill "${name}"`);
        expect(call.system).toContain(body);
      }
      // They tell the model to write in the Question's language, but before the Passages: the search says it again after them (#1273).
      const searched = calls
        .flatMap((call) => call.results)
        .find((result) => result.tool === "search_documents");
      expect(searched?.text).toMatch(
        /The Skill's instructions don't change the language of your Answer\. The Question is written in English, so answer in English\.$/,
      );
      // The other built-in Skills are listed by name and description only.
      for (const other of BUILT_IN_SKILL_NAMES.filter((each) => each !== name)) {
        const { frontmatter, body: otherBody } = await shipped(other);
        expect(calls[0]?.system).toContain(
          `<skill name="${other}">${frontmatter.description}</skill>`,
        );
        expect(calls[0]?.system).not.toContain(otherBody);
      }
      // The Mind reached the model, its Citation as a reference with the id cite takes (#1800).
      const firstUser = calls[0]?.options.prompt.find((message) => message.role === "user");
      expect(JSON.stringify(firstUser?.content)).toContain(
        "The Moon drives the tides[Tides · C1].",
      );

      // The normal Citation flow: a checked Citation in the Answer's text.
      expect(citationsIn(client, result.answerId)).toEqual([
        expect.objectContaining({ documentName: "Tides", quote: SPRING, check: "found" }),
      ]);
      expect(ended.payload).toMatchObject({ status: "done", citationSupport: "tools" });
      const toolCalls = JSON.parse(String(answerIn(client, result.answerId).attrs.toolCalls));
      expect(toolCalls).toMatchObject([
        { tool: "use_skill", source: "skill", input: { name }, forced: true, status: "done" },
        { tool: "search_documents", source: "documents", status: "done" },
      ]);
    },
  );
});

const AGREEMENT = [
  "Employment agreement between Harbour Logistics Limited and Wei Chen.",
  "The term is three years from the start date, with a three-month probation.",
  "The employee is paid 3,200 pounds a month and works forty hours a week.",
].join("\n");
const PAPER = [
  "Abstract. We propose GraphST, a contrastive model for urban graphs.",
  "We evaluate it on traffic prediction with ablations over each component.",
  "A limitation is that region graphs built from noisy data may mislead it.",
].join("\n");

describe("The summary Skill's sections follow the kind of Document (#1175)", {
  timeout: 30_000,
}, () => {
  /**
   * A model that follows the Skill as it reaches it: it searches, cites the first Passage, and
   * writes the sections the instructions give for the kind of Document the Question names, those
   * the Document has something for (`covered`) and no others.
   */
  function followingTheSkill(kind: "agreement" | "paper", quote: string, covered: string[]) {
    return scriptedModel((call): ScriptedReply => {
      if (!call.tools.includes("search_documents")) return { text: "No search was offered." };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query: quote } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(searches.at(-1)?.text ?? "");
        if (!passage) return { text: "Nothing found." };
        return {
          calls: [
            { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
          ],
        };
      }
      const given =
        kind === "agreement"
          ? /\*\*A contract or agreement\*\* gets ([^\n]*?)\. Give the amounts/.exec(
              call.system,
            )?.[1]
          : /\*\*A research paper\*\* gets these sections:\n\n((?:\d\. [^\n]*\n)+)/.exec(
              call.system,
            )?.[1];
      const headings = [...(given ?? "").matchAll(/\*\*([^*]+)\*\*/g)]
        .map((each) => each[1])
        .filter((heading) => heading !== undefined && covered.includes(heading));
      return {
        text: headings.map((heading) => `### ${heading}\n\n- ${quote} [^1]`).join("\n\n"),
      };
    });
  }

  async function summarise(
    kind: "agreement" | "paper",
    text: string,
    quote: string,
    covered: string[],
  ) {
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startWithBuiltIns(dataDir, BUILT_IN_SKILLS_DIR, {
      createChatModel: scriptedModels(followingTheSkill(kind, quote, covered)).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const name = kind === "agreement" ? "Employment agreement.txt" : "GraphST.txt";
    await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
    const mind = await core.createMind({ title: "Summary" });
    const client = await connectToMind(core, mind.id);
    const asked = question(
      kind === "agreement" ? "Summarise the employment agreement" : "Summarise the GraphST paper",
    );
    Object.assign(asked.attrs, { forcedSkill: "summarise-document" });
    writeMind(client, [asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    const ended = await answerEnded(core, result.answerId);
    if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
    const headings: string[] = [];
    answerIn(client, result.answerId).descendants((node) => {
      if (node.type.name === "heading") headings.push(node.textContent);
    });
    return {
      headings,
      cited: citationsIn(client, result.answerId).length,
    };
  }

  test("an employment agreement gets the sections its text has, each point cited, none for what it lacks, and no paper sections", async () => {
    const { headings, cited } = await summarise(
      "agreement",
      AGREEMENT,
      "The term is three years from the start date, with a three-month probation.",
      ["Parties", "Term", "Pay"],
    );
    // The agreement gives no place of work and no notice: its summary has no heading for them.
    expect(headings).toEqual(["Parties", "Term", "Pay"]);
    for (const paperOnly of [
      "Key claims",
      "Methods or approach",
      "Limitations",
      "Open questions",
    ]) {
      expect(headings).not.toContain(paperOnly);
    }
    expect(cited).toBeGreaterThanOrEqual(headings.length);
  });

  test("a paper keeps its claims, method and limitations", async () => {
    const { headings, cited } = await summarise(
      "paper",
      PAPER,
      "We evaluate it on traffic prediction with ablations over each component.",
      ["Key claims", "Methods or approach", "Limitations"],
    );
    // The paper names no future work: no Open questions.
    expect(headings).toEqual(["Key claims", "Methods or approach", "Limitations"]);
    expect(cited).toBeGreaterThanOrEqual(headings.length);
  });
});

/** The `extraResources` entries of electron-builder.yml, read with just enough YAML for them. */
function extraResources(yaml: string): Record<string, string | string[]>[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^extraResources:\s*$/.test(line));
  if (start < 0) return [];
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");
  const entries: Record<string, string | string[]>[] = [];
  let entry: Record<string, string | string[]> | null = null;
  let list: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^ {2}- (\w+):\s*(.*)$/.exec(line);
    const field = /^ {4}(\w+):\s*(.*)$/.exec(line);
    const element = /^ {6}- (.*)$/.exec(line);
    if (item) {
      entry = { [item[1] as string]: unquote(item[2] as string) };
      entries.push(entry);
      list = null;
    } else if (field && entry) {
      list = field[2] === "" ? [] : null;
      entry[field[1] as string] = list ?? unquote(field[2] as string);
    } else if (element && list) {
      list.push(unquote(element[1] as string));
    } else {
      throw new Error(`An extraResources line this test can't read: ${line}`);
    }
  }
  return entries;
}

describe("A copy's SKILL.md", () => {
  test("gets the new name on its name line, and everything else byte for byte", () => {
    const text = '---\r\nname: "tides"\r\ndescription: Tides.\r\n---\r\n\r\nname: not this one\r\n';
    expect(renameSkillMd(text, "tides-copy")).toBe(
      "---\r\nname: tides-copy\r\ndescription: Tides.\r\n---\r\n\r\nname: not this one\r\n",
    );
  });

  test("isn't renamed when the name isn't on a line of its own", () => {
    expect(renameSkillMd("---\nname: >-\n  tides\ndescription: Tides.\n---\n", "x")).toBeNull();
    expect(renameSkillMd("---\nname: tides\n  and more\ndescription: T.\n---\n", "x")).toBeNull();
    expect(renameSkillMd("---\ndescription: Tides.\n---\nname: tides\n", "x")).toBeNull();
    expect(renameSkillMd("# No frontmatter\n", "x")).toBeNull();
  });
});

describe("Packaging", () => {
  test("electron-builder copies the built-in Skills into the app's resources, where the main process looks for them", async () => {
    const config = await readFile(join(REPO_ROOT, "electron-builder.yml"), "utf8");
    expect(extraResources(config)).toContainEqual({
      from: BUILT_IN_SKILLS_SOURCE,
      to: BUILT_IN_SKILLS_PACKAGED,
      filter: ["**/*"],
    });
    expect(existsSync(join(REPO_ROOT, BUILT_IN_SKILLS_SOURCE))).toBe(true);
    // A packaged app reads them from its resources folder; a development build from the repository.
    const platform = await readFile(join(REPO_ROOT, "src/main/platform.ts"), "utf8");
    expect(platform).toMatch(/join\(process\.resourcesPath, BUILT_IN_SKILLS_PACKAGED\)/);
    expect(platform).toMatch(/join\(app\.getAppPath\(\), BUILT_IN_SKILLS_SOURCE\)/);
    expect(platform).toMatch(
      /paths: \{\s*dataDir,\s*builtInSkills: builtInSkillsFolder\(\)(,|\s*\})/,
    );
  });

  test("electron-builder copies the example Documents into the app's resources, where the main process looks for them", async () => {
    const config = await readFile(join(REPO_ROOT, "electron-builder.yml"), "utf8");
    expect(extraResources(config)).toContainEqual({
      from: "resources/examples",
      to: "examples",
      filter: ["**/*"],
    });
    expect(existsSync(join(REPO_ROOT, "resources/examples/LICENSE"))).toBe(true);
    const platform = await readFile(join(REPO_ROOT, "src/main/platform.ts"), "utf8");
    expect(platform).toMatch(/join\(process\.resourcesPath, "examples"\)/);
    expect(platform).toMatch(/join\(app\.getAppPath\(\), "resources", "examples"\)/);
    expect(platform).toMatch(/examples: examplesFolder\(\)/);
  });
});
