/** Text as compared: lower case, letters and digits alone. */
export const textKey = (text: string) =>
  text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Its words, and the pairs of Chinese characters in it: text rewritten longer keeps most of them. */
export const tokensOf = (text: string): Set<string> => {
  const words = textKey(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words.flatMap((word) =>
      /\p{Script=Han}/u.test(word)
        ? [...word].slice(1).map((char, index) => `${word[index]}${char}`)
        : [word],
    ),
  );
};
