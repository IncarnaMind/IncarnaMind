/**
 * `npm run eval:meetings:words` (eval/meetings/README.md, Words to know): writes words.json, the
 * words each case's transcriber is told in the run with words (#1031), picked from the case's
 * reference by a rule fixed before any run: the terms a general speech model may not know, said
 * at least three times. English: words of at least four letters that aren't in the macOS word list
 * (/usr/share/dict/web2) as they are or as the word they were made from. Chinese: what the word
 * splitter has no word for and cuts into single characters, two to four of them, none of them an
 * everyday word's. Each list then takes four terms of a case in the other
 * language, which are never said in it: told words that aren't said mustn't appear.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalise } from "../transcription/scoring";
import { loadCase, readCases } from "./cache";
import type { CaseDefinition } from "./types";

const OWN = 12;
const DECOYS = 4;
const MIN_COUNT = 3;
const out = join(dirname(fileURLToPath(import.meta.url)), "words.json");

const dictionary = new Set(
  readFileSync("/usr/share/dict/web2", "utf8")
    .split("\n")
    .map((word) => word.toLowerCase()),
);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const HAN = /^\p{Script=Han}$/u;

/** Everyday speech the word list doesn't have. */
const SPOKEN = new Set(["okay", "gonna", "wanna", "gotta", "yeah", "kinda", "sorta", "dunno"]);

/** Whether a word is in the list as it is, or as the word it was made from: plurals and tenses aren't listed. */
const known = (word: string) =>
  SPOKEN.has(word) ||
  [
    word,
    ...["s", "es", "ed", "d", "ing", "er", "ers", "ly"].map((end) => word.slice(0, -end.length)),
  ]
    .concat(word.endsWith("ies") ? [`${word.slice(0, -3)}y`] : [])
    .concat(word.endsWith("ing") ? [`${word.slice(0, -3)}e`] : [])
    .some((form) => form.length >= 3 && dictionary.has(form));

/** Words with an apostrophe are contractions ("you're"), which the list doesn't have either. */
function englishTerms(text: string): string[] {
  return (text.match(/[A-Za-z']+/g) ?? [])
    .filter((word) => !word.includes("'"))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 4 && !known(word));
}

/** Characters of everyday words: a run with one is ordinary speech the splitter cut up. */
const COMMON = new Set(
  "的了是在和与及或我你您他她它们这那哪有没不也就都而被把对于为从到给让向个上下中里会能要可以说来去过着吗呢吧啊呀哦嗯哈呃诶哎很更最还又再已并但就一二三四五六七八九十百千万年月日号点元第每各些啥谁怎么样看想做吃用得地多少大小好对".split(
    "",
  ),
);

function chineseTerms(text: string): string[] {
  const terms: string[] = [];
  let run = "";
  const end = () => {
    // A word ending in 儿 is how it was said in a Beijing accent, not a name.
    if (run.length >= 2 && run.length <= 4 && !run.endsWith("儿")) terms.push(run);
    run = "";
  };
  for (const { segment } of segmenter.segment(normalise(text))) {
    if (HAN.test(segment) && !COMMON.has(segment)) run += segment;
    else end();
  }
  end();
  return terms;
}

function top(terms: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count >= MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, OWN)
    .map(([term]) => term);
}

const asName = (term: string) => term.replace(/^\p{Ll}/u, (first) => first.toUpperCase());

const definitions = await readCases();
const own = new Map<string, string[]>();
for (const definition of definitions) {
  const { reference } = await loadCase(definition);
  const text = reference.segments.map((segment) => segment.text).join(" ");
  const terms =
    definition.language === "en"
      ? englishTerms(text)
      : definition.language === "zh"
        ? chineseTerms(text)
        : [...englishTerms(text), ...chineseTerms(text)];
  own.set(definition.id, top(terms).map(asName));
}

const ofLanguage = (language: CaseDefinition["language"]) =>
  definitions.filter((each) => each.language === language);
const words: Record<string, { said: string[]; notSaid: string[]; told: string[] }> = {};
for (const definition of definitions) {
  const said = own.get(definition.id) ?? [];
  const other = definition.language === "en" ? "zh" : definition.language === "zh" ? "en" : null;
  const pair = other
    ? ofLanguage(other)[ofLanguage(definition.language).indexOf(definition)]
    : undefined;
  const notSaid = pair ? (own.get(pair.id) ?? []).slice(0, DECOYS) : [];
  const told = said.flatMap((word, at) => (notSaid[at] ? [word, notSaid[at]] : [word]));
  words[definition.id] = { said, notSaid, told };
}
writeFileSync(out, `${JSON.stringify({ format: 1, words }, null, 2)}\n`);
console.log(JSON.stringify(words, null, 1));
