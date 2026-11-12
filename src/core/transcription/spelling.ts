/**
 * A told name as the Meeting writes it (#1031): where a line holds English words written as a
 * name that sound the same as a told name spelled another way (Katherine for Catherine), they are
 * written as the told name. Only the same rough sound of the spelling counts (./sounds), never a
 * like one, which is as often another person. Where two told names sound the same, the sound
 * can't say which was said, so neither is written. A name with a Chinese character is never
 * written this way: characters read the same are everyday words as often as names (高新 for 高欣).
 */
import { wordPlaces } from "../../shared/wordTimes";
import { fold, namesAndParts, toldKeys } from "./context";
import { latinSound } from "./sounds";

const WORD_PART = /[\p{Script=Latin}\p{N}]/u;
/**
 * A word in Latin letters and digits: what stands against it in another script is no part of it
 * and stays (Katherineさん).
 */
const WORD = /[\p{Script=Latin}\p{N}]+/gu;
/**
 * What stands between the words of one name as it was heard: "Mary-Ann", "De Shawn". Never a
 * full stop, which ends a sentence as often as an abbreviation, a line break, or more than one
 * mark.
 */
const BETWEEN = /^[ '’-]$/u;
const APOSTROPHE = /^['’]$/u;
/** What a sentence's first word comes after: its capital says nothing ("Fill in the form", told Phil). */
const OPENS = /(?:^|[.!?…。！？:："“(（\n])\s*$/u;
/** A name may be heard as this many more words than it is written in. */
const MORE_WORDS = 2;

const writtenAsName = (word: string) => /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);

/**
 * Whether the rough sound reads every letter and digit of the text. One it leaves out (ø, a
 * digit) says nothing of what was said, and would be lost with the spelling it stands in.
 */
const soundedWhole = (text: string) =>
  !/(?![a-z])[\p{L}\p{N}]/iu.test(text.normalize("NFKD").replace(/\p{M}/gu, ""));

interface ToldName {
  name: string;
  /** Empty for a name nothing heard is written as: it only keeps its own place in a line. */
  sound: string;
  parts: ReadonlySet<string>;
  longest: number;
}

interface Told {
  /** Longest first, so a shorter name never changes part of a longer one. */
  names: readonly ToldName[];
  keys: ReadonlySet<string>;
  sounds: ReadonlySet<string>;
  longest: number;
}

const prepared = new WeakMap<readonly string[], Told>();

function toldOf(words: readonly string[]): Told {
  const known = prepared.get(words);
  if (known) return known;
  const all = [...new Set(namesAndParts(words).map((each) => each.word))]
    .filter((name) => name !== "")
    .sort((a, b) => b.length - a.length);
  const soundOf = (name: string) => (soundedWhole(name) ? latinSound(name) : "");
  const spellings = new Map<string, Set<string>>();
  for (const name of all) {
    const sound = soundOf(name);
    if (sound) spellings.set(sound, (spellings.get(sound) ?? new Set<string>()).add(fold(name)));
  }
  const names = all.map((name): ToldName => {
    const sound = soundOf(name);
    const each = name.split(/\s+/u);
    return {
      name,
      sound: spellings.get(sound)?.size === 1 ? sound : "",
      parts: new Set(each.map(fold)),
      longest: each.length + MORE_WORDS,
    };
  });
  const told: Told = {
    names,
    keys: toldKeys(words),
    sounds: new Set(names.map((each) => each.sound).filter((sound) => sound !== "")),
    longest: Math.max(0, ...names.map((each) => each.longest)),
  };
  prepared.set(words, told);
  return told;
}

interface Span {
  from: number;
  until: number;
  heard: readonly string[];
  /** Where each heard word starts. */
  starts: readonly number[];
}

/** The runs of words written as names, by their sound, for the sounds a told name has. */
function spansOf(text: string, told: Told): Map<string, Span[]> {
  const found = [...text.matchAll(WORD)].map((match) => ({ word: match[0], at: match.index }));
  const spans = new Map<string, Span[]>();
  for (const [start, first] of found.entries()) {
    const heard: string[] = [];
    const starts: number[] = [];
    let until = first.at;
    for (const [more, each] of found.slice(start, start + told.longest).entries()) {
      const next = found[start + more + 1];
      // A capital alone is a name's only where an apostrophe joins it to the rest (the O of
      // O'Neill), and is never a name by itself.
      const joined =
        /^\p{Lu}$/u.test(each.word) &&
        next !== undefined &&
        APOSTROPHE.test(text.slice(each.at + each.word.length, next.at)) &&
        writtenAsName(next.word);
      if (!(joined || writtenAsName(each.word)) || !soundedWhole(each.word)) break;
      if (heard.length > 0 && !BETWEEN.test(text.slice(until, each.at))) break;
      heard.push(each.word);
      starts.push(each.at);
      until = each.at + each.word.length;
      if (joined) continue;
      const sound = latinSound(heard.join(" "));
      if (!told.sounds.has(sound)) continue;
      const span = { from: first.at, until, heard: [...heard], starts: [...starts] };
      spans.set(sound, [...(spans.get(sound) ?? []), span]);
    }
  }
  return spans;
}

type Swap = Pick<Span, "from" | "until" | "starts"> & { name: string };

/** Where `text` holds words that sound the same as a told name, with the name, in the text's order. */
function swapsIn(text: string, words: readonly string[]): Swap[] {
  const told = toldOf(words);
  if (told.sounds.size === 0) return [];
  const spans = spansOf(text, told);
  if (spans.size === 0) return [];

  const taken = new Uint8Array(text.length);
  const free = (from: number, until: number) => !taken.subarray(from, until).includes(1);
  const lower = fold(text);
  const swaps: Swap[] = [];
  for (const { name, sound, parts, longest } of told.names) {
    const key = fold(name);
    // A told name already written keeps its place, whatever its case: as whole words, never as
    // the start of a longer one (Ann in Anni).
    if (key.length === name.length && lower.length === text.length) {
      for (let at = lower.indexOf(key); at !== -1; at = lower.indexOf(key, at + 1)) {
        const until = at + key.length;
        const whole = !WORD_PART.test(text.charAt(at - 1)) && !WORD_PART.test(text.charAt(until));
        if (whole && free(at, until)) taken.fill(1, at, until);
      }
    }
    for (const { from, until, heard, starts } of spans.get(sound) ?? []) {
      if (heard.length > longest || text.slice(from, until) === name || !free(from, until)) {
        continue;
      }
      // Another told name, or part of one (Sara when Sarah is told too), is that name.
      if (heard.some((word) => told.keys.has(fold(word)) && !parts.has(fold(word)))) continue;
      if (heard.length === 1 && OPENS.test(text.slice(0, from))) continue;
      taken.fill(1, from, until);
      swaps.push({ from, until, name, starts });
    }
  }
  return swaps.sort((a, b) => a.from - b.from);
}

/** `text` with the words that sound the same as a told name written as the name. */
export function inToldSpelling(text: string, words: readonly string[]): string {
  let out = text;
  for (const swap of swapsIn(text, words).reverse()) {
    out = out.slice(0, swap.from) + swap.name + out.slice(swap.until);
  }
  return out;
}

/**
 * The transcriber's own words of `text`, in order, each as `inToldSpelling` writes it there, so
 * each is found in the line as written and keeps its time (#138). A word alone can't say this: it
 * opens its own text, and the same spelling may stand twice in a line, written as the name once.
 * The words heard for a told name are the name's, one for one; where the name has more or fewer
 * words than were heard, it stands whole for the first of them and the rest are left out.
 */
export function wordsInToldSpelling(
  text: string,
  heard: readonly string[],
  words: readonly string[],
): string[] {
  const swaps = swapsIn(text, words);
  if (swaps.length === 0) return [...heard];
  return wordPlaces(text, heard).map((at, index) => {
    const swap = swaps.find((each) => each.from <= at && at < each.until);
    if (!swap) return heard[index] ?? "";
    const parts = swap.name.split(/\s+/u);
    if (parts.length !== swap.starts.length) return at === swap.from ? swap.name : "";
    return parts[swap.starts.indexOf(at)] ?? "";
  });
}
