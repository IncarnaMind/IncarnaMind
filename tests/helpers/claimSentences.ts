export function listedSentences(prompt: string): { number: number; text: string }[] {
  const parsed: unknown = JSON.parse(prompt);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sentences" in parsed) ||
    !Array.isArray(parsed.sentences)
  )
    throw new Error("Invalid synthetic sentence input.");
  const out: { number: number; text: string }[] = [];
  for (const value of parsed.sentences) {
    if (typeof value !== "object" || value === null) throw new Error("Invalid synthetic sentence.");
    const { number, text } = value as Record<string, unknown>;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1 ||
      typeof text !== "string" ||
      out.some((sentence) => sentence.number === number)
    )
      throw new Error("Invalid synthetic sentence identity.");
    out.push({ number, text });
  }
  return out;
}
