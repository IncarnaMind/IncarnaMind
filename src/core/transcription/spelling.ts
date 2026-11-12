/**
 * A told name as the Meeting writes it (#1031): where a line holds English words written as a
 * name that sound the same as a told name spelled another way (Katherine for Catherine), they are
 * written as the told name. Only the same rough sound of the spelling counts (./sounds), never a
 * like one, which is as often another person. Where two told names sound the same, the sound
 * can't say which was said, so neither is written. A name with a Chinese character is never
 * written this way: characters read the same are everyday words as often as names (高新 for 高欣).
 */
import { fold, namesAndParts, toldKeys } from "./context";
import { latinSound } from "./sounds";

const HAN = /\p{Script=Han}/u;
const WORD = /(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;
/** What stands between the words of one name as it was heard: "Mary-Ann", "O'Neil", "J. Marsh". */
const BETWEEN = /^[\s.'’-]*$/u;
/** What a sentence's first word comes after: its capital says nothing ("Fill in the form", told Phil). */
const OPENS = /(?:^|[.!?…。！？:："“(（\n])\s*$/u;
/** A name may be heard as this many more words than it is written in. */
const MORE_WORDS = 2;

const writtenAsName = (word: string) => /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);

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
  const soundOf = (name: string) => (HAN.test(name) ? "" : latinSound(name));
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
}

/** The runs of words written as names, by their sound, for the sounds a told name has. */
function spansOf(text: string, told: Told): Map<string, Span[]> {
  const found = [...text.matchAll(WORD)].map((match) => ({ word: match[0], at: match.index }));
  const spans = new Map<string, Span[]>();
  for (const [start, first] of found.entries()) {
    const heard: string[] = [];
    let until = first.at;
    for (const each of found.slice(start, start + told.longest)) {
      if (!writtenAsName(each.word)) break;
      if (heard.length > 0 && !BETWEEN.test(text.slice(until, each.at))) break;
      heard.push(each.word);
      until = each.at + each.word.length;
      const sound = latinSound(heard.join(" "));
      if (!told.sounds.has(sound)) continue;
      const span = { from: first.at, until, heard: [...heard] };
      spans.set(sound, [...(spans.get(sound) ?? []), span]);
    }
  }
  return spans;
}

/** `text` with the words that sound the same as a told name written as the name. */
export function inToldSpelling(text: string, words: readonly string[]): string {
  const told = toldOf(words);
  if (told.sounds.size === 0) return text;
  const spans = spansOf(text, told);
  if (spans.size === 0) return text;

  const taken = new Uint8Array(text.length);
  const free = (from: number, until: number) => !taken.subarray(from, until).includes(1);
  const lower = fold(text);
  const swaps: { from: number; until: number; name: string }[] = [];
  for (const { name, sound, parts, longest } of told.names) {
    const key = fold(name);
    // A told name already written keeps its place, whatever its case.
    if (key.length === name.length && lower.length === text.length) {
      for (let at = lower.indexOf(key); at !== -1; at = lower.indexOf(key, at + 1)) {
        if (free(at, at + key.length)) taken.fill(1, at, at + key.length);
      }
    }
    for (const { from, until, heard } of spans.get(sound) ?? []) {
      if (heard.length > longest || text.slice(from, until) === name || !free(from, until)) {
        continue;
      }
      // Another told name, or part of one (Sara when Sarah is told too), is that name.
      if (heard.some((word) => told.keys.has(fold(word)) && !parts.has(fold(word)))) continue;
      if (heard.length === 1 && OPENS.test(text.slice(0, from))) continue;
      taken.fill(1, from, until);
      swaps.push({ from, until, name });
    }
  }
  let out = text;
  for (const swap of swaps.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, swap.from) + swap.name + out.slice(swap.until);
  }
  return out;
}
