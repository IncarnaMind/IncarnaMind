import { CLAIM_CHECK_INSTRUCTIONS } from "../../core/answers/claimedChanges";
import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** Finding the claims of a verified document (#97) or of the User's own draft (#737), src/core/answers/checks/claims.ts. */
const FIND_CLAIMS =
  /^You sort the sentences of (?:a document someone else wrote|the User's own draft)/m;

/** Whether a request is one to find the claims among numbered sentences. */
export const findsClaims = (options: GenerateOptions): boolean =>
  FIND_CLAIMS.test(systemOf(options.prompt));

/** The numbers of the listed sentences ("[3] …") that claim something: all but questions, thanks and opinions. */
export function fakeClaims(options: GenerateOptions): string | null {
  if (!findsClaims(options)) return null;
  const claims = lastUserText(options.prompt)
    .split("\n")
    .flatMap((line) => {
      const listed = /^\[(\d+)\] (.*)$/.exec(line);
      return listed?.[2] === undefined ||
        /[?？]$|thank|谢|\b(?:we|I) (?:think|believe)\b|我们认为|我认为/i.test(listed[2])
        ? []
        : [Number(listed[1])];
    });
  return JSON.stringify({ claims });
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
