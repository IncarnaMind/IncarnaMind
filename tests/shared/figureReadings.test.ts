import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { type FigureContext, figureContextOf, readFigures } from "../../src/shared/figures";

/**
 * The reader reads every text of a corpus as it did before its run of digit groups was read in one
 * pass (#2510): each call the figure tests made, the text fixtures in Passage-sized paragraphs, and
 * seeded runs of digit groups with every separator. The readings are kept as digests, recorded from
 * the reader before that change. A change that means to read differently records them again with
 * `INCARNAMIND_RECORD_READINGS=1 npx vitest run tests/shared/figureReadings.test.ts`, then
 * `npx biome format --write tests/fixtures/figures/readings.json`, and lists each changed reading.
 */
const FIXTURES = join(__dirname, "../fixtures");
const READINGS = join(FIXTURES, "figures/readings.json");
const TEXT_FILES = new Set([
  ".txt",
  ".md",
  ".csv",
  ".html",
  ".htm",
  ".vtt",
  ".bib",
  ".xml",
  ".json",
  ".jsonl",
]);
const MAY_HOLD_FIGURE = /[\d〇零一二三四五六七八九十两百千万亿]/;

type Input = [text: string, context: FigureContext];

interface Readings {
  tests: string[];
  runs: string[];
  /** Each fixture by its path: its content's digest, then a reading per input. */
  fixtures: Record<string, { content: string; readings: string[] }>;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url").slice(0, 10);
const readingOf = ([text, context]: Input) => digest(JSON.stringify(readFigures(text, context)));

function testInputs(): Input[] {
  const zipped = readFileSync(join(FIXTURES, "figures/test-inputs.json.gz"));
  return JSON.parse(gunzipSync(zipped).toString("utf8")) as Input[];
}

function seededRuns(): Input[] {
  let seed = 2510;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const separators = [",", ".", "'", " ", " "];
  const leads = ["", "", "$", "(", "-", "约", "about ", "| "];
  const tails = ["", "", ")", "%", " million", "亿元", " |", "\t7"];
  const contexts: FigureContext[] = [
    { language: "en" },
    { language: "de" },
    { language: "fr" },
    { language: "zh-CN" },
    { separators: { decimal: ",", group: " " } },
  ];
  const inputs: Input[] = [];
  for (let index = 0; index < 1500; index++) {
    const count = 1 + Math.floor(random() * 9);
    let run = String(Math.floor(random() * 1000)).padStart(pick([1, 1, 2, 3]), "0");
    for (let each = 0; each < count; each++) {
      const digits = pick([1, 2, 3, 3, 3, 4]);
      run += pick(separators) + String(Math.floor(random() * 10 ** digits)).padStart(digits, "0");
    }
    const text = `${pick(leads)}${run}${pick(tails)}`;
    inputs.push([text, {}], [text, pick(contexts)]);
  }
  return inputs;
}

function textFixtures(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return path === join(FIXTURES, "figures") ? [] : textFixtures(path);
      return TEXT_FILES.has(extname(name)) ? [path] : [];
    });
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

function parsedStrings(json: string): string[] {
  try {
    return stringsIn(JSON.parse(json));
  } catch {
    return [json];
  }
}

/** A fixture's text in Passage-sized paragraphs, each read alone and with its own context. */
function fixtureInputs(raw: string, path: string): Input[] {
  const texts =
    extname(path) === ".json"
      ? parsedStrings(raw)
      : extname(path) === ".jsonl"
        ? raw.split("\n").filter(Boolean).flatMap(parsedStrings)
        : [raw];
  const inputs: Input[] = [];
  for (const text of texts) {
    for (const part of text.split(/\n\s*\n/)) {
      for (let at = 0; at < part.length; at += 4000) {
        const paragraph = part.slice(at, at + 4000);
        if (MAY_HOLD_FIGURE.test(paragraph))
          inputs.push([paragraph, {}], [paragraph, figureContextOf(paragraph)]);
      }
    }
  }
  return inputs;
}

function readAll(): Readings {
  const fixtures: Readings["fixtures"] = {};
  for (const path of textFixtures(FIXTURES)) {
    const raw = readFileSync(path, "utf8");
    fixtures[relative(FIXTURES, path)] = {
      content: digest(raw),
      readings: fixtureInputs(raw, path).map(readingOf),
    };
  }
  return { tests: testInputs().map(readingOf), runs: seededRuns().map(readingOf), fixtures };
}

test("every text of the corpus reads as it did before the one-pass reading", () => {
  if (process.env.INCARNAMIND_RECORD_READINGS === "1") {
    writeFileSync(READINGS, `${JSON.stringify(readAll(), null, 1)}\n`);
    return;
  }
  const kept = JSON.parse(readFileSync(READINGS, "utf8")) as Readings;
  const changed: string[] = [];
  const compare = (inputs: readonly Input[], readings: readonly string[], where: string) => {
    expect(inputs).toHaveLength(readings.length);
    inputs.forEach((input, index) => {
      if (readingOf(input) === readings[index]) return;
      const figures = readFigures(...input).map((figure) => figure.chars);
      changed.push(
        `${where} ${JSON.stringify(input).slice(0, 160)} now reads ${JSON.stringify(figures)}`,
      );
    });
  };
  compare(testInputs(), kept.tests, "test input");
  compare(seededRuns(), kept.runs, "seeded run");
  let fixtures = 0;
  for (const [path, { content, readings }] of Object.entries(kept.fixtures)) {
    const file = join(FIXTURES, path);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // A fixture changed since is another text: only the texts read before are compared.
    if (digest(raw) !== content) continue;
    compare(fixtureInputs(raw, file), readings, path);
    fixtures++;
  }
  expect(changed).toEqual([]);
  expect(kept.tests).toHaveLength(4851);
  expect(kept.runs).toHaveLength(3000);
  expect(fixtures).toBeGreaterThan(50);
});
