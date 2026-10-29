import { CLAIM_CHECK_INSTRUCTIONS } from "../../core/answers/claimedChanges";
import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** Finding the claims of a verified document (#97) or of the User's own draft (#737), src/core/answers/checks/claims.ts. */
const FIND_CLAIMS =
  /^You sort the sentences of (?:a document someone else wrote|the User's own draft)/m;

/** Whether a request is one to find the claims among numbered sentences. */
export const findsClaims = (options: GenerateOptions): boolean =>
  FIND_CLAIMS.test(systemOf(options.prompt));

/** Literal inventories used by keyless UI tests; undecidedLast omits the last listed sentence. */
export function fakeClaims(
  options: GenerateOptions,
  { undecidedLast = false }: { undecidedLast?: boolean } = {},
): string | null {
  if (!findsClaims(options)) return null;
  let input: unknown;
  try {
    input = JSON.parse(lastUserText(options.prompt));
  } catch {
    return null;
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !("sentences" in input) ||
    !Array.isArray(input.sentences)
  )
    return null;
  const sentences: { number: number; parts: { kind: "fact" | "opinion"; text: string }[] }[] = [];
  for (const sentence of input.sentences as unknown[]) {
    if (
      typeof sentence !== "object" ||
      sentence === null ||
      !("number" in sentence) ||
      !("text" in sentence) ||
      typeof sentence.number !== "number" ||
      typeof sentence.text !== "string"
    )
      return null;
    const { number, text } = sentence;
    if (/[?？]$|thank|谢/i.test(text)) {
      sentences.push({ number, parts: [] });
      continue;
    }
    const kind = /\b(?:we|I) (?:think|believe)\b|我们认为|我认为/i.test(text) ? "opinion" : "fact";
    sentences.push({ number, parts: [{ kind, text }] });
  }
  return JSON.stringify({ sentences: undecidedLast ? sentences.slice(0, -1) : sentences });
}

export const checksChangeClaims = (options: GenerateOptions): boolean =>
  systemOf(options.prompt).includes(CLAIM_CHECK_INSTRUCTIONS);

export function fakeChangeClaims(options: GenerateOptions): string | null {
  if (!checksChangeClaims(options)) return null;
  const reply = /<reply>\n([\s\S]*)\n<\/reply>/.exec(lastUserText(options.prompt))?.[1] ?? "";
  const unmade = /I've added a risks section|我已经把风险部分/.test(reply);
  return JSON.stringify({
    claims: unmade ? [{ sentence: reply, kind: "added", backed: false }] : [],
  });
}
