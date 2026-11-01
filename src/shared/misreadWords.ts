/**
 * How a scan's misread number reads (#535): a recognizer writes "o" or "O"
 * for 0, "l", "I" or "i" for 1 and "S" or "s" for 5, so a quote of "7a;45o"
 * may stand for 7450. A word with no digit of its own isn't a number: "with"
 * must never read as 1.
 */

/** The digit a recognizer may write as a letter. */
const DIGIT_READING: Readonly<Record<string, string>> = {
  O: "0",
  o: "0",
  I: "1",
  i: "1",
  l: "1",
  S: "5",
  s: "5",
};

/** The digits a misread word stands for ("7a;45o" is 7450); "" when the word holds no digit. */
export function misreadDigits(word: string): string {
  if (!/\d/u.test(word)) return "";
  return Array.from(word, (char) => (/\d/u.test(char) ? char : (DIGIT_READING[char] ?? ""))).join(
    "",
  );
}

/** The digits of a number a model wrote, as they read ("7,450" is 7450). */
export function numberDigits(number: string): string {
  return number.replace(/\D+/gu, "");
}
