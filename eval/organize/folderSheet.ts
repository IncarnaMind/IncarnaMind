/**
 * The second reader's blind sheets (#2737), written from the blind items and read back:
 *
 *   node --import ./scripts/tsResolve.mjs eval/organize/folderSheet.ts folders --items <folders.json> --out <sheet.md>
 *   node --import ./scripts/tsResolve.mjs eval/organize/folderSheet.ts read-folders --items <folders.json> --sheet <sheet.md> --out <readings.json>
 *   node --import ./scripts/tsResolve.mjs eval/organize/folderSheet.ts answers --items <asks.json> --seed 2737 --out <sheet.md>
 *   node --import ./scripts/tsResolve.mjs eval/organize/folderSheet.ts read-answers --items <asks.json> --seed 2737 --sheet <sheet.md> --out <answers.json>
 *   node --import ./scripts/tsResolve.mjs eval/organize/folderSheet.ts documents --documents <documents.json> --out <list.md>
 *
 * A Folder's entry holds its number, language, name and description, and nothing of its run.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LANGUAGE_NAMES } from "../../src/core/language";
import { AREAS, byArea } from "./lib/areas";
import type { DocumentText } from "./lib/documentTexts";
import {
  type Cover,
  type FolderReading,
  folderQuestion,
  lookHereQuestion,
} from "./lib/folderReader";
import { type AnswerItem, type FolderItem, shuffled } from "./readPlans";

const COVERS: readonly Cover[] = ["yes", "part", "no"];
const ARRANGED = "arranged by";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function folderSheet(items: readonly FolderItem[]): string {
  const head = [
    "# Folders, read blind",
    "",
    "Each Folder below is shown alone, as a reader model will see it. Read it as the question says, in its own language, and after each area write yes, part or no. After “arranged by”, write what the Folder is arranged by when it isn't one of the areas (a client, a team, a year), or leave it empty.",
    "",
    "## The question",
    "",
    folderQuestion("en"),
    "",
    folderQuestion("zh-CN"),
    "",
    "## The Folders",
    "",
  ];
  const blocks = items.map((item) =>
    [
      `### ${item.number}`,
      "",
      `Language: ${LANGUAGE_NAMES[item.language]}`,
      `Name: ${oneLine(item.name)}`,
      `Description: ${oneLine(item.description)}`,
      "",
      ...AREAS.map((area) => `- ${area}:`),
      `- ${ARRANGED}:`,
      "",
    ].join("\n"),
  );
  return [...head, ...blocks].join("\n");
}

/** The sheet's blocks by number, each a map of its "- name: value" lines. */
function blocksOf(text: string) {
  const blocks = new Map<string, Map<string, string>>();
  for (const block of text.split(/^### /m).slice(1)) {
    const [number = "", ...lines] = block.split("\n");
    const fields = new Map<string, string>();
    for (const line of lines) {
      const match = /^- ([^:]+):(.*)$/.exec(line);
      if (match?.[1]) fields.set(match[1].trim(), (match[2] ?? "").trim());
    }
    blocks.set(number.trim(), fields);
  }
  return blocks;
}

/** A filled Folder sheet, refused whole while any Folder or area is left blank or misspelt. */
export function readFolderSheet(text: string, items: readonly FolderItem[]) {
  const blocks = blocksOf(text);
  const problems: string[] = [];
  const readings = new Map<string, FolderReading>();
  for (const item of items) {
    const fields = blocks.get(item.number);
    if (!fields) {
      problems.push(`${item.number}: missing`);
      continue;
    }
    const areas = byArea((area) => {
      const cover = COVERS.find((each) => each === fields.get(area)?.toLowerCase());
      if (!cover) problems.push(`${item.number} ${area}: "${fields.get(area) ?? ""}"`);
      return cover ?? "no";
    });
    const arrangedBy = fields.get(ARRANGED);
    if (arrangedBy === undefined) problems.push(`${item.number} ${ARRANGED}: missing`);
    readings.set(item.number, { areas, arrangedBy: arrangedBy ?? "" });
  }
  if (problems.length)
    throw new Error(`The sheet isn't filled in: ${problems.slice(0, 12).join("; ")}.`);
  return readings;
}

/** How many per-Document answers the second reader reads: all of them up to this many. */
export const ANSWER_SAMPLE = 60;

/** All the answers' items up to `ANSWER_SAMPLE`; past it, a seeded `ANSWER_SAMPLE` of them. */
export function answerSample(items: readonly AnswerItem[], seed: number): AnswerItem[] {
  if (items.length <= ANSWER_SAMPLE) return [...items];
  return shuffled(items, seed)
    .slice(0, ANSWER_SAMPLE)
    .sort((a, b) => a.number.localeCompare(b.number));
}

const LOOK = "look here";

export function answersSheet(items: readonly AnswerItem[]): string {
  const head = [
    "# Per-Document answers, read blind",
    "",
    "Each entry is one Document and one Folder, shown alone. After “look here”, write yes if a person who knows the Document would look for it in this Folder going by its name, and no otherwise.",
    "",
    "## The question",
    "",
    lookHereQuestion("en"),
    "",
    lookHereQuestion("zh-CN"),
    "",
    "## The answers",
    "",
  ];
  const blocks = items.map((item) =>
    [
      `### ${item.number}`,
      "",
      `Language: ${LANGUAGE_NAMES[item.language]}`,
      `Folder: ${oneLine(item.folder.name)}`,
      `Description: ${oneLine(item.folder.description)}`,
      `Document: ${oneLine(item.document.name)}`,
      `Beginning: ${oneLine(item.document.text)}`,
      "",
      `- ${LOOK}:`,
      "",
    ].join("\n"),
  );
  return [...head, ...blocks].join("\n");
}

export function readAnswersSheet(text: string, items: readonly AnswerItem[]) {
  const blocks = blocksOf(text);
  const problems: string[] = [];
  const answers = new Map<string, boolean>();
  for (const item of items) {
    const value = blocks.get(item.number)?.get(LOOK)?.toLowerCase();
    if (value === "yes" || value === "no") answers.set(item.number, value === "yes");
    else problems.push(`${item.number}: "${value ?? "missing"}"`);
  }
  if (problems.length)
    throw new Error(`The sheet isn't filled in: ${problems.slice(0, 12).join("; ")}.`);
  return answers;
}

/** The tuning Documents for the second reader: id, name and the beginning of the text. */
export function documentsList(texts: readonly DocumentText[]) {
  return [
    "# The tuning Documents, as Organize reads them",
    "",
    ...texts.flatMap((each) => [
      `### ${each.id}`,
      "",
      `Name: ${each.name}`,
      "",
      ...(each.scanned
        ? ["(A scan: no text, so a plan never reads it.)"]
        : each.text.split("\n").map((line) => `> ${line}`)),
      "",
    ]),
  ].join("\n");
}

const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;

async function main(command: string | undefined, args: readonly string[]) {
  const option = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2)
    option.set((args[at] ?? "").replace(/^--/, ""), args[at + 1] ?? "");
  const get = (name: string) => {
    const value = option.get(name);
    if (!value) throw new Error(`--${name} is needed.`);
    return value;
  };
  if (command === "folders") {
    const { items } = await readJson<{ items: FolderItem[] }>(get("items"));
    await writeFile(get("out"), folderSheet(items));
    console.log(`${items.length} Folders on the sheet.`);
  } else if (command === "read-folders") {
    const { items } = await readJson<{ items: FolderItem[] }>(get("items"));
    const readings = readFolderSheet(await readFile(get("sheet"), "utf8"), items);
    await writeFile(
      get("out"),
      `${JSON.stringify({ folders: Object.fromEntries(readings) }, null, 2)}\n`,
    );
    console.log(`${readings.size} Folders read.`);
  } else if (command === "answers") {
    const { items } = await readJson<{ items: AnswerItem[] }>(get("items"));
    const sample = answerSample(items, Number(get("seed")));
    await writeFile(get("out"), answersSheet(sample));
    console.log(`${sample.length} of ${items.length} answers on the sheet.`);
  } else if (command === "read-answers") {
    const { items } = await readJson<{ items: AnswerItem[] }>(get("items"));
    const sample = answerSample(items, Number(get("seed")));
    const answers = readAnswersSheet(await readFile(get("sheet"), "utf8"), sample);
    await writeFile(
      get("out"),
      `${JSON.stringify({ answers: Object.fromEntries(answers) }, null, 2)}\n`,
    );
    console.log(`${answers.size} answers read.`);
  } else if (command === "documents") {
    const texts = await readJson<DocumentText[]>(get("documents"));
    await writeFile(get("out"), documentsList(texts));
    console.log(`${texts.length} Documents listed.`);
  } else throw new Error("folderSheet: folders, read-folders, answers, read-answers or documents.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
