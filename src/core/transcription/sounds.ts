/**
 * Whether what the engine heard is a told name misheard (#1031): a told name only mends a word
 * that is that name, never another name or another word. Latin letters are compared by a rough
 * sound of their spelling (ph is f, a doubled letter one); Chinese characters by their pinyin.
 */
import { pinyinOf } from "../../shared/pinyin";

const HAN = /\p{Script=Han}/u;

function latinSound(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/w/g, "v")
    .replace(/([^aeiouh])h/g, "$1")
    .replace(/(.)\1+/g, "$1");
}

/**
 * How alike the heard text sounds to the name, from 0 to 1. A sound the engine dropped costs half
 * of one it heard otherwise or added: a call runs words together ("Priyaman" for Priya Raman), but
 * a different sound is a different name ("Sophie" for Sofia).
 */
export function soundsLike(heard: string, name: string): number {
  const a = latinSound(heard);
  const b = latinSound(name);
  if (b.length === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j * 0.5);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 0.5,
      );
    }
    previous = current;
  }
  return Math.max(0, 1 - (previous[b.length] as number) / b.length);
}

/**
 * How alike a heard Latin name must sound to the told one: "Priyaman" (0.89) is Priya Raman,
 * "Sophie" (0.80) isn't Sofia, nor "Rotherham" (0.86) Rotterdam.
 */
const LATIN_ALIKE = 0.88;

const hanOf = (text: string) => [...text].filter((char) => HAN.test(char));

/**
 * Whether the heard words are the told name misheard. Chinese: as many characters, each read the
 * same (王力 for 王丽): a syllable heard otherwise may be another person (程 for 陈), which the
 * sound alone can't tell from a mishearing. Latin: words written as names, with capitals, that
 * sound like it: a common word ("will") is never made a name ("Will").
 */
export function isNameMisheard(heard: readonly string[], name: string): boolean {
  const text = heard.join(" ");
  const nameHan = hanOf(name);
  if (nameHan.length > 0) {
    const heardHan = hanOf(text);
    return (
      heardHan.length === nameHan.length &&
      heardHan.every((char, at) => pinyinOf(char) === pinyinOf(nameHan[at] as string))
    );
  }
  return (
    heard.length > 0 &&
    heard.every((word) => /^\p{Lu}/u.test(word)) &&
    soundsLike(text, name) >= LATIN_ALIKE
  );
}
