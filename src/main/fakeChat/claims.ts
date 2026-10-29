import { CLAIM_CHECK_INSTRUCTIONS } from "../../core/answers/claimedChanges";
import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** Finding the claims of a verified document (#97) or of the User's own draft (#737), src/core/answers/checks/claims.ts. */
const FIND_CLAIMS =
  /^You sort the sentences of (?:a document someone else wrote|the User's own draft)/m;

/** Whether a request is one to find the claims among numbered sentences. */
export const findsClaims = (options: GenerateOptions): boolean =>
  FIND_CLAIMS.test(systemOf(options.prompt));

/**
 * Each listed sentence's ("[3] …") decision: a claim, but for questions, thanks and opinions.
 * `undecidedLast`: the reply says nothing of the last sentence listed.
 */
export function fakeClaims(
  options: GenerateOptions,
  { undecidedLast = false }: { undecidedLast?: boolean } = {},
): string | null {
  if (!findsClaims(options)) return null;
  const decisions = lastUserText(options.prompt)
    .split("\n")
    .flatMap((line) => {
      const listed = /^\[(\d+)\] (.*)$/.exec(line);
      if (listed?.[1] === undefined || listed[2] === undefined) return [];
      const claim = !/[?？]$|thank|谢|\b(?:we|I) (?:think|believe)\b|我们认为|我认为/i.test(
        listed[2],
      );
      return [[listed[1], claim ? "claim" : "no"]];
    });
  return JSON.stringify(Object.fromEntries(undecidedLast ? decisions.slice(0, -1) : decisions));
}

export const checksChangeClaims = (options: GenerateOptions): boolean =>
  systemOf(options.prompt).includes(CLAIM_CHECK_INSTRUCTIONS);

export function fakeChangeClaims(options: GenerateOptions): string | null {
  if (!checksChangeClaims(options)) return null;
  const reply = /<reply>\n([\s\S]*)\n<\/reply>/.exec(lastUserText(options.prompt))?.[1] ?? "";
  const unmade = /I've added a risks section|我已经把风险部分/.test(reply);
  return JSON.stringify({
    claims: unmade ? [{ sentence: reply, kind: "added", about: "mind", backed: false }] : [],
  });
}
