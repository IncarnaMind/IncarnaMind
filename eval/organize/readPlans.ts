/**
 * Reads saved new-User runs by the ruling on #2737, blind to the arm that made them:
 *
 *   node --import ./scripts/tsResolve.mjs eval/organize/readPlans.ts items --runs <dir> --match v- --seed 2737 --out <dir> --key <file>
 *   node --import ./scripts/tsResolve.mjs eval/organize/readPlans.ts asks --runs <dir> --match v- --key <file> --folders <model readings> --person <person readings> --documents <documents.json> --seed 2737 --out <dir> --asks-key <file>
 *   node --import ./scripts/tsResolve.mjs eval/organize/readPlans.ts areas --model <the model's areas> --documents <documents.json> [--out <areas.json>]
 *   node --import ./scripts/tsResolve.mjs eval/organize/readPlans.ts join --runs <dir> --match v- --items <folders.json> --key <file> --folders <model readings> --person <person readings> [--answers <model answers> --asks-key <file> --person-answers <person answers>]
 *
 * `documents.json` comes from the `documents` mode of `npm run eval:organize` (documentTexts.check.ts).
 *
 * `items` numbers every Folder of the runs in a seeded order and writes the map from number to
 * run apart (`--key`), for the person who holds it alone. `join` refuses until the areas, the
 * person's readings and the model's are each committed, so neither reading is made knowing the
 * other or the arms.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Language } from "../../src/core/language";
import {
  AREAS,
  AREAS_FILE,
  areasOf,
  type DocumentAreas,
  isArea,
  parseAreas,
  readAreas,
} from "./lib/areas";
import {
  type FolderReading,
  type FolderVerdict,
  majority,
  parseFolderReading,
} from "./lib/folderReader";
import {
  askKey,
  OUTCOMES,
  type Outcome,
  type PlanReading,
  type ReadDocument,
  type ReadFolder,
  readPlan,
} from "./lib/planReading";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** A saved run as `newUser.check.ts` writes it: only what reading a plan needs. */
export interface SavedRun {
  run: string;
  commit: string;
  language: Language;
  folders: { id: string; name: string; description: string }[];
  outcomes: { doc: { id: string; file: string }; readable: boolean; folder: string | null }[];
}

export async function loadRuns(directory: string, match = ""): Promise<SavedRun[]> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(match))
    .map((entry) => entry.name)
    .sort();
  const runs: SavedRun[] = [];
  for (const name of names) {
    const saved = JSON.parse(await readFile(join(directory, name, "results.json"), "utf8")) as {
      run: { commit: string; language: Language };
      folders: SavedRun["folders"];
      outcomes: SavedRun["outcomes"];
    };
    runs.push({
      run: name,
      commit: saved.run.commit,
      language: saved.run.language,
      folders: saved.folders.map(({ id, name, description }) => ({ id, name, description })),
      outcomes: saved.outcomes.map(({ doc, readable, folder }) => ({
        doc: { id: doc.id, file: doc.file },
        readable,
        folder,
      })),
    });
  }
  return runs;
}

/** A seeded order (mulberry32 and Fisher–Yates): the same seed gives the same order everywhere. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let at = out.length - 1; at > 0; at--) {
    const other = Math.floor(next() * (at + 1));
    const here = out[at];
    const there = out[other];
    if (here === undefined || there === undefined) continue;
    out[at] = there;
    out[other] = here;
  }
  return out;
}

/** One Folder as a reader sees it: no run, arm, commit or Document. */
export interface FolderItem {
  number: string;
  /** The half it is checked in: the question may change once, from half 1's disagreements. */
  half: 1 | 2;
  language: Language;
  name: string;
  description: string;
}

export interface Place {
  run: string;
  commit: string;
  folder: string;
}

export interface FolderKey {
  seed: number;
  folders: Record<string, Place[]>;
}

const numbered = (at: number, count: number) =>
  String(at + 1).padStart(Math.max(3, String(count).length), "0");

/** Every Folder once by its language and exact text, numbered in the seed's order. */
export function folderItems(runs: readonly SavedRun[], seed: number) {
  const byText = new Map<string, { item: Omit<FolderItem, "number" | "half">; places: Place[] }>();
  for (const run of runs)
    for (const folder of run.folders) {
      const text = JSON.stringify([run.language, folder.name, folder.description]);
      const entry = byText.get(text) ?? {
        item: { language: run.language, name: folder.name, description: folder.description },
        places: [],
      };
      entry.places.push({ run: run.run, commit: run.commit, folder: folder.id });
      byText.set(text, entry);
    }
  const order = shuffled([...byText.values()], seed);
  const halves = new Set(
    shuffled(
      order.map((_, at) => at),
      seed + 1,
    ).slice(0, order.length / 2),
  );
  const items: FolderItem[] = order.map((entry, at) => ({
    number: numbered(at, order.length),
    half: halves.has(at) ? 1 : 2,
    ...entry.item,
  }));
  const key: FolderKey = {
    seed,
    folders: Object.fromEntries(
      order.map((entry, at) => [numbered(at, order.length), entry.places]),
    ),
  };
  return { items, key };
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Refuses a key file the repository would track: it goes to its holder alone. */
export function checkKeyPath(file: string) {
  const path = resolve(file);
  const fromRoot = relative(root, path);
  const outside = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  if (outside) return;
  try {
    git(root, ["check-ignore", "-q", path]);
  } catch {
    throw new Error(`The key would be in the repository at ${path}: write it somewhere ignored.`);
  }
}

/** The commit a file was last committed at, refusing one that is untracked or changed since. */
export function committedAt(file: string): string {
  const path = resolve(file);
  const cwd = dirname(path);
  try {
    git(cwd, ["ls-files", "--error-unmatch", basename(path)]);
    git(cwd, ["diff", "--quiet", "HEAD", "--", basename(path)]);
  } catch {
    throw new Error(`${path} must be committed, unchanged, before it is joined.`);
  }
  return git(cwd, ["log", "-1", "--format=%H", "--", basename(path)]);
}

/** A person's or the model's Folder readings, by number. */
export interface FolderReadings {
  version?: Record<string, string>;
  /** A person's one reading, or the model's three `reads`, each checked when read. */
  folders: Record<string, unknown>;
}

const verdictOf = (reading: unknown): FolderVerdict => {
  if (typeof reading === "object" && reading !== null && "reads" in reading) {
    const { reads } = reading;
    if (!Array.isArray(reads)) throw new Error("its reads aren't a list.");
    return majority(reads.map(parseFolderReading));
  }
  return { ...parseFolderReading(reading), unsure: [] };
};

export function verdictsOf(readings: FolderReadings): Map<string, FolderVerdict> {
  return new Map(
    Object.entries(readings.folders).map(([number, reading]) => {
      try {
        return [number, verdictOf(reading)];
      } catch (error) {
        throw new Error(`Folder ${number}: ${error instanceof Error ? error.message : error}`);
      }
    }),
  );
}

/** Each run's plan, its Folders read by `verdicts` through the key. */
export function plansOf(
  runs: readonly SavedRun[],
  key: FolderKey,
  verdicts: ReadonlyMap<string, FolderReading>,
  areas: ReadonlyMap<string, DocumentAreas>,
) {
  const numberOf = new Map<string, string>();
  for (const [number, places] of Object.entries(key.folders))
    for (const place of places) numberOf.set(`${place.run} ${place.folder}`, number);
  return runs.map((run) => {
    const folders: ReadFolder[] = run.folders.map((folder) => {
      const number = numberOf.get(`${run.run} ${folder.id}`);
      const reading = number === undefined ? undefined : verdicts.get(number);
      if (!reading) throw new Error(`No reading for a Folder of ${run.run}.`);
      return { key: folder.id, reading };
    });
    const documents: ReadDocument[] = run.outcomes.map((outcome) => {
      const entry = areas.get(outcome.doc.id);
      if (!entry) throw new Error(`${outcome.doc.id} has no areas written.`);
      return {
        id: outcome.doc.id,
        readable: outcome.readable,
        folder: outcome.folder,
        areas: entry,
      };
    });
    return { run, folders, documents };
  });
}

/** Per-Document questions as blind items, one Document and one Folder each, and their key. */
export interface AnswerItem {
  number: string;
  language: Language;
  folder: { name: string; description: string };
  document: { name: string; text: string };
}

export interface AnswerKey {
  seed: number;
  answers: Record<string, { run: string; document: string; folder: string }>;
}

/**
 * Every Document and Folder that any of the readings leaves waiting, asked once: the model's
 * Folders and the second reader's may differ on "part" (#2737).
 */
export function answerItems(
  readings: readonly ReturnType<typeof plansOf>[],
  texts: ReadonlyMap<string, { name: string; text: string }>,
  seed: number,
) {
  const asked = new Map<string, { run: SavedRun; document: string; folder: string }>();
  for (const plans of readings)
    for (const plan of plans)
      for (const outcome of readPlan(plan.documents, plan.folders).documents)
        for (const folder of outcome.asks)
          asked.set(`${plan.run.run} ${outcome.id} ${folder}`, {
            run: plan.run,
            document: outcome.id,
            folder,
          });
  const order = shuffled([...asked.values()], seed);
  const items: AnswerItem[] = order.map((each, at) => {
    const folder = each.run.folders.find((one) => one.id === each.folder);
    const text = texts.get(each.document);
    if (!folder || !text) throw new Error(`No text for ${each.document} or its Folder.`);
    return {
      number: numbered(at, order.length),
      language: each.run.language,
      folder: { name: folder.name, description: folder.description },
      document: text,
    };
  });
  const key: AnswerKey = {
    seed,
    answers: Object.fromEntries(
      order.map((each, at) => [
        numbered(at, order.length),
        { run: each.run.run, document: each.document, folder: each.folder },
      ]),
    ),
  };
  return { items, key };
}

/** The per-Document answers by run, as `readPlan` takes them. */
export function lookHereOf(answers: Readonly<Record<string, unknown>>, key: AnswerKey) {
  const byRun = new Map<string, Map<string, boolean>>();
  for (const [number, answer] of Object.entries(answers)) {
    if (typeof answer !== "boolean") throw new Error(`Answer ${number} is neither true nor false.`);
    const place = key.answers[number];
    if (!place) throw new Error(`Answer ${number} isn't in the key.`);
    const run = byRun.get(place.run) ?? new Map<string, boolean>();
    run.set(askKey(place.document, place.folder), answer);
    byRun.set(place.run, run);
  }
  return byRun;
}

export interface Agreement {
  compared: number;
  same: number;
}

/** The share the same; nothing compared is no share at all, so no bar can read it as met. */
export const share = ({ compared, same }: Agreement) => (compared ? same / compared : Number.NaN);

/**
 * A per-Document question's estimated cost in dollars: about 600 input and 250 output tokens,
 * thinking included, at Claude Opus 5.5's list price. Written on the issue before any is sent.
 */
export const QUESTION_COST = 0.008;

/** The bars the reader's reading must meet against a person's (#2737). */
export const BARS = { folders: 0.9, documents: 0.95, wrong: 0.9, answers: 0.9, areasDiffer: 2 };

const sameReading = (a: FolderReading, b: FolderReading) =>
  AREAS.every((area) => a.areas[area] === b.areas[area]) &&
  (a.arrangedBy === "") === (b.arrangedBy === "");

export function folderAgreement(
  items: readonly FolderItem[],
  model: ReadonlyMap<string, FolderReading>,
  person: ReadonlyMap<string, FolderReading>,
  half?: 1 | 2,
): Agreement {
  let compared = 0;
  let same = 0;
  for (const item of items) {
    if (half && item.half !== half) continue;
    const a = model.get(item.number);
    const b = person.get(item.number);
    if (!a || !b) throw new Error(`Folder ${item.number} has no reading from both readers.`);
    compared += 1;
    if (sameReading(a, b)) same += 1;
  }
  return { compared, same };
}

/** The model's per-Document answers against the person's, on the person's sample. */
export function answerAgreement(
  model: Readonly<Record<string, boolean>>,
  person: Readonly<Record<string, boolean>>,
): Agreement {
  const numbers = Object.keys(person);
  for (const number of numbers)
    if (model[number] === undefined) throw new Error(`The model has no answer ${number}.`);
  return {
    compared: numbers.length,
    same: numbers.filter((number) => model[number] === person[number]).length,
  };
}

const sameAreas = (a: DocumentAreas, b: DocumentAreas) =>
  areasOf(a).sort().join(" ") === areasOf(b).sort().join(" ");

/** What `areasDiffering` and `areasWithScans` need of a Document. */
export interface AreaDocument {
  id: string;
  scanned: boolean;
  label: string | null;
}

/** The Documents with text whose areas the model writes otherwise than the person did. */
export function areasDiffering(
  model: ReadonlyMap<string, DocumentAreas>,
  person: ReadonlyMap<string, DocumentAreas>,
  documents: readonly AreaDocument[],
) {
  const withText = documents.filter((each) => !each.scanned);
  const differ = withText.flatMap(({ id }) => {
    const mine = model.get(id);
    const theirs = person.get(id);
    if (!mine) throw new Error(`The model wrote no areas for ${id}.`);
    if (!theirs) throw new Error(`No areas are written for ${id}.`);
    return sameAreas(mine, theirs) ? [] : [id];
  });
  return { compared: withText.length, differ };
}

/** The model's areas for the Documents with text, and for a scan, which has none, its label's. */
export function areasWithScans(
  model: ReadonlyMap<string, DocumentAreas>,
  documents: readonly AreaDocument[],
): Map<string, DocumentAreas> {
  return new Map(
    documents.map(({ id, scanned, label }): [string, DocumentAreas] => {
      if (scanned) return [id, { area: isArea(label) ? label : null }];
      const mine = model.get(id);
      if (!mine) throw new Error(`The model wrote no areas for ${id}.`);
      return [id, mine];
    }),
  );
}

/** Each Document's outcome by both readings, by language: all, and those either calls wrong. */
export function documentAgreement(
  model: readonly { run: SavedRun; reading: PlanReading }[],
  person: readonly { run: SavedRun; reading: PlanReading }[],
) {
  const by = new Map<Language, { all: Agreement; wrong: Agreement }>();
  model.forEach((one, at) => {
    const other = person[at];
    if (!other || other.run !== one.run) throw new Error("The two readings read different runs.");
    const tally = by.get(one.run.language) ?? {
      all: { compared: 0, same: 0 },
      wrong: { compared: 0, same: 0 },
    };
    one.reading.documents.forEach((document, index) => {
      const theirs = other.reading.documents[index];
      if (theirs?.id !== document.id) throw new Error("The two readings read different Documents.");
      const same = theirs.outcome === document.outcome;
      tally.all.compared += 1;
      if (same) tally.all.same += 1;
      if (document.outcome === "wrong" || theirs.outcome === "wrong") {
        tally.wrong.compared += 1;
        if (same) tally.wrong.same += 1;
      }
    });
    by.set(one.run.language, tally);
  });
  return by;
}

/** The record's table: each run's counts and the means, by language, arms named from the key. */
export function readingTable(
  read: readonly { run: SavedRun; reading: PlanReading }[],
  armOf: (run: SavedRun) => string,
) {
  const lines: string[] = [];
  for (const language of ["en", "zh-CN"] as const) {
    const runs = read.filter((each) => each.run.language === language);
    if (!runs.length) continue;
    lines.push(
      `### ${language === "en" ? "English" : "Chinese"}`,
      "",
      "| Arm | Run | Right | Wrong | Rightly left out | Missed | Waiting | Scans (filed) |",
      "|---|---|---:|---:|---:|---:|---:|---|",
    );
    const arms = [...new Set(runs.map((each) => armOf(each.run)))];
    for (const arm of arms) {
      const mine = runs.filter((each) => armOf(each.run) === arm);
      mine.forEach((each, at) => {
        const { counts, scans } = each.reading;
        lines.push(
          `| ${arm} | ${at + 1} | ${OUTCOMES.map((outcome) => counts[outcome]).join(" | ")} | ${scans.count} (${scans.filed}) |`,
        );
      });
      const mean = (outcome: Outcome) =>
        (mine.reduce((sum, each) => sum + each.reading.counts[outcome], 0) / mine.length).toFixed(
          1,
        );
      lines.push(`| ${arm} | mean | ${OUTCOMES.map(mean).join(" | ")} | |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface ReadRun {
  run: SavedRun;
  reading: PlanReading;
}

/**
 * The agreements against the bars and each run's counts. The Folder lines compare Folder readings
 * only, so they always print. The Documents and answers bars and the counts wait while any
 * Document waits in either reading, since waiting is neither agreement nor disagreement; the join
 * is then refused if the caller asked for those bars by giving answers.
 */
export function joinReport(input: {
  items: readonly FolderItem[];
  model: ReadonlyMap<string, FolderReading>;
  person: ReadonlyMap<string, FolderReading>;
  byModel: readonly ReadRun[];
  byPerson: readonly ReadRun[];
  answers?: { model: Record<string, boolean>; person: Record<string, boolean> };
}): { lines: string[]; refused: boolean } {
  const empty: string[] = [];
  const verdict = (agreement: Agreement, bar: number, nothing: string) => {
    if (agreement.compared === 0) {
      empty.push(nothing);
      return `nothing to compare (${nothing})`;
    }
    return `${agreement.same}/${agreement.compared} (${(100 * share(agreement)).toFixed(1)}%, bar ${Math.round(100 * bar)}%): ${share(agreement) >= bar ? "meets" : "misses"}`;
  };
  const refusedIfEmpty = (lines: string[], refused: boolean) =>
    empty.length
      ? {
          lines: [...lines, `No bar is read on nothing: ${empty.join("; ")}.`],
          refused: true,
        }
      : { lines, refused };
  const lines: string[] = [];
  for (const half of [1, 2] as const)
    lines.push(
      `Folders, half ${half}, the same areas: ${verdict(folderAgreement(input.items, input.model, input.person, half), BARS.folders, `half ${half} has no Folders`)}.`,
    );
  const waiting = (read: readonly ReadRun[]) =>
    read.reduce((sum, each) => sum + each.reading.counts.waiting, 0);
  const inModel = waiting(input.byModel);
  const inPerson = waiting(input.byPerson);
  if (inModel || inPerson) {
    lines.push(
      `${inModel} Documents wait in the model's reading and ${inPerson} in the second reader's: the Documents and answers bars are not printed.`,
    );
    return refusedIfEmpty(lines, input.answers !== undefined);
  }
  for (const [language, tally] of documentAgreement(input.byModel, input.byPerson))
    lines.push(
      `${language}: Documents the same, ${verdict(tally.all, BARS.documents, `no Documents in ${language}`)}; of those either calls wrong, ${verdict(tally.wrong, BARS.wrong, `neither reading calls a Document wrong in ${language}`)}.`,
    );
  if (input.answers)
    lines.push(
      `Per-Document answers the same: ${verdict(answerAgreement(input.answers.model, input.answers.person), BARS.answers, "the second reader's answers are empty")}.`,
    );
  lines.push(readingTable(input.byModel, (run) => run.commit));
  return refusedIfEmpty(lines, false);
}

function options(args: readonly string[]) {
  const out = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const name = args[at];
    const value = args[at + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error(`Expected --name value at ${name}.`);
    out.set(name.slice(2), value);
  }
  return {
    get: (name: string) => {
      const value = out.get(name);
      if (value === undefined) throw new Error(`--${name} is needed.`);
      return value;
    },
    maybe: (name: string) => out.get(name),
  };
}

const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;
const writeJson = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function main(command: string | undefined, args: readonly string[]) {
  const option = options(args);
  if (command === "items") {
    const runs = await loadRuns(option.get("runs"), option.maybe("match"));
    const seed = Number(option.get("seed"));
    const keyFile = option.get("key");
    checkKeyPath(keyFile);
    const { items, key } = folderItems(runs, seed);
    await writeJson(join(option.get("out"), "folders.json"), { seed, items });
    await writeJson(keyFile, key);
    console.log(
      `${items.length} Folders from ${runs.length} runs; the key is at ${resolve(keyFile)}.`,
    );
    return;
  }
  if (command === "asks") {
    const runs = await loadRuns(option.get("runs"), option.maybe("match"));
    const key = await readJson<FolderKey>(option.get("key"));
    const readings = [option.get("folders"), option.get("person")];
    for (const file of readings) committedAt(file);
    const areas = await readAreas(root);
    const texts = new Map(
      (await readJson<{ id: string; name: string; text: string }[]>(option.get("documents"))).map(
        ({ id, name, text }) => [id, { name, text }],
      ),
    );
    const asksKey = option.get("asks-key");
    checkKeyPath(asksKey);
    const plans = await Promise.all(
      readings.map(async (file) =>
        plansOf(runs, key, verdictsOf(await readJson<FolderReadings>(file)), areas),
      ),
    );
    const { items, key: answers } = answerItems(plans, texts, Number(option.get("seed")));
    await writeJson(join(option.get("out"), "asks.json"), { items });
    await writeJson(asksKey, answers);
    console.log(
      `${items.length} per-Document questions from both readings, about $${(items.length * QUESTION_COST).toFixed(2)} at about $${QUESTION_COST} each; their key is at ${resolve(asksKey)}.`,
    );
    return;
  }
  if (command === "areas") {
    const model = parseAreas(await readJson<unknown>(option.get("model")));
    const documents = await readJson<AreaDocument[]>(option.get("documents"));
    const out = option.maybe("out");
    if (out) {
      await writeJson(out, {
        note: "The model's areas for the Documents with text; a scan has its label's.",
        areas: Object.fromEntries(areasWithScans(model, documents)),
      });
      console.log(`${documents.length} Documents' areas written to ${resolve(out)}.`);
      return;
    }
    const { compared, differ } = areasDiffering(model, await readAreas(root), documents);
    console.log(
      `The model's areas differ from the second reader's on ${differ.length} of the ${compared} with text (at most ${BARS.areasDiffer}): ${differ.length > BARS.areasDiffer ? "below the bar" : "meets the bar"}.`,
    );
    return;
  }
  if (command === "join") {
    const runs = await loadRuns(option.get("runs"), option.maybe("match"));
    const areas = await readAreas(root);
    const answersFile = option.maybe("answers");
    const personAnswersFile = answersFile ? option.get("person-answers") : undefined;
    const committed = [
      `areas ${committedAt(join(root, AREAS_FILE))}`,
      `the person's Folders ${committedAt(option.get("person"))}`,
      `the model's Folders ${committedAt(option.get("folders"))}`,
      ...(answersFile && personAnswersFile
        ? [
            `the person's answers ${committedAt(personAnswersFile)}`,
            `the model's answers ${committedAt(answersFile)}`,
          ]
        : []),
    ];
    const key = await readJson<FolderKey>(option.get("key"));
    const model = verdictsOf(await readJson<FolderReadings>(option.get("folders")));
    const person = verdictsOf(await readJson<FolderReadings>(option.get("person")));
    const modelAnswers = answersFile
      ? (await readJson<{ answers: Record<string, boolean> }>(answersFile)).answers
      : {};
    const answers = answersFile
      ? lookHereOf(modelAnswers, await readJson<AnswerKey>(option.get("asks-key")))
      : new Map<string, Map<string, boolean>>();
    const read = (verdicts: ReadonlyMap<string, FolderReading>) =>
      plansOf(runs, key, verdicts, areas).map((plan) => ({
        run: plan.run,
        reading: readPlan(plan.documents, plan.folders, answers.get(plan.run.run)),
      }));
    const byModel = read(model);
    const byPerson = read(person);
    const items = (await readJson<{ items: FolderItem[] }>(option.get("items"))).items;
    const personAnswers = personAnswersFile
      ? (await readJson<{ answers: Record<string, boolean> }>(personAnswersFile)).answers
      : undefined;
    const report = joinReport({
      items,
      model,
      person,
      byModel,
      byPerson,
      ...(personAnswers ? { answers: { model: modelAnswers, person: personAnswers } } : {}),
    });
    console.log("Read after the fact; decides nothing about #2917's arms.");
    console.log(`Committed: ${committed.join("; ")}.`);
    console.log(report.lines.join("\n"));
    if (report.refused) process.exitCode = 1;
    return;
  }
  throw new Error("readPlans: items, asks, areas or join.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
