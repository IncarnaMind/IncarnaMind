import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  ANSWER_SAMPLE,
  answerSample,
  answersSheet,
  folderSheet,
  readAnswersSheet,
  readFolderSheet,
} from "../../eval/organize/folderSheet";
import { AREAS, byArea, type DocumentAreas, readAreas } from "../../eval/organize/lib/areas";
import type { FolderReading } from "../../eval/organize/lib/folderReader";
import { readPlan } from "../../eval/organize/lib/planReading";
import { readSet } from "../../eval/organize/lib/set";
import {
  type AnswerItem,
  answerAgreement,
  answerItems,
  areasDiffering,
  areasWithScans,
  BARS,
  checkKeyPath,
  committedAt,
  documentAgreement,
  folderAgreement,
  folderItems,
  joinReport,
  lookHereOf,
  plansOf,
  type SavedRun,
  shuffled,
  verdictsOf,
} from "../../eval/organize/readPlans";

const root = fileURLToPath(new URL("../..", import.meta.url));

const reading = (yes: string[], arrangedBy = ""): FolderReading => ({
  areas: byArea((area) => (yes.includes(area) ? "yes" : "no")),
  arrangedBy,
});

/** Two runs, their names, commits and Folder ids marked so a leak would show. */
const runs: SavedRun[] = [
  {
    run: "v-ARMONE-tune-en-en-s1-RUNA",
    commit: "COMMITAAAA",
    language: "en",
    folders: [
      { id: "FOLDERID-1", name: "Personal & Home", description: "Personal notes and recipes." },
      { id: "FOLDERID-2", name: "Team records", description: "One-to-ones and contracts." },
    ],
    outcomes: [
      { doc: { id: "journal", file: "j.txt" }, readable: true, folder: "FOLDERID-1" },
      { doc: { id: "recipe", file: "r.md" }, readable: true, folder: "FOLDERID-1" },
      { doc: { id: "one-on-one", file: "o.md" }, readable: true, folder: "FOLDERID-2" },
      { doc: { id: "lease", file: "l.docx" }, readable: true, folder: null },
      { doc: { id: "receipt-scan", file: "s.pdf" }, readable: false, folder: null },
    ],
  },
  {
    run: "v-ARMTWO-tune-en-en-s1-RUNB",
    commit: "COMMITBBBB",
    language: "en",
    folders: [
      { id: "FOLDERID-3", name: "Personal & Home", description: "Personal notes and recipes." },
      { id: "FOLDERID-4", name: "Contracts", description: "Leases." },
    ],
    outcomes: [
      { doc: { id: "journal", file: "j.txt" }, readable: true, folder: "FOLDERID-3" },
      { doc: { id: "recipe", file: "r.md" }, readable: true, folder: null },
      { doc: { id: "one-on-one", file: "o.md" }, readable: true, folder: null },
      { doc: { id: "lease", file: "l.docx" }, readable: true, folder: "FOLDERID-4" },
      { doc: { id: "receipt-scan", file: "s.pdf" }, readable: false, folder: null },
    ],
  },
];

const areas = new Map<string, DocumentAreas>([
  ["journal", { area: "personal" }],
  ["recipe", { area: "personal" }],
  ["one-on-one", { area: "meetings" }],
  ["lease", { area: "contracts" }],
  ["receipt-scan", { area: "finance" }],
]);

const LEAKS = ["ARMONE", "ARMTWO", "RUNA", "RUNB", "COMMIT", "FOLDERID", "tune", "v-"];

describe("the blind items and the key", () => {
  test("number each Folder once by its text, and hold nothing of its run", () => {
    const { items, key } = folderItems(runs, 2737);
    expect(items).toHaveLength(3);
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual([
        "description",
        "half",
        "language",
        "name",
        "number",
      ]);
    expect(JSON.stringify(items)).not.toMatch(new RegExp(LEAKS.join("|")));
    const personal = items.find((item) => item.name === "Personal & Home");
    expect(personal && key.folders[personal.number]).toEqual([
      { run: "v-ARMONE-tune-en-en-s1-RUNA", commit: "COMMITAAAA", folder: "FOLDERID-1" },
      { run: "v-ARMTWO-tune-en-en-s1-RUNB", commit: "COMMITBBBB", folder: "FOLDERID-3" },
    ]);
    expect(folderItems(runs, 2737).items).toEqual(items);
    expect(items.filter((item) => item.half === 1)).toHaveLength(1);
  });

  test("the same seed gives the same order", () => {
    const numbers = Array.from({ length: 10 }, (_, at) => at);
    expect(shuffled(numbers, 2737)).toEqual(shuffled(numbers, 2737));
    expect(shuffled(numbers, 2737).sort((a, b) => a - b)).toEqual(numbers);
    expect(shuffled(numbers, 2737)).not.toEqual(shuffled(numbers, 2738));
  });

  test("a key may not go where the repository would keep it", async () => {
    expect(() => checkKeyPath(join(root, "eval/organize/key.json"))).toThrow("in the repository");
    expect(() => checkKeyPath(join(root, "..secret.json"))).toThrow("in the repository");
    expect(() => checkKeyPath(join(root, "eval/results/key.json"))).not.toThrow();
    expect(() => checkKeyPath(join(tmpdir(), "key.json"))).not.toThrow();
  });
});

describe("the second reader's blind Folder sheet", () => {
  const { items } = folderItems(runs, 2737);

  test("holds the question, and each Folder's number, language, name and description only", () => {
    const sheet = folderSheet(items);
    expect(sheet).not.toMatch(new RegExp(LEAKS.join("|")));
    const blocks = sheet.split(/^### /m).slice(1);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
        "Language",
        "Name",
        "Description",
        ...AREAS.map((area) => `- ${area}`),
        "- arranged by",
      ]);
    }
    expect(sheet).toContain("A Folder whose name says nothing of what it holds");
  });

  test("reads back filled in, and is refused with an area left blank", () => {
    const teamNumber = items.find((item) => item.name === "Team records")?.number;
    const fill = (text: string) =>
      text
        .split(/^### /m)
        .map((block) => {
          const answered = block.replace(/^- (\w+):$/gm, "- $1: no");
          return block.startsWith(`${teamNumber}\n`)
            ? answered.replace("- arranged by:", "- arranged by: a team")
            : answered.replace("- personal: no", "- personal: yes");
        })
        .join("### ");
    const readings = readFolderSheet(fill(folderSheet(items)), items);
    const team = items.find((item) => item.name === "Team records");
    expect(team && readings.get(team.number)).toEqual(reading([], "a team"));
    const home = items.find((item) => item.name === "Personal & Home");
    expect(home && readings.get(home.number)).toEqual(reading(["personal"]));
    expect(() => readFolderSheet(folderSheet(items), items)).toThrow("isn't filled in");
  });
});

describe("a join of the readings", () => {
  const { items, key } = folderItems(runs, 2737);
  const verdict = (number: string) => {
    const name = items.find((item) => item.number === number)?.name;
    return name === "Personal & Home"
      ? reading(["personal"])
      : name === "Contracts"
        ? reading(["contracts"])
        : reading([], "a team");
  };
  const model = new Map(
    items.map((item) => [item.number, { ...verdict(item.number), unsure: [] }]),
  );

  test("reads each run's plan by the key, with the scans on their own line", () => {
    const plans = plansOf(runs, key, model, areas);
    const read = plans.map((plan) => readPlan(plan.documents, plan.folders));
    expect(read.map((each) => each.counts)).toEqual([
      { right: 2, wrong: 0, rightlyLeftOut: 0, missed: 0, waiting: 2 },
      { right: 2, wrong: 0, rightlyLeftOut: 1, missed: 1, waiting: 0 },
    ]);
    expect(read.map((each) => each.scans)).toEqual([
      { count: 1, filed: 0 },
      { count: 1, filed: 0 },
    ]);
    expect(() => plansOf(runs, key, model, new Map())).toThrow("has no areas written");
  });

  test("asks per-Document questions blind, and reads the answers back into the plans", () => {
    const texts = new Map([
      ["one-on-one", { name: "One-to-one", text: "Notes from a one-to-one." }],
      ["lease", { name: "Lease", text: "This tenancy agreement" }],
    ]);
    const { items: asked, key: askKey } = answerItems([plansOf(runs, key, model, areas)], texts, 7);
    expect(asked).toHaveLength(2);
    expect(JSON.stringify(asked)).not.toMatch(new RegExp(LEAKS.join("|")));
    for (const item of asked)
      expect(Object.keys(item).sort()).toEqual(["document", "folder", "language", "number"]);
    const yesFor = Object.fromEntries(
      asked.map((item) => [item.number, item.document.name === "One-to-one"]),
    );
    const answers = lookHereOf(yesFor, askKey);
    const plan = plansOf(runs, key, model, areas)[0];
    if (!plan) throw new Error("No plan.");
    expect(readPlan(plan.documents, plan.folders, answers.get(plan.run.run)).counts).toEqual({
      right: 3,
      wrong: 0,
      rightlyLeftOut: 1,
      missed: 0,
      waiting: 0,
    });
  });

  test("a Folder one reading calls part and the other yes has its Documents asked", () => {
    const contracts = items.find((item) => item.name === "Contracts");
    if (!contracts) throw new Error("No Contracts Folder.");
    const person = new Map(model);
    person.set(contracts.number, {
      areas: byArea((area) => (area === "contracts" ? "part" : "no")),
      arrangedBy: "",
      unsure: [],
    });
    const texts = new Map([
      ["one-on-one", { name: "One-to-one", text: "Notes from a one-to-one." }],
      ["lease", { name: "Lease", text: "This tenancy agreement" }],
    ]);
    const { items: asked, key: askKey } = answerItems(
      [plansOf(runs, key, model, areas), plansOf(runs, key, person, areas)],
      texts,
      7,
    );
    expect(asked.map((item) => `${item.document.name} in ${item.folder.name}`).sort()).toEqual([
      "Lease in Contracts",
      "Lease in Team records",
      "One-to-one in Team records",
    ]);
    const answers = lookHereOf(
      Object.fromEntries(asked.map((item) => [item.number, item.document.name === "Lease"])),
      askKey,
    );
    const second = plansOf(runs, key, person, areas)[1];
    if (!second) throw new Error("No second plan.");
    expect(readPlan(second.documents, second.folders, answers.get(second.run.run)).counts).toEqual({
      right: 2,
      wrong: 0,
      rightlyLeftOut: 1,
      missed: 1,
      waiting: 0,
    });
  });

  test("a join with a Document still waiting in either reading is refused, and prints its bars once none waits", () => {
    const team = items.find((item) => item.name === "Team records");
    if (!team) throw new Error("No Team records Folder.");
    const person = new Map(model);
    person.set(team.number, { ...reading([]), unsure: [] });
    const read = (verdicts: typeof model, lookHere?: Map<string, Map<string, boolean>>) =>
      plansOf(runs, key, verdicts, areas).map((plan) => ({
        run: plan.run,
        reading: readPlan(plan.documents, plan.folders, lookHere?.get(plan.run.run)),
      }));
    expect(() =>
      joinReport({ items, model, person, byModel: read(model), byPerson: read(person) }),
    ).toThrow("2 Documents wait in the model's reading and 0 in the second reader's");
    const answered = new Map([
      [
        "v-ARMONE-tune-en-en-s1-RUNA",
        new Map([
          ["one-on-one FOLDERID-2", true],
          ["lease FOLDERID-2", false],
        ]),
      ],
    ]);
    const lines = joinReport({
      items,
      model,
      person,
      byModel: read(model, answered),
      byPerson: read(person, answered),
      answers: { model: { "001": true, "002": false }, person: { "001": true, "002": true } },
    });
    expect(lines.join("\n")).toContain("en: Documents the same, 7/8 (87.5%, bar 95%): misses");
    expect(lines.join("\n")).toContain(
      "Per-Document answers the same: 1/2 (50.0%, bar 90%): misses",
    );
  });

  test("compares the two readings by Folder, by Document and by those either calls wrong", () => {
    const person = new Map(model);
    const contracts = items.find((item) => item.name === "Contracts");
    if (!contracts) throw new Error("No Contracts Folder.");
    person.set(contracts.number, { ...reading([]), unsure: [] });
    expect(folderAgreement(items, model, person)).toEqual({ compared: 3, same: 2 });
    const read = (verdicts: typeof model) =>
      plansOf(runs, key, verdicts, areas).map((plan) => ({
        run: plan.run,
        reading: readPlan(plan.documents, plan.folders),
      }));
    const tally = documentAgreement(read(model), read(person)).get("en");
    expect(tally).toEqual({ all: { compared: 8, same: 7 }, wrong: { compared: 1, same: 0 } });
  });

  test("checks the per-Document answers and the Documents' areas against the second reader's", () => {
    expect(answerAgreement({ "1": true, "2": false, "3": true }, { "1": true, "2": true })).toEqual(
      {
        compared: 2,
        same: 1,
      },
    );
    expect(() => answerAgreement({}, { "1": true })).toThrow("no answer 1");
    const documents = ["a", "b", "c", "d", "scan"].map((id) => ({
      id,
      scanned: id === "scan",
      label: id === "scan" ? "finance" : null,
    }));
    expect(
      areasDiffering(
        new Map<string, DocumentAreas>([
          ["a", { area: "reports", second: "meetings" }],
          ["b", { area: "finance" }],
          ["c", { area: null }],
          ["d", { area: "meetings", second: "reports" }],
        ]),
        new Map<string, DocumentAreas>([
          ["a", { area: "reports" }],
          ["b", { area: "finance" }],
          ["c", { area: "personal" }],
          ["d", { area: "reports", second: "meetings" }],
          ["scan", { area: "finance" }],
        ]),
        documents,
      ),
    ).toEqual({ compared: 4, differ: ["a", "c"] });
  });

  test("checks the readings and answers it reads from files", () => {
    const yes = { areas: byArea((area) => (area === "personal" ? "yes" : "no")), arrangedBy: "" };
    expect(
      verdictsOf({ folders: { "001": { reads: [yes, yes, reading([])] } } }).get("001"),
    ).toEqual({ ...reading(["personal"]), unsure: [] });
    expect(() =>
      verdictsOf({ folders: { "001": { areas: { research: "yes" }, arrangedBy: "" } } }),
    ).toThrow("Folder 001: The reply doesn't say whether the Folder covers reports.");
    expect(() =>
      lookHereOf(
        { "001": "no" },
        { seed: 7, answers: { "001": { run: "r", document: "d", folder: "f" } } },
      ),
    ).toThrow("Answer 001 is neither true nor false.");
  });

  test("compares the model's areas on the 37 tuning Documents with text; a scan has its label's", async () => {
    const person = await readAreas(root);
    const documents = (await readSet(root)).documents
      .filter((each) => each.split === "tune")
      .map((each) => ({ id: each.id, scanned: each.scanned === true, label: each.folder }));
    const model = new Map(person);
    model.set("en-journal", { area: "finance" });
    model.set("zh-lease", { area: "reports" });
    model.set("en-paper-scan", { area: "personal" });
    const { compared, differ } = areasDiffering(model, person, documents);
    expect(compared).toBe(37);
    expect(differ).toEqual(["zh-lease", "en-journal"]);
    expect(differ.length <= BARS.areasDiffer).toBe(true);
    const written = areasWithScans(model, documents);
    expect(written.size).toBe(40);
    expect(written.get("en-paper-scan")).toEqual({ area: "research" });
    expect(written.get("en-receipt-scan")).toEqual({ area: "finance" });
    expect(written.get("zh-vat-invoice-scan")).toEqual({ area: "finance" });
    expect(written.get("en-journal")).toEqual({ area: "finance" });
  });
});

describe("the per-Document answers' blind sheet", () => {
  const item = (at: number): AnswerItem => ({
    number: String(at).padStart(3, "0"),
    language: "en",
    folder: { name: "Team records", description: "People and teams." },
    document: { name: `Document ${at}`, text: "Its first words." },
  });

  test("holds all the answers up to the sample's size, and a seeded sample of it beyond", () => {
    const few = Array.from({ length: 40 }, (_, at) => item(at + 1));
    expect(ANSWER_SAMPLE).toBe(60);
    expect(answerSample(few, 2737)).toHaveLength(40);
    const many = Array.from({ length: 75 }, (_, at) => item(at + 1));
    const sample = answerSample(many, 2737);
    expect(sample).toHaveLength(60);
    expect(answerSample(many, 2737)).toEqual(sample);
    expect(sample.map((each) => each.number)).toEqual(
      [...sample.map((each) => each.number)].sort(),
    );
  });

  test("shows one Folder and one Document an entry and reads back a yes or a no", () => {
    const items = [item(1), item(2)];
    const sheet = answersSheet(items);
    const block = sheet.split(/^### /m)[1] ?? "";
    expect(
      block
        .split("\n")
        .filter(Boolean)
        .slice(1)
        .map((line) => line.split(":")[0]),
    ).toEqual(["Language", "Folder", "Description", "Document", "Beginning", "- look here"]);
    const filled = sheet
      .replace("- look here:", "- look here: yes")
      .replace("- look here:\n", "- look here: no\n");
    expect(readAnswersSheet(filled, items)).toEqual(
      new Map([
        ["001", true],
        ["002", false],
      ]),
    );
    expect(() => readAnswersSheet(sheet, items)).toThrow("isn't filled in");
  });
});

describe("a file joined only once committed", () => {
  test("is refused untracked or changed, and gives its commit once committed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "incarnamind-committed-"));
    onTestFinished(() => rm(repo, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { encoding: "utf8" },
      ).trim();
    git("init", "-q");
    const file = join(repo, "readings.json");
    await writeFile(file, "{}\n");
    expect(() => committedAt(file)).toThrow("must be committed");
    git("add", "readings.json");
    git("commit", "-q", "-m", "Readings");
    expect(committedAt(file)).toBe(git("rev-parse", "HEAD"));
    await writeFile(file, '{"changed": true}\n');
    expect(() => committedAt(file)).toThrow("must be committed");
  });
});
