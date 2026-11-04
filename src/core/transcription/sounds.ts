/**
 * Whether what the engine heard is a told name misheard (#1031): a told name only mends a word
 * that is that name, never another name or another word. Letters are compared by a rough sound of
 * their spelling (ph is f, a doubled letter one).
 */

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
 * How alike a heard name must sound to the told one, set on the names of the 2026-10-31 walk's
 * call: "Priyaman" (0.89) is Priya Raman, "Sophie" (0.80) isn't Sofia, nor "Rotherham" (0.86)
 * Rotterdam.
 */
const ALIKE = 0.88;

/**
 * Whether the heard words are the told name misheard: words written as names, with capitals, that
 * sound like it, so a common word ("will") is never made a name ("Will"). A Chinese name never
 * is: characters read the same are everyday words as often as names (保洁 for 宝洁, 往里 for
 * 王丽), and a syllable heard otherwise may be another person (程 for 陈).
 */
export function isNameMisheard(heard: readonly string[], name: string): boolean {
  return (
    !HAN.test(name) &&
    heard.length > 0 &&
    heard.every((word) => /^\p{Lu}/u.test(word)) &&
    soundsLike(heard.join(" "), name) >= ALIKE
  );
}
